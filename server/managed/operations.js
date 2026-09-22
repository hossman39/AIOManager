import { randomUUID } from 'node:crypto'
import { lockGroupMembers, memberSelectionSchema } from './group-members.js'
import { z } from 'zod'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { providerIdentityKey, readExecutionPolicy } from './execution.js'
import { currentAccountTarget } from './entitlement.js'
import { projectManagedCollection } from './projection.js'
import { addonUrlIdentity } from '../../shared/addon-config.js'

const context = (owner, id, purpose) => ({ owner, id, purpose })
const versionInput = z.strictObject({ expectedVersion: z.number().int().positive() })
const previewInput = versionInput.extend({ safeMode: z.boolean().nullable() })
const activationInput = versionInput.extend({
  receipt: z.string().min(1).max(32_768),
  allowEmpty: z.boolean().default(false),
})
const settingsInput = z.strictObject({
  expectedVersion: z.number().int().positive().nullable(),
  writePaused: z.boolean(),
  safeMode: z.boolean(),
})
const parse = (schema, input) => {
  const result = schema.safeParse(input)
  if (!result.success) throw new ManagedError('INVALID_INPUT')
  return result.data
}

/** Review and enrollment are serialized with ALL legacy writes, never network in a transaction. */
export function createManagedOperations({
  db,
  crypto,
  authorize,
  ownerTransaction,
  idempotent,
  publicAccount,
  jobs,
  runtime,
  now,
  validateManifests,
}) {
  const requireRuntime = () => {
    if (!runtime?.enabled) throw new ManagedError('WRITE_PAUSED')
  }
  const binding = (row, purpose) => context(row.owner_id, row.id, purpose)
  const digest = (row, value, purpose) => crypto.fingerprint(value, binding(row, purpose))
  async function account(tx, owner, id, version, lock = false) {
    const row = await tx.get(
      `SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2${lock && tx.type === 'postgres' ? ' FOR UPDATE' : ''}`,
      [owner, id]
    )
    if (!row) throw new ManagedError('NOT_FOUND')
    if (row.record_version !== version) throw new ManagedError('VERSION_CONFLICT')
    return row
  }
  async function previous(tx, owner, scope, key, input) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(key))
      throw new ManagedError('IDEMPOTENCY_KEY_REQUIRED')
    const row = await tx.get(
      'SELECT request_digest, response_enc FROM managed_idempotency WHERE owner_id = $1 AND scope = $2 AND request_key = $3',
      [owner, scope, key]
    )
    if (!row) return null
    if (
      !equalSecret(row.request_digest, crypto.fingerprint(input, context(owner, scope, 'request')))
    )
      throw new ManagedError('IDEMPOTENCY_CONFLICT')
    return {
      ...crypto.open(row.response_enc, context(owner, `${scope}:${key}`, 'idempotency-response')),
      replayed: true,
    }
  }
  async function unbound(row, providerKey) {
    const existing = await db.get('SELECT id FROM managed_accounts WHERE provider_key = $1', [
      providerKey,
    ])
    if (
      (existing && existing.id !== row.id) ||
      (await db.get('SELECT account_id FROM managed_offboarded WHERE provider_key = $1', [
        providerKey,
      ]))
    )
      throw new ManagedError('MANAGED_ACCOUNT')
  }
  async function previewPolicy(tx, row, provider, safeMode) {
    if (row.state !== 'staged' || (!row.lifetime && row.expiry_at === null))
      throw new ManagedError('INVALID_STATE')
    const prepared = {
      ...row,
      state: 'active',
      safe_mode: safeMode === null ? null : Number(safeMode),
      provider_key: providerIdentityKey(crypto, provider.id),
      provider_enc: crypto.seal(provider, binding(row, 'provider-session')),
    }
    // A chosen group must be published; individual accounts use their saved setup.
    const policy = await readExecutionPolicy(tx, prepared, crypto, 'active')
    return { prepared, policy: { ...policy, target: currentAccountTarget(prepared, now()) } }
  }
  async function audit(tx, row, event, detail, timestamp) {
    const id = randomUUID()
    await tx.run(
      'INSERT INTO managed_audit (id, owner_id, event_type, subject_id, detail_enc, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        id,
        row.owner_id,
        event,
        row.id,
        crypto.seal(detail, context(row.owner_id, id, 'audit')),
        timestamp,
      ]
    )
  }
  async function requestSyncInTransaction(tx, owner, id, value, offboard, timestamp) {
    const row = await account(tx, owner, id, value.expectedVersion, true)
    if (row.state === 'staged' || (offboard && row.state !== 'active'))
      throw new ManagedError('INVALID_STATE')
    await tx.run(
      'UPDATE managed_accounts SET state = $1, record_version = record_version + 1, policy_version = policy_version + 1, updated_at = $2 WHERE id = $3',
      [offboard ? 'offboarding' : row.state, timestamp, id]
    )
    const updated = await tx.get('SELECT * FROM managed_accounts WHERE id = $1', [id])
    const job = await jobs.enqueueInTransaction(
      tx,
      updated,
      offboard ? 'offboard' : 'manual',
      timestamp
    )
    await audit(
      tx,
      row,
      offboard ? 'account.offboarding' : 'account.sync-requested',
      { jobId: job.id },
      timestamp
    )
    return { account: publicAccount(updated), jobId: job.id, replayed: false }
  }

  const operations = {
    async reconnectAccount(auth, id, input, key) {
      const value = parse(versionInput.extend({ password: z.string().min(1).max(4096) }), input)
      const change = { id, ...value },
        scope = 'accounts.reconnect'
      const replay = await ownerTransaction(auth, (tx, owner) =>
        previous(tx, owner, scope, key, change)
      )
      if (replay) return replay
      requireRuntime()
      const owner = await authorize(auth)
      return runtime.exclusive(async () => {
        const again = await previous(db, owner, scope, key, change)
        if (again) return again
        const row = await account(db, owner, id, value.expectedVersion)
        const credentials = crypto.open(row.credentials_enc, binding(row, 'credentials'))
        const session = await runtime.provider.login({
          email: credentials.email,
          password: value.password,
        })
        const providerKey = providerIdentityKey(crypto, session.id)
        if (row.provider_key && !equalSecret(row.provider_key, providerKey))
          throw new ManagedError('IDENTITY_MISMATCH')
        if (!row.provider_key) await unbound(row, providerKey)
        return ownerTransaction(auth, (tx, currentOwner, _settings, timestamp) =>
          idempotent(tx, currentOwner, scope, key, change, timestamp, async () => {
            const current = await account(tx, owner, id, value.expectedVersion, true)
            await tx.run(
              `UPDATE managed_accounts SET credentials_enc = $1, provider_enc = $2,
              record_version = record_version + 1, policy_version = policy_version + 1, updated_at = $3 WHERE id = $4`,
              [
                crypto.seal(
                  { ...credentials, password: value.password },
                  binding(row, 'credentials')
                ),
                current.state === 'staged'
                  ? null
                  : crypto.seal(session, binding(row, 'provider-session')),
                timestamp,
                id,
              ]
            )
            const updated = await tx.get('SELECT * FROM managed_accounts WHERE id = $1', [id])
            const job =
              current.state === 'staged'
                ? null
                : await jobs.enqueueInTransaction(tx, updated, 'manual', timestamp)
            await audit(tx, row, 'account.reconnected', { jobId: job?.id ?? null }, timestamp)
            return { account: publicAccount(updated), jobId: job?.id ?? null, replayed: false }
          })
        )
      })
    },
    async previewActivation(auth, id, input) {
      requireRuntime()
      const value = parse(previewInput, input),
        owner = await authorize(auth)
      return runtime.exclusive(async () => {
        const row = await account(db, owner, id, value.expectedVersion)
        if (row.state !== 'staged') throw new ManagedError('INVALID_STATE')
        const credentials = crypto.open(row.credentials_enc, binding(row, 'credentials'))
        const provider = await runtime.provider.login(credentials)
        const { prepared, policy } = await previewPolicy(db, row, provider, value.safeMode)
        await unbound(row, prepared.provider_key)
        if (typeof validateManifests !== 'function')
          throw new ManagedError('PUBLICATION_UNAVAILABLE')
        const remote = await runtime.provider.getCollection(provider)
        // Existing provider descriptors (including Local Files) do not require a
        // backend fetch of their URL. New account URLs are still validated.
        const observed = new Map(
          remote.map((addon) => [addonUrlIdentity(addon.transportUrl), addon.manifest.id])
        )
        const unobserved = [...policy.personal, ...policy.accountOverrides.addons].filter(
          (addon) => observed.get(addonUrlIdentity(addon.transportUrl)) !== addon.manifest.id
        )
        if ((await validateManifests([...policy.group, ...unobserved])) !== true)
          throw new ManagedError('MANIFEST_UNAVAILABLE')
        const plan = projectManagedCollection({ ...policy, remote })
        const expected = runtime.provider.normalizeCollection?.(plan.expected) ?? plan.expected
        const expiresAt = now() + 5 * 60_000
        return {
          accountId: id,
          version: row.record_version,
          safeMode: policy.safeMode,
          target: policy.target,
          beforeCount: remote.length,
          afterCount: expected.length,
          addons: expected.map((addon) => ({ name: addon.manifest.name, id: addon.manifest.id })),
          expiresAt,
          receipt: crypto.seal(
            {
              v: 1,
              version: row.record_version,
              safeMode: value.safeMode,
              provider,
              stamp: policy.stamp,
              target: policy.target,
              remoteDigest: digest(row, remote, 'activation-remote'),
              expectedDigest: digest(row, expected, 'activation-expected'),
              expiresAt,
            },
            binding(row, 'activation-preview')
          ),
        }
      })
    },
    async activateAccount(auth, id, input, key) {
      const value = parse(activationInput, input),
        change = { id, ...value },
        scope = 'accounts.activate'
      const replay = await ownerTransaction(auth, (tx, owner) =>
        previous(tx, owner, scope, key, change)
      )
      if (replay) return replay
      requireRuntime()
      const owner = await authorize(auth)
      return runtime.exclusive(async () => {
        const again = await previous(db, owner, scope, key, change)
        if (again) return again
        const row = await account(db, owner, id, value.expectedVersion)
        let receipt
        try {
          receipt = crypto.open(value.receipt, binding(row, 'activation-preview'))
        } catch {
          throw new ManagedError('PREVIEW_STALE')
        }
        if (
          receipt.v !== 1 ||
          receipt.version !== value.expectedVersion ||
          receipt.expiresAt <= now()
        )
          throw new ManagedError('PREVIEW_STALE')
        const { prepared, policy } = await previewPolicy(
          db,
          row,
          receipt.provider,
          receipt.safeMode
        )
        await unbound(row, prepared.provider_key)
        if ((await runtime.provider.getIdentity(receipt.provider)) !== receipt.provider.id)
          throw new ManagedError('IDENTITY_MISMATCH')
        const remote = await runtime.provider.getCollection(receipt.provider)
        const plan = projectManagedCollection({ ...policy, remote })
        const expected = runtime.provider.normalizeCollection?.(plan.expected) ?? plan.expected
        if (
          !equalSecret(digest(row, remote, 'activation-remote'), receipt.remoteDigest) ||
          !equalSecret(digest(row, expected, 'activation-expected'), receipt.expectedDigest)
        )
          throw new ManagedError('PREVIEW_STALE')
        if (!expected.length && !value.allowEmpty)
          throw new ManagedError('EMPTY_PUBLICATION_CONFIRMATION')
        return ownerTransaction(auth, (tx, currentOwner, _settings, timestamp) =>
          idempotent(tx, currentOwner, scope, key, change, timestamp, async () => {
            const current = await account(tx, owner, id, value.expectedVersion, true)
            const latest = await previewPolicy(tx, current, receipt.provider, receipt.safeMode)
            if (
              !equalSecret(latest.policy.stamp, receipt.stamp) ||
              latest.policy.target !== receipt.target ||
              receipt.expiresAt <= timestamp
            )
              throw new ManagedError('PREVIEW_STALE')
            await tx.run(
              `UPDATE managed_accounts SET state = 'active', provider_key = $1, provider_enc = $2,
              safe_mode = $3, configuration_enc = $4, record_version = record_version + 1,
              policy_version = policy_version + 1, updated_at = $5 WHERE id = $6`,
              [
                prepared.provider_key,
                prepared.provider_enc,
                prepared.safe_mode,
                crypto.seal(plan.configuration, binding(row, 'configuration')),
                timestamp,
                id,
              ]
            )
            const updated = await tx.get('SELECT * FROM managed_accounts WHERE id = $1', [id])
            const job = await jobs.enqueueInTransaction(tx, updated, 'activation', timestamp)
            await audit(
              tx,
              row,
              'account.activated',
              { jobId: job.id, target: job.target },
              timestamp
            )
            return { account: publicAccount(updated), jobId: job.id, replayed: false }
          })
        )
      })
    },
    async setSettings(auth, input, key) {
      const value = parse(settingsInput, input)
      if (!value.writePaused) requireRuntime()
      return ownerTransaction(auth, (tx, owner, settings, timestamp) =>
        idempotent(tx, owner, 'settings.save', key, value, timestamp, async () => {
          if (settings.version !== (value.expectedVersion ?? 1))
            throw new ManagedError('VERSION_CONFLICT')
          await tx.run(
            'UPDATE managed_owners SET write_paused = $1, safe_mode = $2, version = version + 1, updated_at = $3 WHERE owner_id = $4',
            [Number(value.writePaused), Number(value.safeMode), timestamp, owner]
          )
          return {
            version: settings.version + 1,
            writePaused: value.writePaused,
            safeMode: value.safeMode,
            replayed: false,
          }
        })
      )
    },
    async requestSync(auth, id, input, key, offboard = false) {
      requireRuntime()
      const value = parse(versionInput, input)
      return ownerTransaction(auth, (tx, owner, _settings, timestamp) =>
        idempotent(
          tx,
          owner,
          offboard ? 'accounts.offboard' : 'accounts.sync',
          key,
          { id, ...value },
          timestamp,
          async () => {
            return requestSyncInTransaction(tx, owner, id, value, offboard, timestamp)
          }
        )
      )
    },
    async requestGroupSync(auth, groupId, input, key) {
      requireRuntime()
      const value = parse(z.strictObject({ accounts: memberSelectionSchema }), input)
      value.accounts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return ownerTransaction(auth, (tx, owner, _settings, timestamp) =>
        idempotent(
          tx,
          owner,
          'groups.member-sync',
          key,
          { groupId, ...value },
          timestamp,
          async () => {
            const members = await lockGroupMembers(tx, owner, groupId, value.accounts)
            if (members.some((account) => account.state !== 'active'))
              throw new ManagedError('INVALID_STATE')
            const accounts = []
            for (const expected of value.accounts) {
              const result = await requestSyncInTransaction(
                tx,
                owner,
                expected.id,
                expected,
                false,
                timestamp
              )
              accounts.push({ account: result.account, jobId: result.jobId })
            }
            return { accounts, replayed: false }
          }
        )
      )
    },
    async accountExecution(auth, id) {
      const owner = await authorize(auth)
      const row = await db.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
        owner,
        id,
      ])
      if (!row) {
        const removed = await db.get(
          'SELECT removed_at FROM managed_offboarded WHERE owner_id = $1 AND account_id = $2',
          [owner, id]
        )
        if (!removed) throw new ManagedError('NOT_FOUND')
        return { account: null, removedAt: removed.removed_at, job: null }
      }
      const job = await db.get(
        `SELECT id, state, target, attempts, error_code, due_at, updated_at FROM managed_jobs
        WHERE owner_id = $1 AND account_id = $2 AND policy_version = $3 ORDER BY priority DESC, created_at DESC LIMIT 1`,
        [owner, id, row.policy_version]
      )
      return {
        account: publicAccount(row),
        removedAt: null,
        job: job
          ? {
              id: job.id,
              state: job.state,
              target: job.target,
              attempts: job.attempts,
              errorCode: job.error_code,
              dueAt: job.due_at,
              updatedAt: job.updated_at,
            }
          : null,
      }
    },
  }
  return Object.freeze(operations)
}
