import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createManagedJobStore } from '../server/managed/jobs.js'
import { firstAuth, parsedAccounts } from './managed-contract.mjs'

const before = [
  {
    transportUrl: 'https://addon.invalid/CaseSensitive/Token/manifest.json',
    manifest: { id: 'synthetic', version: '1.0.0', catalogs: [] },
  },
]
const after = [
  { ...before[0], transportUrl: 'https://addon.invalid/CaseSensitive/Another/manifest.json' },
]

export async function prepareJobFixture(storage) {
  const { db, repository, now } = storage
  const report = await repository.stageImport(
    firstAuth,
    parsedAccounts(
      Array.from({ length: 3 }, (_, index) => ({
        email: `queue-${index}@example.invalid`,
        password: 'synthetic-only',
      }))
    ),
    randomUUID()
  )
  const ids = report.accounts.map((account) => account.id)
  await db.run(
    `INSERT INTO managed_groups (id, owner_id, name_enc, draft_enc, created_at, updated_at) VALUES ('group-one', $1, 'synthetic', 'synthetic', 0, 0)`,
    [firstAuth.owner]
  )
  for (const id of ids) {
    await db.run(
      `UPDATE managed_accounts SET state = 'active', provider_key = $1, provider_enc = 'synthetic', group_id = 'group-one' WHERE id = $2`,
      [`synthetic-provider-${id}`, id]
    )
  }
  await db.run('UPDATE managed_metadata SET write_paused = 0')
  await db.run('UPDATE managed_owners SET write_paused = 0')
  const jobs = createManagedJobStore({ ...storage, leaseMs: 1000 })
  const enqueue = (accountId = ids[0], expectedPolicy = 1, cause = 'manual') =>
    jobs.enqueue({ owner: firstAuth.owner, accountId, expectedPolicy, cause })
  const expire = (id = ids[0]) =>
    db.run(
      `UPDATE managed_accounts SET expiry_at = $1, expiry_local = '2026-09-19T12:00', expiry_offset = -240, expiry_timezone = 'America/New_York' WHERE id = $2`,
      [now(), id]
    )
  return { ...storage, jobs, ids, enqueue, expire }
}

export function managedJobContract(prefix, options, fixture) {
  const check = (name, fn) =>
    test(`${prefix}: ${name}`, options, async (t) =>
      fn(await prepareJobFixture(await fixture(t)), t)
    )

  check(
    'enqueues are durable, idempotent, scoped, and reject staged accounts',
    async ({ db, jobs, ids, enqueue }) => {
      const results = await Promise.all(Array.from({ length: 10 }, () => enqueue()))
      assert.equal(new Set(results.map((job) => job.id)).size, 1)
      await assert.rejects(enqueue(ids[0], 2), { code: 'VERSION_CONFLICT' })
      await assert.rejects(
        jobs.enqueue({
          owner: 'other-manager',
          accountId: ids[0],
          expectedPolicy: 1,
          cause: 'manual',
        }),
        { code: 'NOT_FOUND' }
      )
      await db.run("UPDATE managed_accounts SET state = 'staged' WHERE id = $1", [ids[1]])
      await assert.rejects(enqueue(ids[1]), { code: 'INVALID_STATE' })
    }
  )
  check(
    'concurrent claims select a job only once and never run two policies for one account',
    async ({ db, jobs, ids, enqueue }) => {
      await enqueue()
      const claims = await Promise.all(Array.from({ length: 6 }, () => jobs.claim()))
      assert.equal(claims.filter(Boolean).length, 1)
      assert.equal(claims.find(Boolean).attempts, 1)
      await db.run('UPDATE managed_accounts SET policy_version = 2 WHERE id = $1', [ids[0]])
      await enqueue(ids[0], 2)
      assert.equal(await jobs.claim(), null)
    }
  )
  check(
    'expired entitlement is prioritized and supersedes queued active setup at the exact cutoff',
    async ({ db, jobs, enqueue, expire, ids }) => {
      const stale = await enqueue()
      await enqueue(ids[1])
      await expire()
      const expiryJob = await enqueue(ids[0], 1, 'expiry')
      assert.equal(expiryJob.target, 'suspended')
      const first = await jobs.claim()
      assert.equal(first.id, expiryJob.id)
      assert.equal(first.priority, 100)
      await jobs.completeVerified(first, { expected: [], observed: [] })
      const next = await jobs.claim()
      assert.equal(next.account_id, ids[1])
      // Claiming again processes any stale active job without re-enabling it.
      assert.equal(await jobs.claim(), null)
      assert.equal(
        (await db.get('SELECT state FROM managed_jobs WHERE id = $1', [stale.id])).state,
        'superseded'
      )
    }
  )
  check(
    'global and owner pause block claims and prevent new write intents',
    async ({ db, jobs, enqueue }) => {
      await enqueue()
      await db.run('UPDATE managed_metadata SET write_paused = 1')
      assert.equal(await jobs.claim(), null)
      await db.run('UPDATE managed_metadata SET write_paused = 0')
      await db.run('UPDATE managed_owners SET write_paused = 1')
      assert.equal(await jobs.claim(), null)
      await db.run('UPDATE managed_owners SET write_paused = 0')
      const claim = await jobs.claim()
      await db.run('UPDATE managed_metadata SET write_paused = 1')
      await assert.rejects(jobs.beginWrite(claim, before), { code: 'WRITE_PAUSED' })
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 0)
    }
  )
  check(
    'snapshot and intent commit together, are encrypted, and cannot dispatch twice per claim',
    async ({ db, jobs, crypto, enqueue }) => {
      await enqueue()
      const claim = await jobs.claim()
      const { snapshotId } = await jobs.beginWrite(claim, before)
      const snapshot = await db.get('SELECT * FROM managed_snapshots WHERE id = $1', [snapshotId])
      assert.equal(snapshot.attempt, 1)
      assert.ok(!snapshot.collection_enc.includes('Token'))
      assert.deepEqual(
        crypto.open(snapshot.collection_enc, {
          owner: claim.owner_id,
          id: snapshotId,
          purpose: `snapshot:${claim.account_id}`,
        }),
        before
      )
      assert.equal(
        (await db.get('SELECT write_intent FROM managed_jobs WHERE id = $1', [claim.id]))
          .write_intent,
        1
      )
      await assert.rejects(jobs.beginWrite(claim, before), { code: 'INVALID_STATE' })
    }
  )
  check(
    'snapshot persistence failure cannot leave a write intent behind',
    async ({ db, jobs, enqueue }) => {
      await enqueue()
      const claim = await jobs.claim()
      const original = db.statement.bind(db)
      db.statement = (connection, method, sql, params) => {
        if (sql.startsWith('UPDATE managed_jobs SET write_intent'))
          throw new Error('Synthetic intent failure')
        return original(connection, method, sql, params)
      }
      await assert.rejects(jobs.beginWrite(claim, before), /Synthetic intent failure/)
      db.statement = original
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 0)
      assert.equal(
        (await db.get('SELECT write_intent FROM managed_jobs WHERE id = $1', [claim.id]))
          .write_intent,
        0
      )
    }
  )
  check(
    'restart recovery preserves unknown outcome, fences the previous claim, and retains snapshots',
    async (storage) => {
      const { db, jobs, enqueue, advance } = storage
      await enqueue()
      const previous = await jobs.claim()
      await jobs.beginWrite(previous, before)
      advance(1000)
      const restarted = createManagedJobStore({ ...storage, leaseMs: 1000 })
      assert.equal(await restarted.recoverExpired(), 1)
      const next = await restarted.claim()
      assert.equal(next.id, previous.id)
      assert.notEqual(next.lease_token, previous.lease_token)
      assert.equal(next.write_intent, 1)
      assert.equal(next.error_code, 'OUTCOME_UNKNOWN')
      assert.equal(next.attempts, 2)
      await assert.rejects(jobs.completeVerified(previous, { expected: after, observed: after }), {
        code: 'LEASE_LOST',
      })
      await restarted.beginWrite(next, after)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 2)
      assert.equal(
        (await restarted.completeVerified(next, { expected: after, observed: after })).state,
        'verified'
      )
    }
  )
  check(
    'verification compares full configured URLs and order, not only collection length',
    async ({ jobs, enqueue }) => {
      await enqueue()
      const claim = await jobs.claim()
      await assert.rejects(jobs.completeVerified(claim, { expected: before, observed: after }), {
        code: 'INVALID_STATE',
      })
      await assert.rejects(
        jobs.completeVerified(claim, {
          expected: [...before, ...after],
          observed: [...after, ...before],
        }),
        { code: 'INVALID_STATE' }
      )
      assert.equal(
        (await jobs.completeVerified(claim, { expected: before, observed: before })).state,
        'verified'
      )
    }
  )
  check(
    'expiry racing a running install cannot report active setup as current',
    async ({ db, jobs, enqueue, expire, ids }) => {
      await enqueue()
      const installing = await jobs.claim()
      await jobs.beginWrite(installing, before)
      await expire()
      assert.equal(
        (await jobs.completeVerified(installing, { expected: after, observed: after })).state,
        'superseded'
      )
      const account = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [ids[0]])
      assert.equal(account.applied_version, null)
      const disabling = await jobs.claim()
      assert.equal(disabling.target, 'suspended')
      await assert.rejects(jobs.completeVerified(disabling, { expected: after, observed: after }), {
        code: 'INVALID_STATE',
      })
      await jobs.completeVerified(disabling, { expected: [], observed: [] })
      assert.equal(
        (await db.get('SELECT applied_target FROM managed_accounts WHERE id = $1', [ids[0]]))
          .applied_target,
        'suspended'
      )
    }
  )
  check(
    'renewal supersedes a running disable without deleting saved addon preferences',
    async ({ db, jobs, enqueue, expire, ids, crypto }) => {
      const saved = [{ ...before[0], flags: { enabled: false, protected: true } }]
      const context = { owner: firstAuth.owner, id: ids[0], purpose: 'configuration' }
      await db.run('UPDATE managed_accounts SET configuration_enc = $1 WHERE id = $2', [
        crypto.seal(saved, context),
        ids[0],
      ])
      await expire()
      await enqueue()
      const disabling = await jobs.claim()
      await jobs.beginWrite(disabling, before)
      await db.run(
        'UPDATE managed_accounts SET expiry_at = expiry_at + 86400000, suspended_at = NULL, policy_version = 2 WHERE id = $1',
        [ids[0]]
      )
      assert.equal(
        (await jobs.completeVerified(disabling, { expected: [], observed: [] })).state,
        'superseded'
      )
      const renewed = await jobs.claim()
      assert.equal(renewed.target, 'active')
      assert.equal(renewed.policy_version, 2)
      const row = await db.get('SELECT configuration_enc FROM managed_accounts WHERE id = $1', [
        ids[0],
      ])
      assert.deepEqual(crypto.open(row.configuration_enc, context), saved)
    }
  )
  check(
    'policy changes and expiry are rechecked before snapshot or write intent',
    async ({ db, jobs, enqueue, expire }) => {
      await enqueue()
      const claim = await jobs.claim()
      await expire()
      await assert.rejects(jobs.beginWrite(claim, before), { code: 'VERSION_CONFLICT' })
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 0)
    }
  )
  check(
    'suspension remains enforceable without a group; active setup never manufactures emptiness',
    async ({ db, jobs, enqueue, expire, ids }) => {
      await db.run('UPDATE managed_accounts SET group_id = NULL WHERE id = $1', [ids[0]])
      await enqueue()
      const active = await jobs.claim()
      await assert.rejects(jobs.beginWrite(active, before), { code: 'INVALID_STATE' })
      await expire()
      await jobs.retry(active, { code: 'MANIFEST_UNAVAILABLE', dueAt: active.due_at + 1000 })
      const expired = await jobs.claim()
      await jobs.beginWrite(expired, before)
      await jobs.completeVerified(expired, { expected: [], observed: [] })
    }
  )
  check(
    'retry deadlines and redacted failure codes persist; heartbeat cannot resurrect an expired lease',
    async ({ jobs, enqueue, now, advance }) => {
      await enqueue()
      const first = await jobs.claim()
      await assert.rejects(jobs.retry(first, { code: 'password-in-error', dueAt: now() + 100 }), {
        code: 'INVALID_INPUT',
      })
      await jobs.retry(first, { code: 'RATE_LIMITED', dueAt: now() + 100 })
      assert.equal(await jobs.claim(), null)
      advance(100)
      const retry = await jobs.claim()
      assert.equal(retry.error_code, 'RATE_LIMITED')
      advance(500)
      await jobs.heartbeat(retry)
      advance(600)
      assert.equal(await jobs.recoverExpired(), 0)
      advance(400)
      await assert.rejects(jobs.heartbeat(retry), { code: 'LEASE_LOST' })
      assert.equal(await jobs.recoverExpired(), 1)
    }
  )
}
