import { randomUUID } from 'node:crypto'
import { createExpiryNoticeRepository } from './expiry-notice.js'
import { z } from 'zod'
import { parseCredentialImport } from '../../shared/credential-import.js'
import { resolveExpiry, MEMBERSHIP_TIMEZONE } from '../../shared/membership-expiry.js'
import { authenticateManager } from './auth.js'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { createManagedJobStore, currentAccountTarget } from './jobs.js'
import { createManagedGroupRepository } from './groups.js'
import { createManagedOperations } from './operations.js'
import { createManagedConnections } from './connections.js'
import { createAccountAddonRepository } from './account-addons.js'
import { lockGroupMembers, memberSelectionSchema } from './group-members.js'

const context = (owner, id, purpose) => ({ owner, id, purpose })
const membershipSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('lifetime'), expectedVersion: z.number().int().positive() }),
  z.strictObject({
    mode: z.literal('term'),
    expectedVersion: z.number().int().positive(),
    local: z.string(),
    offset: z.number().finite().optional(),
    timezone: z.string().max(100).optional(),
  }),
])
const bulkMembershipSchema = z.strictObject({
  accounts: memberSelectionSchema,
  membership: z.discriminatedUnion(
    'mode',
    membershipSchema.options.map((option) => option.omit({ expectedVersion: true }))
  ),
})

export function parseImportBody(body) {
  return parseCredentialImport(JSON.stringify(body))
}

/** Staging cannot activate; only publication preparation may invoke a trusted manifest validator. */
export function createManagedRepository({
  db,
  crypto,
  legacyKeys,
  now = Date.now,
  validateManifests,
  runtime,
}) {
  const authorize = (auth) => authenticateManager(db, auth, legacyKeys)
  const jobs = createManagedJobStore({ db, crypto, now })

  async function ownerTransaction(auth, operation) {
    return db.transaction(async (tx) => {
      const owner = await authenticateManager(tx, auth, legacyKeys, { lock: true })
      const timestamp = now()
      await tx.run(
        `INSERT INTO managed_owners (owner_id, created_at, updated_at)
        VALUES ($1, $2, $2) ON CONFLICT (owner_id) DO NOTHING`,
        [owner, timestamp]
      )
      const ownerRow = await tx.get(
        `SELECT * FROM managed_owners WHERE owner_id = $1${tx.type === 'postgres' ? ' FOR UPDATE' : ''}`,
        [owner]
      )
      return operation(tx, owner, ownerRow, timestamp)
    })
  }

  async function idempotent(tx, owner, scope, requestKey, input, timestamp, operation) {
    if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(requestKey))
      throw new ManagedError('IDEMPOTENCY_KEY_REQUIRED')
    const digest = crypto.fingerprint(input, context(owner, scope, 'request'))
    const responseContext = context(owner, `${scope}:${requestKey}`, 'idempotency-response')
    const previous = await tx.get(
      'SELECT request_digest, response_enc FROM managed_idempotency WHERE owner_id = $1 AND scope = $2 AND request_key = $3',
      [owner, scope, requestKey]
    )
    if (previous) {
      if (!equalSecret(previous.request_digest, digest))
        throw new ManagedError('IDEMPOTENCY_CONFLICT')
      return { ...crypto.open(previous.response_enc, responseContext), replayed: true }
    }
    const result = await operation()
    await tx.run(
      `INSERT INTO managed_idempotency (owner_id, scope, request_key, request_digest, response_enc, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      [owner, scope, requestKey, digest, crypto.seal(result, responseContext), timestamp]
    )
    return result
  }

  async function setMembershipInTransaction(tx, owner, change, timestamp) {
    const { id, expiry } = change
    const account = await tx.get(
      `SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2${tx.type === 'postgres' ? ' FOR UPDATE' : ''}`,
      [owner, id]
    )
    if (!account) throw new ManagedError('NOT_FOUND')
    if (account.record_version !== change.expectedVersion)
      throw new ManagedError('VERSION_CONFLICT')
    if (account.state === 'offboarding') throw new ManagedError('INVALID_STATE')
    const lifetime = change.mode === 'lifetime' ? 1 : 0
    const suspendedAt = lifetime === 1 || expiry.at > timestamp ? null : account.suspended_at
    if (
      account.lifetime === lifetime &&
      account.expiry_at === (expiry?.at ?? null) &&
      (!expiry ||
        (account.expiry_local === expiry.local &&
          (account.expiry_zone ?? MEMBERSHIP_TIMEZONE) === expiry.timezone)) &&
      account.suspended_at === suspendedAt
    )
      return { account: publicAccount(account), jobId: null, replayed: false }
    const result = await tx.run(
      `UPDATE managed_accounts SET lifetime = $1, expiry_at = $2, expiry_local = $3,
      expiry_offset = $4, expiry_timezone = $5, record_version = record_version + 1, policy_version = policy_version + 1,
      updated_at = $6, suspended_at = $10, expiry_zone = $11, expiry_zone_offset = $12
      WHERE owner_id = $7 AND id = $8 AND record_version = $9`,
      [
        lifetime,
        expiry?.at ?? null,
        expiry?.local ?? null,
        expiry ? Math.trunc(expiry.offset) : null,
        expiry ? MEMBERSHIP_TIMEZONE : null, // Legacy constraint; expiry_zone is authoritative since migration 4.
        timestamp,
        owner,
        id,
        change.expectedVersion,
        suspendedAt,
        expiry?.timezone ?? account.expiry_zone ?? MEMBERSHIP_TIMEZONE,
        expiry ? Math.round(expiry.offset * 60) : null,
      ]
    )
    if (result.changes !== 1) throw new ManagedError('VERSION_CONFLICT')
    const updated = await tx.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
      owner,
      id,
    ])
    let jobId = null
    if (updated.state === 'active') {
      const target = currentAccountTarget(updated, timestamp)
      const cause =
        target === 'suspended'
          ? 'expiry'
          : currentAccountTarget(account, timestamp) === 'suspended'
            ? 'renewal'
            : 'manual'
      const job = await jobs.enqueueInTransaction(tx, updated, cause, timestamp)
      jobId = job.id
    }
    const eventId = randomUUID()
    await tx.run(
      'INSERT INTO managed_audit (id, owner_id, event_type, subject_id, detail_enc, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [
        eventId,
        owner,
        'membership.changed',
        id,
        crypto.seal(
          { mode: change.mode, expiry, version: updated.record_version, jobId },
          context(owner, eventId, 'audit')
        ),
        timestamp,
      ]
    )
    return { account: publicAccount(updated), jobId, replayed: false }
  }

  async function inspectCandidates(connection, owner, parsed) {
    const candidates = []
    for (const candidate of parsed.accounts) {
      const emailKey = crypto.fingerprint(
        candidate.email.toLowerCase(),
        context(owner, 'email', 'lookup')
      )
      const existing = await connection.get(
        'SELECT id, credentials_enc FROM managed_accounts WHERE owner_id = $1 AND email_key = $2',
        [owner, emailKey]
      )
      const credentials = existing
        ? crypto.open(existing.credentials_enc, context(owner, existing.id, 'credentials'))
        : null
      candidates.push({
        candidate,
        emailKey,
        existing,
        status: !existing
          ? 'ready'
          : equalSecret(credentials.password, candidate.password)
            ? 'existing'
            : 'conflict',
      })
    }
    return candidates
  }

  function publicCandidate({ candidate, existing, status }) {
    return {
      ...(existing ? { id: existing.id } : {}),
      email: candidate.email,
      name: candidate.name,
      sourceRows: candidate.sourceRows,
      status,
    }
  }

  function publicAccount(row) {
    const credentials = crypto.open(
      row.credentials_enc,
      context(row.owner_id, row.id, 'credentials')
    )
    return {
      id: row.id,
      email: credentials.email,
      name: credentials.name,
      state: row.state,
      groupId: row.group_id,
      setupSaved: row.addons_initialized === 1 || row.group_id !== null,
      membershipType: row.lifetime === 1 ? 'lifetime' : row.expiry_at === null ? 'unset' : 'term',
      version: row.record_version,
      policyVersion: row.policy_version,
      expiry:
        row.expiry_at === null
          ? null
          : {
              at: row.expiry_at,
              local: row.expiry_local,
              offset:
                row.expiry_zone_offset == null ? row.expiry_offset : row.expiry_zone_offset / 60,
              timezone: row.expiry_zone ?? row.expiry_timezone,
            },
      safeMode: row.safe_mode === null ? null : row.safe_mode === 1,
      suspendedAt: row.suspended_at ?? null,
      expired: row.state === 'active' && currentAccountTarget(row, now()) === 'suspended',
      appliedVersion: row.applied_version,
      appliedTarget: row.applied_target,
      verifiedAt: row.verified_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  return Object.freeze({
    ...createManagedConnections({ crypto, ownerTransaction, publicAccount }),
    ...createExpiryNoticeRepository({ db, crypto, authorize, ownerTransaction, idempotent, jobs }),
    ...createAccountAddonRepository({
      db,
      crypto,
      authorize,
      ownerTransaction,
      idempotent,
      publicAccount,
      jobs,
      runtime,
      now,
    }),
    ...createManagedOperations({
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
    }),
    ...createManagedGroupRepository({
      db,
      crypto,
      authorize,
      ownerTransaction,
      idempotent,
      publicAccount,
      jobs,
      validateManifests,
    }),
    authorize,
    async setGroupMembership(auth, groupId, input, key) {
      const parsed = bulkMembershipSchema.safeParse(input)
      if (!parsed.success) throw new ManagedError('INVALID_INPUT')
      const value = parsed.data
      value.accounts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      let expiry = null
      if (value.membership.mode === 'term') {
        const resolved = resolveExpiry(
          value.membership.local,
          value.membership.offset,
          value.membership.timezone
        )
        if (!resolved.ok) throw new ManagedError(resolved.code)
        expiry = resolved.expiry
      }
      return ownerTransaction(auth, (tx, owner, _settings, timestamp) =>
        idempotent(
          tx,
          owner,
          'groups.membership',
          key,
          { groupId, ...value },
          timestamp,
          async () => {
            await lockGroupMembers(tx, owner, groupId, value.accounts)
            const accounts = []
            for (const expected of value.accounts) {
              const result = await setMembershipInTransaction(
                tx,
                owner,
                {
                  ...expected,
                  mode: value.membership.mode,
                  expiry,
                },
                timestamp
              )
              accounts.push({ account: result.account, jobId: result.jobId })
            }
            return { accounts, replayed: false }
          }
        )
      )
    },
    async setMembership(auth, id, input, requestKey) {
      const parsed = membershipSchema.safeParse(input)
      if (!parsed.success) throw new ManagedError('INVALID_INPUT')
      let expiry = null
      if (parsed.data.mode === 'term') {
        const resolved = resolveExpiry(parsed.data.local, parsed.data.offset, parsed.data.timezone)
        if (!resolved.ok) throw new ManagedError(resolved.code)
        const { at, local, offset, timezone } = resolved.expiry
        expiry = { at, local, offset, timezone }
      }
      const change = {
        id,
        expectedVersion: parsed.data.expectedVersion,
        mode: parsed.data.mode,
        expiry,
      }
      return ownerTransaction(auth, (tx, owner, _ownerRow, timestamp) =>
        idempotent(tx, owner, 'accounts.membership', requestKey, change, timestamp, async () => {
          return setMembershipInTransaction(tx, owner, change, timestamp)
        })
      )
    },
    async previewImport(auth, parsed) {
      if (!parsed?.ok) throw new ManagedError('INVALID_INPUT')
      const owner = await authorize(auth)
      const candidates = await inspectCandidates(db, owner, parsed)
      return {
        sourceFormat: parsed.sourceFormat,
        totalRows: parsed.totalRows,
        accounts: candidates.map(publicCandidate),
        issues: parsed.issues,
      }
    },
    async stageImport(auth, parsed, requestKey) {
      if (!parsed?.ok) throw new ManagedError('INVALID_INPUT')
      return ownerTransaction(auth, (tx, owner, _ownerRow, timestamp) =>
        idempotent(tx, owner, 'imports.stage', requestKey, parsed, timestamp, async () => {
          const sourceDigest = crypto.fingerprint(parsed, context(owner, 'import', 'batch'))
          const priorBatch = await tx.get(
            'SELECT id, report_enc FROM managed_batches WHERE owner_id = $1 AND source_digest = $2',
            [owner, sourceDigest]
          )
          if (priorBatch)
            return {
              ...crypto.open(priorBatch.report_enc, context(owner, priorBatch.id, 'batch-report')),
              replayed: true,
            }

          const candidates = await inspectCandidates(tx, owner, parsed)
          const report = {
            batchId: randomUUID(),
            createdAt: timestamp,
            sourceFormat: parsed.sourceFormat,
            totalRows: parsed.totalRows,
            candidateAccounts: candidates.length,
            created: 0,
            existing: 0,
            conflicts: 0,
            issues: [...parsed.issues],
            accounts: [],
            replayed: false,
          }
          for (const item of candidates) {
            const { candidate, emailKey, status } = item
            if (status === 'ready') {
              const id = randomUUID()
              const credentials = {
                email: candidate.email,
                name: candidate.email,
                password: candidate.password,
              }
              await tx.run(
                `INSERT INTO managed_accounts
                (id, owner_id, email_key, credentials_enc, personal_enc, configuration_enc, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
                [
                  id,
                  owner,
                  emailKey,
                  crypto.seal(credentials, context(owner, id, 'credentials')),
                  crypto.seal([], context(owner, id, 'personal-addons')),
                  crypto.seal([], context(owner, id, 'configuration')),
                  timestamp,
                ]
              )
              report.created++
              report.accounts.push({ ...publicCandidate(item), id, status: 'staged' })
            } else {
              report[status === 'existing' ? 'existing' : 'conflicts']++
              report.accounts.push(publicCandidate(item))
              if (status === 'conflict') {
                for (const row of candidate.sourceRows)
                  report.issues.push({
                    row,
                    code: 'EXISTING_PASSWORD_CONFLICT',
                    message: 'The saved password differs. No credentials were replaced.',
                  })
              }
            }
          }
          report.issues.sort((a, b) => a.row - b.row)
          await tx.run(
            'INSERT INTO managed_batches (id, owner_id, source_digest, report_enc, created_at) VALUES ($1, $2, $3, $4, $5)',
            [
              report.batchId,
              owner,
              sourceDigest,
              crypto.seal(report, context(owner, report.batchId, 'batch-report')),
              timestamp,
            ]
          )
          const eventId = randomUUID()
          await tx.run(
            'INSERT INTO managed_audit (id, owner_id, event_type, subject_id, detail_enc, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [
              eventId,
              owner,
              'import.staged',
              report.batchId,
              crypto.seal(
                {
                  created: report.created,
                  existing: report.existing,
                  conflicts: report.conflicts,
                  totalRows: report.totalRows,
                },
                context(owner, eventId, 'audit')
              ),
              timestamp,
            ]
          )
          return report
        })
      )
    },
    async listAccounts(auth, { limit = 100, after = '', view = 'all' } = {}) {
      if (
        !['all', 'expired'].includes(view) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        typeof after !== 'string' ||
        (after && !/^[a-f0-9-]{36}$/.test(after))
      )
        throw new ManagedError('INVALID_INPUT')
      const owner = await authorize(auth)
      const rows = await db.query(
        `SELECT * FROM managed_accounts WHERE owner_id = $1 AND id > $2
        ${view === 'expired' ? "AND state = 'active' AND (suspended_at IS NOT NULL OR (lifetime = 0 AND expiry_at <= $4))" : ''}
        ORDER BY id LIMIT $3`,
        view === 'expired' ? [owner, after, limit + 1, now()] : [owner, after, limit + 1]
      )
      return {
        accounts: rows.slice(0, limit).map(publicAccount),
        nextCursor: rows.length > limit ? rows[limit - 1].id : null,
      }
    },
    async getAccount(auth, id) {
      const owner = await authorize(auth)
      const row = await db.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
        owner,
        id,
      ])
      if (!row) throw new ManagedError('NOT_FOUND')
      return publicAccount(row)
    },
    async getBatch(auth, id) {
      const owner = await authorize(auth)
      const row = await db.get(
        'SELECT report_enc FROM managed_batches WHERE owner_id = $1 AND id = $2',
        [owner, id]
      )
      if (!row) throw new ManagedError('NOT_FOUND')
      return crypto.open(row.report_enc, context(owner, id, 'batch-report'))
    },
    async status(auth) {
      const owner = await authorize(auth)
      const settings = await db.get(
        'SELECT version, write_paused, safe_mode FROM managed_owners WHERE owner_id = $1',
        [owner]
      )
      const counts = await db.query(
        'SELECT state, COUNT(*) AS count FROM managed_accounts WHERE owner_id = $1 GROUP BY state',
        [owner]
      )
      const live = runtime
        ? await runtime.status()
        : { enabled: false, ready: false, writePaused: true, lastScanAt: null }
      return {
        capabilities: {
          passiveImport: true,
          providerWrites: live.enabled,
          groupPublication: typeof validateManifests === 'function',
        },
        writePaused: live.writePaused || !settings || settings.write_paused === 1,
        writerReady: live.ready,
        lastScanAt: live.lastScanAt,
        lastBackupAt: live.lastBackupAt ?? null,
        ownerWritePaused: settings ? settings.write_paused === 1 : true,
        safeMode: settings ? settings.safe_mode === 1 : true,
        version: settings?.version ?? null,
        accounts: Object.fromEntries(
          ['staged', 'active', 'offboarding'].map((state) => [
            state,
            counts.find((row) => row.state === state)?.count ?? 0,
          ])
        ),
      }
    },
  })
}
