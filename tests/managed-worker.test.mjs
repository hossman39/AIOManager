import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DB } from '../server/db.js'
import { prepareManagedFixture, syntheticKey } from './managed-contract.mjs'
import { managedWorkerContract, prepareWorkerFixture } from './managed-worker-contract.mjs'
import { initializeManagedCrypto } from '../server/managed/crypto.js'
import { migrateManagedSchema } from '../server/managed/schema.js'
import { createManagedJobStore } from '../server/managed/jobs.js'
import { createManagedWorker } from '../server/managed/worker.js'
import { projectManagedCollection } from '../server/managed/projection.js'

managedWorkerContract('SQLite managed execution', {}, async (t, options) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db, options)
})

test('a request that outlives abort and its lease keeps the runner occupied until it settles', async (t) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  const s = await prepareWorkerFixture(await prepareManagedFixture(db), t)
  let settle
  let notifyAbort
  const aborted = new Promise((resolve) => {
    notifyAbort = resolve
  })
  s.hooks.set = (session, addons, { signal }) =>
    new Promise((resolve) => {
      settle = () => {
        s.remote.set(session.id, addons)
        resolve()
      }
      signal.addEventListener('abort', notifyAbort, { once: true })
    })
  await s.enqueue()
  const worker = s.makeWorker({ requestTimeoutMs: 50 })
  const first = worker.runOnce()
  await aborted
  assert.equal(worker.runOnce(), first)
  assert.equal(s.calls.filter((call) => call.method === 'set').length, 1)
  s.passTime(120_001)
  assert.equal(await s.jobs.recoverExpired(), 1)
  assert.throws(() => s.makeWorker(), { code: 'INVALID_INPUT' })
  settle()
  assert.equal((await first).state, 'lease-lost')
  delete s.hooks.set
  assert.equal((await worker.runOnce()).state, 'verified')
  assert.equal(s.calls.filter((call) => call.method === 'set').length, 1)
  await worker.close()
})

test('file-backed restart recovers the exact encrypted plan after provider acceptance before completion', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-execution-restart-'))
  const connections = []
  t.after(async () => {
    for (const db of connections) await db.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-execution-restart-'))
    await rm(target, { recursive: true, force: true })
  })
  const open = async () => {
    const db = new DB({ env: {}, sqlitePath: path.join(directory, 'aio.db') })
    connections.push(db)
    await db.init()
    return db
  }
  const first = await open()
  const s = await prepareWorkerFixture(await prepareManagedFixture(first), t)
  await s.enqueue()
  const claim = await s.jobs.claim()
  const { policy } = await s.jobs.readExecution(claim)
  const plan = { ...projectManagedCollection({ ...policy, remote: [] }), stamp: policy.stamp }
  await s.jobs.beginWrite(claim, [], plan)
  await s.provider.setCollection(policy.provider, plan.expected, {})
  await first.close()
  s.advance(120_001)
  const second = await open()
  await migrateManagedSchema(second)
  const crypto = await initializeManagedCrypto(second, { primary: syntheticKey })
  const jobs = createManagedJobStore({ db: second, crypto, now: s.now })
  const worker = createManagedWorker({
    db: second,
    jobs,
    provider: s.provider,
    now: s.now,
    requestSpacingMs: 0,
  })
  try {
    assert.equal((await worker.runOnce()).state, 'verified')
    assert.equal(s.calls.filter((call) => call.method === 'set').length, 1)
    assert.equal((await second.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 1)
    const row = await second.get('SELECT * FROM managed_jobs WHERE id = $1', [claim.id])
    assert.equal(row.attempts, 2)
    assert.ok(!row.execution_enc.includes('GroupToken'))
  } finally {
    await worker.close()
  }
})
