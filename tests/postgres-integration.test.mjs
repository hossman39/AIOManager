import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { DB } from '../server/db.js'
import { managedStorageContract, prepareManagedFixture } from './managed-contract.mjs'
import { managedJobContract } from './managed-job-contract.mjs'
import { managedMembershipContract } from './managed-membership-contract.mjs'
import { managedGroupsContract } from './managed-groups-contract.mjs'
import { managedGroupMembersContract } from './managed-group-members-contract.mjs'
import { managedPublicationContract } from './managed-publication-contract.mjs'
import { managedWorkerContract } from './managed-worker-contract.mjs'
import { managedRuntimeContract } from './managed-runtime-contract.mjs'
import { integrationContract } from './integration-contract.mjs'
import { acquireWriterOwnership } from '../server/managed/writer-owner.js'
import { writeManagedBackup, restoreManagedBackup } from '../server/managed/backups.js'
import { firstAuth, parsedAccounts, syntheticKey } from './managed-contract.mjs'
import { migrateManagedSchema } from '../server/managed/schema.js'
import { initializeManagedCrypto } from '../server/managed/crypto.js'
import { createManagedRepository } from '../server/managed/repository.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const connectionString = process.env.AIO_TEST_POSTGRES_URL
const options = { skip: !connectionString }

async function fixture(t) {
  const url = new URL(connectionString)
  // Refuse to run integration DDL against an accidentally supplied production DB.
  assert.equal(url.pathname, '/aiomanager_test')
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  const admin = new pg.Client({ connectionString })
  await admin.connect()
  const schema = `aio_test_${randomUUID().replaceAll('-', '')}`
  assert.match(schema, /^aio_test_[a-f0-9]{32}$/)
  await admin.query(`CREATE SCHEMA ${schema}`)
  const db = new DB({
    env: { DATABASE_URL: connectionString, DB_SSL_MODE: 'disable' },
    type: 'postgres',
    poolFactory: (config) => new pg.Pool({ ...config, options: `-c search_path=${schema}` }),
  })
  t.after(async () => {
    try {
      await db.close()
      assert.match(schema, /^aio_test_[a-f0-9]{32}$/)
      await admin.query(`DROP SCHEMA ${schema} CASCADE`)
    } finally {
      await admin.end()
    }
  })
  await db.init()
  await db.exec('CREATE TABLE sample (id TEXT PRIMARY KEY, value INTEGER NOT NULL)')
  return db
}

managedStorageContract('PostgreSQL managed storage', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)
managedJobContract('PostgreSQL durable jobs', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)
managedMembershipContract('PostgreSQL membership', options, async (t, fixtureOptions) =>
  prepareManagedFixture(await fixture(t), fixtureOptions)
)
managedGroupsContract('PostgreSQL group configuration', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)
managedGroupMembersContract('PostgreSQL group members', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)
managedPublicationContract('PostgreSQL group publication', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)
managedWorkerContract('PostgreSQL managed execution', options, async (t, fixtureOptions) =>
  prepareManagedFixture(await fixture(t), fixtureOptions)
)
managedRuntimeContract('PostgreSQL managed lifecycle', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)
integrationContract('PostgreSQL integration access', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)

test(
  'PostgreSQL advisory ownership excludes a second connection and releases on disconnect',
  options,
  async (t) => {
    const first = await fixture(t),
      second = await fixture(t)
    await prepareManagedFixture(first)
    await prepareManagedFixture(second)
    let owner = await acquireWriterOwnership(first)
    try {
      await owner.assertOwned()
      await assert.rejects(acquireWriterOwnership(second), { code: 'WRITER_UNAVAILABLE' })
      await owner.close()
      owner = await acquireWriterOwnership(second)
      await owner.assertOwned()
    } finally {
      await owner.close()
    }
  }
)

test(
  'PostgreSQL encrypted backup restores into a separate empty schema with matching credentials and paused writes',
  options,
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-pg-backup-'))
    try {
      const source = await fixture(t),
        destination = await fixture(t)
      const s = await prepareManagedFixture(source)
      const batch = await s.repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
      await destination.exec(
        'CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, password TEXT, updated_at BIGINT)'
      )
      await migrateManagedSchema(destination)
      const keys = { primary: syntheticKey, candidates: [syntheticKey] }
      await initializeManagedCrypto(destination, keys)
      const backup = await writeManagedBackup({ db: source, keys, directory })
      const result = await restoreManagedBackup({
        db: destination,
        filename: backup.filename,
        secret: syntheticKey,
      })
      const crypto = await initializeManagedCrypto(destination, result.keys)
      const repository = createManagedRepository({
        db: destination,
        crypto,
        legacyKeys: [syntheticKey],
      })
      assert.equal(
        (await repository.getAccount(firstAuth, batch.accounts[0].id)).email,
        'Person@example.invalid'
      )
      assert.equal(
        (await destination.get('SELECT write_paused FROM managed_owners LIMIT 1')).write_paused,
        1
      )
    } finally {
      const target = path.resolve(directory)
      assert.equal(path.dirname(target), path.resolve(tmpdir()))
      assert.ok(path.basename(target).startsWith('aiomanager-pg-backup-'))
      await rm(target, { recursive: true, force: true })
    }
  }
)

test('real PostgreSQL commits and rolls back on its checked-out connection', options, async (t) => {
  const db = await fixture(t)
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO sample VALUES ($1, $2)', ['committed', 1])
  })
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO sample VALUES ($1, $2)', ['rolled-back', 2])
      await tx.run('INSERT INTO sample VALUES ($1, $2)', ['committed', 3])
    }),
    /duplicate key/
  )
  assert.deepEqual(await db.query('SELECT * FROM sample'), [{ id: 'committed', value: 1 }])
  assert.equal(await db.healthCheck(), true)
})

test(
  'real PostgreSQL concurrent transactions keep all 100 serialized row updates',
  options,
  async (t) => {
    const db = await fixture(t)
    await db.run('INSERT INTO sample VALUES ($1, $2)', ['counter', 0])
    await Promise.all(
      Array.from({ length: 100 }, () =>
        db.transaction(async (tx) => {
          const row = await tx.get('SELECT value FROM sample WHERE id = $1 FOR UPDATE', ['counter'])
          await tx.run('UPDATE sample SET value = $1 WHERE id = $2', [row.value + 1, 'counter'])
        })
      )
    )
    assert.equal((await db.get('SELECT value FROM sample WHERE id = $1', ['counter'])).value, 100)
  }
)
