import { randomUUID } from 'node:crypto'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { currentAccountTarget, observeSuspension } from './entitlement.js'
import { readExecutionPolicy, checkedExecutionPlan } from './execution.js'
export { currentAccountTarget } from './entitlement.js'

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
  'WRITE_PAUSED',
  'INVALID_STATE',
  'IDENTITY_MISMATCH',
])
const lockSuffix = (tx) => (tx.type === 'postgres' ? ' FOR UPDATE' : '')
const context = (owner, id, purpose) => ({ owner, id, purpose })

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
    await observeSuspension(tx, account, timestamp)
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
    await observeSuspension(tx, account, timestamp)
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

  const planContext = (job) => context(job.owner_id, job.id, 'execution-plan')
  async function checkPolicyStamp(tx, job, account, stamp) {
    const policy = await readExecutionPolicy(tx, account, crypto, job.target)
    if (!equalSecret(policy.stamp, stamp)) throw new ManagedError('VERSION_CONFLICT')
    return policy
  }

  async function reschedulePolicy(tx, job, account, timestamp) {
    if (!matchesPolicy(job, account, timestamp)) return supersede(tx, job, account, timestamp)
    await tx.run(
      `UPDATE managed_jobs SET state = 'retrying', execution_enc = NULL,
      lease_token = NULL, lease_until = NULL, due_at = $1, updated_at = $1,
      error_code = 'OUTCOME_UNKNOWN' WHERE id = $2`,
      [timestamp, job.id]
    )
    return { state: 'retrying' }
  }

  return Object.freeze({
    // Policy services use this within the SAME transaction as a policy update.
    enqueueInTransaction,
    async readExecution(claim) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job, account } = await leased(tx, claim, timestamp)
        await ensureUnpaused(tx, account.owner_id)
        if (!matchesPolicy(job, account, timestamp)) return supersede(tx, job, account, timestamp)
        const policy = await readExecutionPolicy(tx, account, crypto, job.target)
        const stored = job.execution_enc
          ? checkedExecutionPlan(crypto.open(job.execution_enc, planContext(job)))
          : null
        return {
          state: 'current',
          policy,
          plan: stored && equalSecret(stored.stamp, policy.stamp) ? stored : null,
        }
      })
    },
    async checkDispatch(claim, stamp) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job, account } = await leased(tx, claim, timestamp)
        await ensureUnpaused(tx, account.owner_id)
        if (!matchesPolicy(job, account, timestamp)) throw new ManagedError('VERSION_CONFLICT')
        await checkPolicyStamp(tx, job, account, stamp)
      })
    },
    async reschedulePolicy(claim) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job, account } = await leased(tx, claim, timestamp)
        return reschedulePolicy(tx, job, account, timestamp)
      })
    },
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
          await observeSuspension(tx, account, timestamp)
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
            `UPDATE managed_jobs SET state = 'running', lease_token = $1, lease_until = $2, attempts = attempts + 1, cycle_attempts = cycle_attempts + 1, updated_at = $3 WHERE id = $4`,
            [token, timestamp + leaseMs, timestamp, job.id]
          )
          return {
            ...job,
            state: 'running',
            lease_token: token,
            lease_until: timestamp + leaseMs,
            attempts: job.attempts + 1,
            cycle_attempts: job.cycle_attempts + 1,
            updated_at: timestamp,
          }
        }
        return null
      })
    },
    async scanExpiry({ limit = 100 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 200)
        throw new ManagedError('INVALID_INPUT')
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const accounts = await tx.query(
          `SELECT * FROM managed_accounts WHERE state = 'active' AND lifetime = 0
          AND expiry_at IS NOT NULL AND suspended_at IS NULL AND expiry_at <= $1
          ORDER BY expiry_at, id LIMIT $2${tx.type === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''}`,
          [timestamp, limit]
        )
        for (const account of accounts) await enqueueInTransaction(tx, account, 'expiry', timestamp)
        const suspended = await tx.query(
          `SELECT * FROM managed_accounts WHERE state = 'active' AND suspended_at IS NOT NULL
          AND (suspension_check_at IS NULL OR suspension_check_at <= $1)
          ORDER BY suspension_check_at, id LIMIT $2${tx.type === 'postgres' ? ' FOR UPDATE SKIP LOCKED' : ''}`,
          [timestamp, limit]
        )
        for (const account of suspended) {
          const job = await enqueueInTransaction(tx, account, 'expiry', timestamp)
          const canRetry =
            job.state === 'verified' ||
            (job.state === 'failed' &&
              [
                'NETWORK_ERROR',
                'RATE_LIMITED',
                'PROVIDER_UNAVAILABLE',
                'OUTCOME_UNKNOWN',
                'VERIFICATION_MISMATCH',
              ].includes(job.error_code))
          if (canRetry)
            await tx.run(
              `UPDATE managed_jobs SET state = 'pending', execution_enc = NULL, cycle_attempts = 0, priority = 60,
            write_intent = 0, error_code = NULL, due_at = $1, updated_at = $1 WHERE id = $2`,
              [timestamp, job.id]
            )
          await tx.run('UPDATE managed_accounts SET suspension_check_at = $1 WHERE id = $2', [
            timestamp + 300_000,
            account.id,
          ])
        }
        await tx.run('UPDATE managed_metadata SET last_scan_at = $1 WHERE id = 1', [timestamp])
        return accounts.length
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
    async beginWrite(claim, beforeCollection, executionPlan) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job, account } = await leased(tx, claim, timestamp)
        await ensureUnpaused(tx, account.owner_id)
        if (!matchesPolicy(job, account, timestamp)) throw new ManagedError('VERSION_CONFLICT')
        if (job.target === 'active' && !account.group_id && !account.addons_initialized)
          throw new ManagedError('INVALID_STATE')
        const plan = executionPlan === undefined ? null : checkedExecutionPlan(executionPlan)
        if (plan) await checkPolicyStamp(tx, job, account, plan.stamp)
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
        if (plan) {
          await tx.run('UPDATE managed_jobs SET execution_enc = $1 WHERE id = $2', [
            crypto.seal(plan, planContext(job)),
            job.id,
          ])
          await tx.run(
            'UPDATE managed_accounts SET configuration_enc = $1 WHERE owner_id = $2 AND id = $3',
            [
              crypto.seal(
                plan.configuration,
                context(account.owner_id, account.id, 'configuration')
              ),
              account.owner_id,
              account.id,
            ]
          )
        }
        return { snapshotId }
      })
    },
    async completeVerified(claim, { expected, observed, plan: executionPlan }) {
      return db.transaction(async (tx) => {
        const timestamp = clock()
        const { job, account } = await leased(tx, claim, timestamp)
        if (!equalSecret(collectionDigest(expected, account), collectionDigest(observed, account)))
          throw new ManagedError('INVALID_STATE')
        if (!matchesPolicy(job, account, timestamp)) return supersede(tx, job, account, timestamp)
        if (job.target === 'active' && !account.group_id && !account.addons_initialized)
          throw new ManagedError('INVALID_STATE')
        // Suspension/offboarding must verify an empty *active* provider collection.
        if (job.target !== 'active' && observed.length !== 0)
          throw new ManagedError('INVALID_STATE')
        if (executionPlan !== undefined) {
          const plan = checkedExecutionPlan(executionPlan)
          const policy = await readExecutionPolicy(tx, account, crypto, job.target)
          if (!equalSecret(policy.stamp, plan.stamp))
            return reschedulePolicy(tx, job, account, timestamp)
          if (
            !equalSecret(
              collectionDigest(plan.expected, account),
              collectionDigest(expected, account)
            )
          )
            throw new ManagedError('INVALID_STATE')
          await tx.run(
            'UPDATE managed_accounts SET configuration_enc = $1 WHERE owner_id = $2 AND id = $3',
            [
              crypto.seal(
                plan.configuration,
                context(account.owner_id, account.id, 'configuration')
              ),
              account.owner_id,
              account.id,
            ]
          )
        }
        await tx.run(
          `UPDATE managed_jobs SET state = 'verified', lease_token = NULL, lease_until = NULL, error_code = NULL, updated_at = $1 WHERE id = $2`,
          [timestamp, job.id]
        )
        await tx.run(
          'UPDATE managed_accounts SET applied_version = $1, applied_target = $2, verified_at = $3 WHERE owner_id = $4 AND id = $5 AND policy_version = $1',
          [job.policy_version, job.target, timestamp, account.owner_id, account.id]
        )
        if (job.target === 'suspended')
          await tx.run('UPDATE managed_accounts SET suspension_check_at = $1 WHERE id = $2', [
            timestamp + 300_000,
            account.id,
          ])
        // A verified empty collection is the only path that removes an enrolled
        // account. Keep identity/job tombstones, never credentials or snapshots.
        if (job.target === 'offboard') {
          await tx.run(
            `INSERT INTO managed_offboarded (provider_key, owner_id, account_id, removed_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT (provider_key) DO NOTHING`,
            [account.provider_key, account.owner_id, account.id, timestamp]
          )
          await tx.run(
            `INSERT INTO managed_job_history (id, owner_id, account_id, policy_version, target, state, error_code, updated_at)
            SELECT id, owner_id, account_id, policy_version, target,
            CASE WHEN state = 'verified' THEN 'verified' ELSE 'superseded' END, NULL, $1
            FROM managed_jobs WHERE account_id = $2`,
            [timestamp, account.id]
          )
          await tx.run('DELETE FROM managed_snapshots WHERE account_id = $1', [account.id])
          await tx.run('DELETE FROM managed_jobs WHERE account_id = $1', [account.id])
          const receipts = await tx.query(
            "SELECT scope, request_key, response_enc FROM managed_idempotency WHERE owner_id = $1 AND scope = 'accounts.personal'",
            [account.owner_id]
          )
          for (const receipt of receipts) {
            const response = crypto.open(
              receipt.response_enc,
              context(
                account.owner_id,
                `${receipt.scope}:${receipt.request_key}`,
                'idempotency-response'
              )
            )
            if (response.account?.id === account.id)
              await tx.run(
                'DELETE FROM managed_idempotency WHERE owner_id = $1 AND scope = $2 AND request_key = $3',
                [account.owner_id, receipt.scope, receipt.request_key]
              )
          }
          await tx.run('DELETE FROM managed_accounts WHERE id = $1', [account.id])
        }
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
        if (terminal && job.target === 'suspended')
          await tx.run('UPDATE managed_accounts SET suspension_check_at = $1 WHERE id = $2', [
            Math.max(timestamp + 15 * 60_000, dueAt),
            account.id,
          ])
        return { state }
      })
    },
  })
}
