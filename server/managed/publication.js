import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { addonUrlIdentity } from '../../shared/addon-config.js'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { currentAccountTarget } from './jobs.js'

export const MAX_PUBLICATION_MEMBERS = 1000
export const PUBLICATION_PREVIEW_TTL_MS = 5 * 60_000
const context = (owner, id, purpose) => ({ owner, id, purpose })
const previewInput = z.strictObject({ expectedVersion: z.number().int().positive() })
const publishInput = previewInput.extend({
  receipt: z.string().min(1).max(8192),
  allowEmpty: z.boolean().default(false),
})
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const receiptSchema = z.strictObject({
  v: z.literal(1),
  version: z.number().int().positive(),
  payloadDigest: hash,
  cohortDigest: hash,
  ownerSafeMode: z.union([z.literal(0), z.literal(1)]),
  createdAt: z.number().int().nonnegative(),
})
const cohortSchema = z.object({
  members: z
    .array(
      z.object({
        accountId: z.uuid(),
        jobId: z.uuid(),
        policyVersion: z.number().int().positive(),
        target: z.enum(['active', 'suspended']),
      })
    )
    .max(MAX_PUBLICATION_MEMBERS),
  skipped: z.object({
    staged: z.number().int().nonnegative(),
    offboarding: z.number().int().nonnegative(),
  }),
})
const parse = (schema, input) => {
  const result = schema.safeParse(input)
  if (!result.success) throw new ManagedError('INVALID_INPUT')
  return result.data
}

/** Publication persistence; network validation is injected and always outside transactions. */
export function createGroupPublicationRepository({
  db,
  crypto,
  authorize,
  ownerTransaction,
  idempotent,
  jobs,
  validateManifests,
  group,
  draft,
  personal,
  effectiveGroup,
  layerGuard,
  publicGroup,
  audit,
}) {
  const digest = (owner, id, value, purpose = 'group-payload') =>
    crypto.fingerprint(value, context(owner, id, purpose))
  const requireValidator = () => {
    if (typeof validateManifests !== 'function') throw new ManagedError('PUBLICATION_UNAVAILABLE')
  }
  async function snapshot(tx, owner, ownerRow, id, expectedVersion, timestamp) {
    const row = await group(tx, owner, id, true)
    if (row.version !== expectedVersion) throw new ManagedError('VERSION_CONFLICT')
    if (row.archived) throw new ManagedError('INVALID_STATE')
    const addons = draft(row)
    const guard = layerGuard(addons)
    const members = await tx.query(
      `SELECT * FROM managed_accounts WHERE owner_id = $1 AND group_id = $2 ORDER BY id LIMIT ${MAX_PUBLICATION_MEMBERS + 1}${tx.type === 'postgres' ? ' FOR UPDATE' : ''}`,
      [owner, id]
    )
    if (members.length > MAX_PUBLICATION_MEMBERS) throw new ManagedError('GROUP_TOO_LARGE')
    const counts = { active: 0, suspended: 0, staged: 0, offboarding: 0 }
    const cohort = members.map((account) => {
      const target = currentAccountTarget(account, timestamp)
      counts[
        account.state === 'staged'
          ? 'staged'
          : account.state === 'offboarding'
            ? 'offboarding'
            : target
      ]++
      if (account.state !== 'offboarding') guard(personal(account))
      return {
        id: account.id,
        version: account.record_version,
        policyVersion: account.policy_version,
        state: account.state,
        target,
        safeMode: account.safe_mode,
      }
    })
    const payloadDigest = digest(owner, id, addons)
    const binding = {
      version: row.version,
      payloadDigest,
      cohortDigest: digest(owner, id, cohort, 'publication-cohort'),
      ownerSafeMode: ownerRow.safe_mode,
    }
    const previous =
      row.published_revision === null ? null : await effectiveGroup(tx, row, 'active')
    return {
      row,
      addons,
      members,
      counts,
      binding,
      previous,
      unchanged: previous !== null && equalSecret(digest(owner, id, previous), payloadDigest),
      empty: addons.every((addon) => addon.flags?.enabled === false),
    }
  }
  function changes(owner, id, before, after) {
    const prior = new Map(before.map((addon) => [addonUrlIdentity(addon.transportUrl), addon]))
    const next = new Map(after.map((addon) => [addonUrlIdentity(addon.transportUrl), addon]))
    const priorOrder = [...prior.keys()].filter((key) => next.has(key))
    const nextOrder = [...next.keys()].filter((key) => prior.has(key))
    return {
      added: [...next.keys()].filter((key) => !prior.has(key)).length,
      removed: [...prior.keys()].filter((key) => !next.has(key)).length,
      changed: [...next.keys()].filter(
        (key) =>
          prior.has(key) &&
          !equalSecret(
            digest(owner, id, prior.get(key), 'publication-entry'),
            digest(owner, id, next.get(key), 'publication-entry')
          )
      ).length,
      reordered: priorOrder.some((key, index) => key !== nextOrder[index]),
    }
  }

  return {
    async previewGroupPublication(auth, id, input, { signal } = {}) {
      const value = parse(previewInput, input)
      const owner = await authorize(auth)
      const initial = await group(db, owner, id)
      if (initial.version !== value.expectedVersion) throw new ManagedError('VERSION_CONFLICT')
      if (initial.archived) throw new ManagedError('INVALID_STATE')
      requireValidator()
      const addons = draft(initial)
      const initialDigest = digest(owner, id, addons)
      // No transaction or row lock is held while a trusted adapter validates URLs.
      // It may reject unreachable/configuration-required manifests, but cannot
      // overwrite the operator's curated metadata/catalog choices.
      try {
        if ((await validateManifests(structuredClone(addons), { signal })) !== true)
          throw new Error('No validation confirmation')
      } catch (error) {
        if (error instanceof ManagedError && error.code.startsWith('MANIFEST_')) throw error
        throw new ManagedError('MANIFEST_UNAVAILABLE')
      }
      return ownerTransaction(auth, async (tx, currentOwner, ownerRow, timestamp) => {
        const state = await snapshot(
          tx,
          currentOwner,
          ownerRow,
          id,
          value.expectedVersion,
          timestamp
        )
        if (!equalSecret(initialDigest, state.binding.payloadDigest))
          throw new ManagedError('PREVIEW_STALE')
        return {
          groupId: id,
          version: state.row.version,
          publishedRevision: state.row.published_revision,
          counts: state.counts,
          changes: changes(owner, id, state.previous ?? [], state.addons),
          empty: state.empty,
          unchanged: state.unchanged,
          expiresAt: timestamp + PUBLICATION_PREVIEW_TTL_MS,
          receipt: crypto.seal(
            { v: 1, ...state.binding, createdAt: timestamp },
            context(owner, id, 'publication-preview')
          ),
        }
      })
    },
    async publishGroup(auth, id, input, key) {
      const value = parse(publishInput, input)
      return ownerTransaction(auth, (tx, owner, ownerRow, timestamp) =>
        idempotent(tx, owner, 'groups.publish', key, { id, ...value }, timestamp, async () => {
          requireValidator()
          let receipt
          try {
            receipt = receiptSchema.parse(
              crypto.open(value.receipt, context(owner, id, 'publication-preview'))
            )
          } catch {
            throw new ManagedError('PREVIEW_STALE')
          }
          if (
            receipt.v !== 1 ||
            !Number.isSafeInteger(receipt.createdAt) ||
            receipt.createdAt > timestamp ||
            timestamp - receipt.createdAt >= PUBLICATION_PREVIEW_TTL_MS
          )
            throw new ManagedError('PREVIEW_STALE')
          const state = await snapshot(tx, owner, ownerRow, id, value.expectedVersion, timestamp)
          const { v: _v, createdAt: _createdAt, ...binding } = receipt
          if (
            !equalSecret(
              digest(owner, id, binding, 'preview-binding'),
              digest(owner, id, state.binding, 'preview-binding')
            )
          )
            throw new ManagedError('PREVIEW_STALE')
          if (state.unchanged) {
            const existing = await tx.get(
              'SELECT id FROM managed_deployments WHERE owner_id = $1 AND group_id = $2 AND revision = $3',
              [owner, id, state.row.published_revision]
            )
            if (!existing) throw new ManagedError('DATA_UNREADABLE')
            return {
              group: publicGroup(state.row, ownerRow, true),
              deploymentId: existing.id,
              revision: state.row.published_revision,
              queued: 0,
              unchanged: true,
              replayed: false,
            }
          }
          if (state.empty && !value.allowEmpty)
            throw new ManagedError('EMPTY_PUBLICATION_CONFIRMATION')
          const revision = (state.row.published_revision ?? 0) + 1
          const deploymentId = randomUUID()
          await tx.run(
            'INSERT INTO managed_group_revisions (owner_id, group_id, revision, config_enc, payload_digest, explicit_empty, published_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [
              owner,
              id,
              revision,
              crypto.seal(state.addons, context(owner, id, `group-revision:${revision}`)),
              state.binding.payloadDigest,
              Number(state.empty),
              timestamp,
            ]
          )
          await tx.run(
            'UPDATE managed_groups SET published_revision = $1, version = version + 1, updated_at = $2 WHERE owner_id = $3 AND id = $4',
            [revision, timestamp, owner, id]
          )
          const cohort = []
          for (const account of state.members) {
            if (account.state !== 'active') continue
            await tx.run(
              'UPDATE managed_accounts SET policy_version = policy_version + 1, record_version = record_version + 1, updated_at = $1 WHERE owner_id = $2 AND id = $3',
              [timestamp, owner, account.id]
            )
            const updated = {
              ...account,
              policy_version: account.policy_version + 1,
              record_version: account.record_version + 1,
              updated_at: timestamp,
            }
            const job = await jobs.enqueueInTransaction(tx, updated, 'publish', timestamp)
            cohort.push({
              accountId: account.id,
              jobId: job.id,
              policyVersion: updated.policy_version,
              target: job.target,
            })
          }
          await tx.run(
            'INSERT INTO managed_deployments (id, owner_id, group_id, revision, cohort_enc, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [
              deploymentId,
              owner,
              id,
              revision,
              crypto.seal(
                {
                  members: cohort,
                  skipped: { staged: state.counts.staged, offboarding: state.counts.offboarding },
                },
                context(owner, deploymentId, 'deployment-cohort')
              ),
              timestamp,
            ]
          )
          await audit(
            tx,
            owner,
            'group.published',
            id,
            {
              deploymentId,
              revision,
              counts: state.counts,
              queued: cohort.length,
              explicitEmpty: state.empty,
            },
            timestamp
          )
          return {
            group: publicGroup(await group(tx, owner, id), ownerRow, true),
            deploymentId,
            revision,
            queued: cohort.length,
            unchanged: false,
            replayed: false,
          }
        })
      )
    },
    async getDeployment(auth, id) {
      const owner = await authorize(auth)
      const row = await db.get(
        'SELECT * FROM managed_deployments WHERE owner_id = $1 AND id = $2',
        [owner, id]
      )
      if (!row) throw new ManagedError('NOT_FOUND')
      const parsed = cohortSchema.safeParse(
        crypto.open(row.cohort_enc, context(owner, id, 'deployment-cohort'))
      )
      if (!parsed.success) throw new ManagedError('DATA_UNREADABLE')
      const cohort = parsed.data
      if (new Set(cohort.members.map((member) => member.jobId)).size !== cohort.members.length)
        throw new ManagedError('DATA_UNREADABLE')
      const ids = cohort.members.map((member) => member.jobId)
      const records = ids.length
        ? await db.query(
            `SELECT j.id, j.account_id, j.policy_version, j.target, j.state, j.error_code,
          a.policy_version AS current_policy FROM managed_jobs j JOIN managed_accounts a ON a.owner_id = j.owner_id AND a.id = j.account_id
          WHERE j.owner_id = $1 AND j.id IN (${ids.map((_, index) => `$${index + 2}`).join(', ')})`,
            [owner, ...ids]
          )
        : []
      const byId = new Map(records.map((job) => [job.id, job]))
      const counts = { pending: 0, running: 0, retrying: 0, verified: 0, failed: 0, superseded: 0 }
      const members = cohort.members.map((member) => {
        const job = byId.get(member.jobId)
        if (
          !job ||
          job.account_id !== member.accountId ||
          job.policy_version !== member.policyVersion ||
          job.target !== member.target
        )
          throw new ManagedError('DATA_UNREADABLE')
        const status =
          ['pending', 'retrying'].includes(job.state) && job.current_policy !== job.policy_version
            ? 'superseded'
            : job.state
        counts[status]++
        return { ...member, status, errorCode: job.error_code }
      })
      return {
        id,
        groupId: row.group_id,
        revision: row.revision,
        createdAt: row.created_at,
        counts,
        skipped: cohort.skipped,
        members,
      }
    },
  }
}
