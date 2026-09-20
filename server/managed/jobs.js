import { randomUUID } from 'node:crypto'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'

const causes = new Set([
  'activation',
  'publish',
  'personal',
  'assignment',
  'expiry',
  'renewal',
  'manual',
  'offboard',
  'recovery',
  'restore',
  'safe-mode',
  'autopilot',
])
const retryCodes = new Set([
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
  'INVALID_CREDENTIALS',
  'VERIFICATION_MISMATCH',
  'MANIFEST_UNAVAILABLE',
  'DATA_UNREADABLE',
])
const lockSuffix = (tx) => (tx.type === 'postgres' ? ' FOR UPDATE' : '')
const context = (owner, id, purpose) => ({ owner, id, purpose })

export function currentAccountTarget(account, timestamp) {
  if (account.state === 'staged') return null
  if (account.state === 'offboarding') return 'offboard'
  if (account.state !== 'active') throw new ManagedError('INVALID_STATE')
  if (account.lifetime === 1) {
    if (account.expiry_at !== null) throw new ManagedError('INVALID_STATE')
    return 'active'
  }
  return account.expiry_at !== null && account.expiry_at <= timestamp ? 'suspended' : 'active'
}

/**
 * Internal persistence API, not a provider worker or an HTTP authorization layer.
 * Every method locks accounts before jobs, consistently across both engines.
 * External callers must not be given lease tokens or direct access to this API.
 */
export function createManagedJobStore({ db, crypto, now = Date.now, leaseMs = 120_000 }) {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300_000)
    throw new ManagedError('INVALID_INPUT')

  const clock = () => {
    const timestamp = now()
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new ManagedError('INVALID_INPUT')
    return timestamp
  }
  const matchesPolicy = (job, account, timestamp) =>
    job.policy_version === account.policy_version &&
    job.target === currentAccountTarget(account, timestamp)

  async function enqueueInTransaction(tx, account, cause, timestamp) {
    if (!causes.has(cause)) throw new ManagedError('INVALID_INPUT')
    const target = currentAccountTarget(account, timestamp)
    if (!target) throw new ManagedError('INVALID_STATE')
    const priority =
      target === 'suspended' ? 100 : target === 'offboard' ? 90 : cause === 'renewal' ? 80 : 10
    const id = randomUUID()
    await tx.run(
      `INSERT INTO managed_jobs
      (id, owner_id, account_id, policy_version, target, cause, priority, due_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $8)
      ON CONFLICT (owner_id, account_id, policy_version, target) DO NOTHING`,
      [id, account.owner_id, account.id, account.policy_version, target, cause, priority, timestamp]
    )
    return tx.get(
      'SELECT * FROM managed_jobs WHERE owner_id = $1 AND account_id = $2 AND policy_version = $3 AND target = $4',
      [account.owner_id, account.id, account.policy_version, target]
    )
  }

  async function lockedAccount(tx, owner, accountId) {
    const row = await tx.get(
      `SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2${lockSuffix(tx)}`,
      [owner, accountId]
    )
    if (!row) throw new ManagedError('NOT_FOUND')
    return row
  }

  async function leased(tx, claim, timestamp) {
    const account = await lockedAccount(tx, claim.owner_id, claim.account_id)
    const job = await tx.get(
      `SELECT * FROM managed_jobs WHERE id = $1 AND owner_id = $2 AND account_id = $3${lockSuffix(tx)}`,
      [claim.id, claim.owner_id, claim.account_id]
    )
    if (
      !job ||
      job.state !== 'running' ||
      !equalSecret(job.lease_token, claim.lease_token) ||
      job.lease_until <= timestamp
    )
      throw new ManagedError('LEASE_LOST')
    return { job, account }
  }

  async function ensureUnpaused(tx, owner) {
    const global = await tx.get('SELECT write_paused FROM managed_metadata WHERE id = 1')
    const settings = await tx.get('SELECT write_paused FROM managed_owners WHERE owner_id = $1', [
      owner,
    ])
    if (!global || !settings || global.write_paused !== 0 || settings.write_paused !== 0)
      throw new ManagedError('WRITE_PAUSED')
  }

  async function supersede(tx, job, account, timestamp) {
    await tx.run(
      `UPDATE managed_jobs SET state = 'superseded', lease_token = NULL, lease_until = NULL, updated_at = $1 WHERE id = $2`,
      [timestamp, job.id]
    )
    if (currentAccountTarget(account, timestamp))
      await enqueueInTransaction(tx, account, 'recovery', timestamp)
    return { state: 'superseded' }
  }

  const collectionDigest = (collection, account) => {
    if (!Array.isArray(collection)) throw new ManagedError('INVALID_INPUT')
    return crypto.fingerprint(
      collection,
      context(account.owner_id, account.id, 'provider-collection')
    )
  }

  return Object.freeze({
    // Policy services use this within the SAME transaction as a policy update.
    enqueueInTransaction,
    async enqueue({ owner, accountId, expectedPolicy, cause }) {
      return db.transaction(async (tx) => {
        const account = await lockedAccount(tx, owner, accountId)
        if (account.policy_version !== expectedPolicy) throw new ManagedError('VERSION_CONFLICT')
        return enqueueInTransaction(tx, account, cause, clock())
      })
    },
    async claim() {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const global = await tx.get('SELECT write_paused FROM managed_metadata WHERE id = 1')
        if (!global || global.write_paused !== 0) return null
        // Bound stale-work cleanup. A later poll continues after a large backlog.
        for (let scan = 0; scan < 100; scan++) {
          const account = await tx.get(
            `SELECT a.* FROM managed_accounts a
            JOIN managed_owners o ON o.owner_id = a.owner_id
            WHERE o.write_paused = 0 AND a.state <> 'staged'
            AND NOT EXISTS (SELECT 1 FROM managed_jobs r WHERE r.account_id = a.id AND r.state = 'running')
            AND EXISTS (SELECT 1 FROM managed_jobs j WHERE j.account_id = a.id AND j.state IN ('pending', 'retrying') AND j.due_at <= $1)
            ORDER BY (SELECT MAX(j.priority) FROM managed_jobs j WHERE j.account_id = a.id AND j.state IN ('pending', 'retrying') AND j.due_at <= $1) DESC, a.id
            LIMIT 1${tx.type === 'postgres' ? ' FOR UPDATE OF a SKIP LOCKED' : ''}`,
            [timestamp]
          )
          if (!account) return null
          const job = await tx.get(
            `SELECT * FROM managed_jobs WHERE account_id = $1 AND state IN ('pending', 'retrying') AND due_at <= $2
            ORDER BY priority DESC, created_at, id LIMIT 1${lockSuffix(tx)}`,
            [account.id, timestamp]
          )
          if (!matchesPolicy(job, account, timestamp)) {
            await supersede(tx, job, account, timestamp)
            continue
          }
          const token = randomUUID()
          await tx.run(
            `UPDATE managed_jobs SET state = 'running', lease_token = $1, lease_until = $2, attempts = attempts + 1, updated_at = $3 WHERE id = $4`,
            [token, timestamp + leaseMs, timestamp, job.id]
          )
          return {
            ...job,
            state: 'running',
            lease_token: token,
            lease_until: timestamp + leaseMs,
            attempts: job.attempts + 1,
            updated_at: timestamp,
          }
        }
        return null
      })
    },
    async recoverExpired() {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const accounts = await tx.query(
          `SELECT a.id FROM managed_accounts a WHERE EXISTS (
          SELECT 1 FROM managed_jobs j WHERE j.account_id = a.id AND j.state = 'running' AND j.lease_until <= $1
        ) ORDER BY a.id LIMIT 100${tx.type === 'postgres' ? ' FOR UPDATE OF a SKIP LOCKED' : ''}`,
          [timestamp]
        )
        let recovered = 0
        for (const account of accounts) {
          const result = await tx.run(
            `UPDATE managed_jobs SET state = 'retrying', lease_token = NULL, lease_until = NULL,
            error_code = CASE WHEN write_intent = 1 THEN 'OUTCOME_UNKNOWN' ELSE 'LEASE_EXPIRED' END,
            due_at = $1, updated_at = $1 WHERE account_id = $2 AND state = 'running' AND lease_until <= $1`,
            [timestamp, account.id]
          )
          recovered += result.changes
        }
        return recovered
      })
    },
    async heartbeat(claim) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job } = await leased(tx, claim, timestamp)
        const until = Math.max(job.lease_until, timestamp + leaseMs)
        await tx.run('UPDATE managed_jobs SET lease_until = $1, updated_at = $2 WHERE id = $3', [
          until,
          timestamp,
          job.id,
        ])
        return until
      })
    },
    async beginWrite(claim, beforeCollection) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job, account } = await leased(tx, claim, timestamp)
        await ensureUnpaused(tx, account.owner_id)
        if (!matchesPolicy(job, account, timestamp)) throw new ManagedError('VERSION_CONFLICT')
        // Active setup must have a group; an expired account can still be disabled.
        if (job.target === 'active' && !account.group_id) throw new ManagedError('INVALID_STATE')
        const digest = collectionDigest(beforeCollection, account)
        if (
          await tx.get('SELECT id FROM managed_snapshots WHERE job_id = $1 AND attempt = $2', [
            job.id,
            job.attempts,
          ])
        )
          throw new ManagedError('INVALID_STATE')
        const snapshotId = randomUUID()
        await tx.run(
          `INSERT INTO managed_snapshots
          (id, owner_id, account_id, job_id, attempt, collection_enc, collection_digest, source, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'before-write', $8)`,
          [
            snapshotId,
            account.owner_id,
            account.id,
            job.id,
            job.attempts,
            crypto.seal(
              beforeCollection,
              context(account.owner_id, snapshotId, `snapshot:${account.id}`)
            ),
            digest,
            timestamp,
          ]
        )
        await tx.run('UPDATE managed_jobs SET write_intent = 1, updated_at = $1 WHERE id = $2', [
          timestamp,
          job.id,
        ])
        return { snapshotId }
      })
    },
    async completeVerified(claim, { expected, observed }) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job, account } = await leased(tx, claim, timestamp)
        if (!equalSecret(collectionDigest(expected, account), collectionDigest(observed, account)))
          throw new ManagedError('INVALID_STATE')
        if (!matchesPolicy(job, account, timestamp)) return supersede(tx, job, account, timestamp)
        if (job.target === 'active' && !account.group_id) throw new ManagedError('INVALID_STATE')
        // Suspension/offboarding must verify an empty *active* provider collection.
        if (job.target !== 'active' && observed.length !== 0)
          throw new ManagedError('INVALID_STATE')
        await tx.run(
          `UPDATE managed_jobs SET state = 'verified', lease_token = NULL, lease_until = NULL, error_code = NULL, updated_at = $1 WHERE id = $2`,
          [timestamp, job.id]
        )
        await tx.run(
          'UPDATE managed_accounts SET applied_version = $1, applied_target = $2, verified_at = $3 WHERE owner_id = $4 AND id = $5 AND policy_version = $1',
          [job.policy_version, job.target, timestamp, account.owner_id, account.id]
        )
        return { state: 'verified' }
      })
    },
    async retry(claim, { code, dueAt, terminal = false }) {
      if (!retryCodes.has(code) || typeof terminal !== 'boolean' || !Number.isSafeInteger(dueAt))
        throw new ManagedError('INVALID_INPUT')
      return db.transaction(async (tx) => {
        const timestamp = clock()
        if (dueAt < timestamp) throw new ManagedError('INVALID_INPUT')
        const { job, account } = await leased(tx, claim, timestamp)
        if (!matchesPolicy(job, account, timestamp)) return supersede(tx, job, account, timestamp)
        const state = terminal ? 'failed' : 'retrying'
        await tx.run(
          'UPDATE managed_jobs SET state = $1, due_at = $2, error_code = $3, lease_token = NULL, lease_until = NULL, updated_at = $4 WHERE id = $5',
          [state, dueAt, code, timestamp, job.id]
        )
        return { state }
      })
    },
  })
}
