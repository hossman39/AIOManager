import { DB } from '../server/db.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareManagedFixture, syntheticKey } from './managed-contract.mjs'
import { managedJobContract, prepareJobFixture } from './managed-job-contract.mjs'
import { initializeManagedCrypto } from '../server/managed/crypto.js'
import { migrateManagedSchema } from '../server/managed/schema.js'
import { createManagedJobStore } from '../server/managed/jobs.js'

managedJobContract('SQLite durable jobs', {}, async (t) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db)
})

test('file-backed jobs and before-write snapshots survive a closed and reopened database', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-job-restart-'))
  const connections = []
  t.after(async () => {
    try {
      for (const db of connections) await db.close()
    } finally {
      const target = path.resolve(directory)
      assert.equal(path.dirname(target), path.resolve(tmpdir()))
      assert.ok(path.basename(target).startsWith('aiomanager-job-restart-'))
      await rm(target, { recursive: true, force: true })
    }
  })
  const open = async () => {
    const db = new DB({ env: {}, sqlitePath: path.join(directory, 'aio.db') })
    connections.push(db)
    await db.init()
    return db
  }
  const first = await open()
  const storage = await prepareJobFixture(await prepareManagedFixture(first))
  await storage.enqueue()
  const claim = await storage.jobs.claim()
  await storage.jobs.beginWrite(claim, [])
  await first.close()
  storage.advance(1000)
  const second = await open()
  await migrateManagedSchema(second)
  const crypto = await initializeManagedCrypto(second, { primary: syntheticKey })
  const jobs = createManagedJobStore({ db: second, crypto, now: storage.now, leaseMs: 1000 })
  assert.equal(await jobs.recoverExpired(), 1)
  const resumed = await jobs.claim()
  assert.equal(resumed.id, claim.id)
  assert.equal(resumed.write_intent, 1)
  assert.equal(resumed.error_code, 'OUTCOME_UNKNOWN')
  assert.equal((await second.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 1)
})
