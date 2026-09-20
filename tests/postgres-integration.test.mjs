import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { DB } from '../server/db.js'
import { managedStorageContract, prepareManagedFixture } from './managed-contract.mjs'
import { managedJobContract } from './managed-job-contract.mjs'
import { managedMembershipContract } from './managed-membership-contract.mjs'
import { managedGroupsContract } from './managed-groups-contract.mjs'
import { managedPublicationContract } from './managed-publication-contract.mjs'
import { managedWorkerContract } from './managed-worker-contract.mjs'

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
managedPublicationContract('PostgreSQL group publication', options, async (t) =>
  prepareManagedFixture(await fixture(t))
)
managedWorkerContract('PostgreSQL managed execution', options, async (t, fixtureOptions) =>
  prepareManagedFixture(await fixture(t), fixtureOptions)
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
