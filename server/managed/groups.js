import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  parseAddonConfiguration,
  addonUrlIdentity,
  MAX_MANAGED_ADDONS,
  MAX_ADDON_CONFIG_BYTES,
} from '../../shared/addon-config.js'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { createGroupPublicationRepository } from './publication.js'
import { readAccountSetup } from './account-setup.js'
import { projectManagedCollection } from './projection.js'
import { emptyAccountOverrides } from '../../shared/account-addons.js'
import { lockGroupMembers } from './group-members.js'

const version = z.number().int().positive()
const draftInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  addons: z.unknown(),
  safeMode: z.boolean().nullable(),
})
const createInput = draftInput.extend({
  addons: z.unknown().default([]),
  safeMode: z.boolean().nullable().default(null),
})
const saveInput = draftInput.extend({ expectedVersion: version })
const publishChangesInput = saveInput.extend({ allowEmpty: z.boolean().default(false) })
const personalInput = z.strictObject({ expectedVersion: version, addons: z.unknown() })
const deleteInput = z.strictObject({ expectedVersion: version })
const assignmentInput = z.strictObject({
  groupId: z.uuid().nullable(),
  sourceGroupId: z.uuid().optional(),
  useGroupAddons: z.boolean().optional(),
  accounts: z
    .array(z.strictObject({ id: z.uuid(), expectedVersion: version }))
    .min(1)
    .max(200),
})
const context = (owner, id, purpose) => ({ owner, id, purpose })
const lock = (tx) => (tx.type === 'postgres' ? ' FOR UPDATE' : '')
const parse = (schema, input) => {
  const result = schema.safeParse(input)
  if (!result.success) throw new ManagedError('INVALID_INPUT')
  return result.data
}
const checkedAddons = (value) => {
  const result = parseAddonConfiguration(value)
  if (!result.ok) throw new ManagedError(result.code)
  return result.addons
}

/** Draft/assignment APIs are passive; publication needs an explicit trusted validator. */
export function createManagedGroupRepository({
  db,
  crypto,
  authorize,
  ownerTransaction,
  idempotent,
  publicAccount,
  jobs,
  validateManifests,
}) {
  const storedAddons = (blob, binding) => {
    const result = parseAddonConfiguration(crypto.open(blob, binding))
    if (!result.ok) throw new ManagedError('DATA_UNREADABLE')
    return result.addons
  }
  const draft = (row) => storedAddons(row.draft_enc, context(row.owner_id, row.id, 'group-draft'))
  const personal = (row) =>
    storedAddons(row.personal_enc, context(row.owner_id, row.id, 'personal-addons'))
  const same = (owner, id, purpose, first, second) =>
    equalSecret(
      crypto.fingerprint(first, context(owner, id, purpose)),
      crypto.fingerprint(second, context(owner, id, purpose))
    )

  async function group(connection, owner, id, locked = false) {
    const row = await connection.get(
      `SELECT * FROM managed_groups WHERE owner_id = $1 AND id = $2${locked ? lock(connection) : ''}`,
      [owner, id]
    )
    if (!row) throw new ManagedError('NOT_FOUND')
    return row
  }
  async function effectiveGroup(connection, row, state) {
    if (row.archived) throw new ManagedError('INVALID_STATE')
    if (row.published_revision === null) {
      if (state === 'active') throw new ManagedError('GROUP_NOT_PUBLISHED')
      return draft(row)
    }
    const revision = await connection.get(
      'SELECT config_enc, payload_digest FROM managed_group_revisions WHERE owner_id = $1 AND group_id = $2 AND revision = $3',
      [row.owner_id, row.id, row.published_revision]
    )
    if (!revision) throw new ManagedError('DATA_UNREADABLE')
    const addons = storedAddons(
      revision.config_enc,
      context(row.owner_id, row.id, `group-revision:${row.published_revision}`)
    )
    if (
      !equalSecret(
        revision.payload_digest,
        crypto.fingerprint(addons, context(row.owner_id, row.id, 'group-payload'))
      )
    )
      throw new ManagedError('DATA_UNREADABLE')
    return addons
  }
  // Both inputs have already passed checkedAddons/storedAddons. Compile shared
  // membership once so a large cohort does not repeatedly parse/copy its template.
  function layerGuard(groupAddons) {
    const identities = new Set(groupAddons.map((addon) => addonUrlIdentity(addon.transportUrl)))
    const groupBytes = Buffer.byteLength(JSON.stringify(groupAddons))
    return (personalAddons) => {
      const personalBytes = Buffer.byteLength(JSON.stringify(personalAddons))
      const totalBytes = !groupAddons.length
        ? personalBytes
        : !personalAddons.length
          ? groupBytes
          : groupBytes + personalBytes - 1
      if (
        groupAddons.length + personalAddons.length > MAX_MANAGED_ADDONS ||
        totalBytes > MAX_ADDON_CONFIG_BYTES
      )
        throw new ManagedError('ADDON_CONFIG_TOO_LARGE')
      if (personalAddons.some((addon) => identities.has(addonUrlIdentity(addon.transportUrl))))
        throw new ManagedError('ADDON_LAYER_CONFLICT')
    }
  }
  function compatible(groupAddons, personalAddons) {
    layerGuard(groupAddons)(personalAddons)
  }
  function publicGroup(row, ownerRow, includeDraft = false) {
    const addons = draft(row)
    return {
      id: row.id,
      name: crypto.open(row.name_enc, context(row.owner_id, row.id, 'group-name')),
      version: row.version,
      publishedRevision: row.published_revision,
      archived: row.archived === 1,
      safeMode: row.safe_mode === null ? null : row.safe_mode === 1,
      effectiveSafeMode: (row.safe_mode ?? ownerRow?.safe_mode ?? 1) === 1,
      addonCount: addons.length,
      ...(includeDraft ? { draft: addons } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
  async function audit(tx, owner, type, subject, detail, timestamp) {
    const id = randomUUID()
    await tx.run(
      'INSERT INTO managed_audit (id, owner_id, event_type, subject_id, detail_enc, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [id, owner, type, subject, crypto.seal(detail, context(owner, id, 'audit')), timestamp]
    )
  }

  async function saveDraftInTransaction(tx, owner, ownerRow, id, value, timestamp) {
    const row = await group(tx, owner, id, true)
    if (row.version !== value.expectedVersion) throw new ManagedError('VERSION_CONFLICT')
    if (row.archived) throw new ManagedError('INVALID_STATE')
    const old = {
      name: crypto.open(row.name_enc, context(owner, id, 'group-name')),
      addons: draft(row),
      safeMode: row.safe_mode === null ? null : row.safe_mode === 1,
    }
    const next = { name: value.name, addons: value.addons, safeMode: value.safeMode }
    if (same(owner, id, 'group-content', old, next))
      return { group: publicGroup(row, ownerRow, true), replayed: false }
    await tx.run(
      'UPDATE managed_groups SET name_enc = $1, draft_enc = $2, safe_mode = $3, version = version + 1, updated_at = $4 WHERE owner_id = $5 AND id = $6',
      [
        crypto.seal(value.name, context(owner, id, 'group-name')),
        crypto.seal(value.addons, context(owner, id, 'group-draft')),
        value.safeMode === null ? null : Number(value.safeMode),
        timestamp,
        owner,
        id,
      ]
    )
    await audit(
      tx,
      owner,
      'group.draft-saved',
      id,
      { version: row.version + 1, addonCount: value.addons.length, safeMode: value.safeMode },
      timestamp
    )
    return { group: publicGroup(await group(tx, owner, id), ownerRow, true), replayed: false }
  }

  return {
    ...createGroupPublicationRepository({
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
      saveDraftInTransaction,
      parseChanges: (input) => {
        const value = parse(publishChangesInput, input)
        return { ...value, addons: checkedAddons(value.addons) }
      },
    }),
    async createGroup(auth, input, key) {
      const value = parse(createInput, input)
      value.addons = checkedAddons(value.addons)
      return ownerTransaction(auth, (tx, owner, ownerRow, timestamp) =>
        idempotent(tx, owner, 'groups.create', key, value, timestamp, async () => {
          const id = randomUUID()
          await tx.run(
            'INSERT INTO managed_groups (id, owner_id, name_enc, draft_enc, safe_mode, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)',
            [
              id,
              owner,
              crypto.seal(value.name, context(owner, id, 'group-name')),
              crypto.seal(value.addons, context(owner, id, 'group-draft')),
              value.safeMode === null ? null : Number(value.safeMode),
              timestamp,
            ]
          )
          await audit(
            tx,
            owner,
            'group.created',
            id,
            { addonCount: value.addons.length },
            timestamp
          )
          return { group: publicGroup(await group(tx, owner, id), ownerRow, true), replayed: false }
        })
      )
    },
    async saveGroupDraft(auth, id, input, key) {
      const value = parse(saveInput, input)
      value.addons = checkedAddons(value.addons)
      return ownerTransaction(auth, (tx, owner, ownerRow, timestamp) =>
        idempotent(tx, owner, 'groups.draft', key, { id, ...value }, timestamp, async () => {
          return saveDraftInTransaction(tx, owner, ownerRow, id, value, timestamp)
        })
      )
    },
    async getGroup(auth, id) {
      const owner = await authorize(auth)
      return publicGroup(
        await group(db, owner, id),
        await db.get('SELECT safe_mode FROM managed_owners WHERE owner_id = $1', [owner]),
        true
      )
    },
    async deleteGroup(auth, id, input, key) {
      const value = parse(deleteInput, input)
      return ownerTransaction(auth, (tx, owner, _ownerRow, timestamp) =>
        idempotent(tx, owner, 'groups.delete', key, { id, ...value }, timestamp, async () => {
          const row = await group(tx, owner, id, true)
          if (row.version !== value.expectedVersion) throw new ManagedError('VERSION_CONFLICT')
          if (row.archived) throw new ManagedError('NOT_FOUND')
          const members = await tx.query(
            `SELECT * FROM managed_accounts WHERE owner_id = $1 AND group_id = $2 ORDER BY id LIMIT 1001${lock(tx)}`,
            [owner, id]
          )
          if (members.length > 1000) throw new ManagedError('GROUP_TOO_LARGE')
          for (const account of members) {
            // Materialize the effective setup before archiving the shared template.
            // Disabled preferences and account overrides survive expiry and deletion.
            const setup = await readAccountSetup(tx, account, crypto)
            const individual = projectManagedCollection({
              ...setup,
              remote: [],
              target: 'active',
            }).configuration
            await tx.run(
              `UPDATE managed_accounts SET group_id = NULL, personal_enc = $1,
              addon_overrides_enc = $2, addons_initialized = 1,
              record_version = record_version + 1, policy_version = policy_version + 1,
              updated_at = $3 WHERE owner_id = $4 AND id = $5`,
              [
                crypto.seal(individual, context(owner, account.id, 'personal-addons')),
                crypto.seal(
                  emptyAccountOverrides(),
                  context(owner, account.id, 'account-addon-overrides')
                ),
                timestamp,
                owner,
                account.id,
              ]
            )
            if (account.state !== 'staged') {
              const updated = await tx.get(
                'SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2',
                [owner, account.id]
              )
              await jobs.enqueueInTransaction(tx, updated, 'assignment', timestamp)
            }
          }
          // Keep immutable revisions and rollout history for audit/restore.
          await tx.run(
            'UPDATE managed_groups SET archived = 1, version = version + 1, updated_at = $1 WHERE owner_id = $2 AND id = $3',
            [timestamp, owner, id]
          )
          await audit(
            tx,
            owner,
            'group.deleted',
            id,
            { detachedAccounts: members.length },
            timestamp
          )
          return { id, detachedAccounts: members.length, replayed: false }
        })
      )
    },
    async listGroups(auth, { limit = 100, after = '' } = {}) {
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 200 ||
        typeof after !== 'string' ||
        (after && !z.uuid().safeParse(after).success)
      )
        throw new ManagedError('INVALID_INPUT')
      const owner = await authorize(auth)
      const ownerRow = await db.get('SELECT safe_mode FROM managed_owners WHERE owner_id = $1', [
        owner,
      ])
      const rows = await db.query(
        'SELECT * FROM managed_groups WHERE owner_id = $1 AND archived = 0 AND id > $2 ORDER BY id LIMIT $3',
        [owner, after, limit + 1]
      )
      return {
        groups: rows.slice(0, limit).map((row) => publicGroup(row, ownerRow)),
        nextCursor: rows.length > limit ? rows[limit - 1].id : null,
      }
    },
    async getPersonalAddons(auth, id) {
      const owner = await authorize(auth)
      const row = await db.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
        owner,
        id,
      ])
      if (!row) throw new ManagedError('NOT_FOUND')
      return { account: publicAccount(row), addons: personal(row) }
    },
    async setPersonalAddons(auth, id, input, key) {
      const value = parse(personalInput, input)
      value.addons = checkedAddons(value.addons)
      return ownerTransaction(auth, (tx, owner, _ownerRow, timestamp) =>
        idempotent(tx, owner, 'accounts.personal', key, { id, ...value }, timestamp, async () => {
          const row = await tx.get(
            `SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2${lock(tx)}`,
            [owner, id]
          )
          if (!row) throw new ManagedError('NOT_FOUND')
          if (row.record_version !== value.expectedVersion)
            throw new ManagedError('VERSION_CONFLICT')
          if (row.state === 'offboarding') throw new ManagedError('INVALID_STATE')
          if (row.group_id)
            compatible(
              await effectiveGroup(tx, await group(tx, owner, row.group_id), row.state),
              value.addons
            )
          if (same(owner, id, 'personal-content', personal(row), value.addons))
            return {
              account: publicAccount(row),
              addons: value.addons,
              jobId: null,
              replayed: false,
            }
          await tx.run(
            'UPDATE managed_accounts SET personal_enc = $1, record_version = record_version + 1, policy_version = policy_version + 1, updated_at = $2 WHERE owner_id = $3 AND id = $4',
            [crypto.seal(value.addons, context(owner, id, 'personal-addons')), timestamp, owner, id]
          )
          const updated = await tx.get(
            'SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2',
            [owner, id]
          )
          const job =
            updated.state === 'active'
              ? await jobs.enqueueInTransaction(tx, updated, 'personal', timestamp)
              : null
          await audit(
            tx,
            owner,
            'account.personal-saved',
            id,
            {
              version: updated.record_version,
              addonCount: value.addons.length,
              jobId: job?.id ?? null,
            },
            timestamp
          )
          return {
            account: publicAccount(updated),
            addons: value.addons,
            jobId: job?.id ?? null,
            replayed: false,
          }
        })
      )
    },
    async assignGroup(auth, input, key) {
      const value = parse(assignmentInput, input)
      if (new Set(value.accounts.map((row) => row.id)).size !== value.accounts.length)
        throw new ManagedError('INVALID_INPUT')
      value.accounts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return ownerTransaction(auth, (tx, owner, _ownerRow, timestamp) =>
        idempotent(tx, owner, 'accounts.assign-group', key, value, timestamp, async () => {
          if (value.sourceGroupId)
            await lockGroupMembers(tx, owner, value.sourceGroupId, value.accounts)
          const destination = value.groupId ? await group(tx, owner, value.groupId, true) : null
          if (destination?.archived) throw new ManagedError('INVALID_STATE')
          // Decode the shared configuration once, not once for every member.
          const destinationAddons = destination
            ? await effectiveGroup(tx, destination, 'staged')
            : null
          const destinationGuard = destinationAddons ? layerGuard(destinationAddons) : null
          const accounts = []
          for (const expected of value.accounts) {
            const row = await tx.get(
              `SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2${lock(tx)}`,
              [owner, expected.id]
            )
            if (!row) throw new ManagedError('NOT_FOUND')
            if (row.record_version !== expected.expectedVersion)
              throw new ManagedError('VERSION_CONFLICT')
            if (row.state === 'offboarding') throw new ManagedError('INVALID_STATE')
            if (destination && row.state === 'active' && destination.published_revision === null)
              throw new ManagedError('GROUP_NOT_PUBLISHED')
            if (destinationGuard && !value.useGroupAddons) destinationGuard(personal(row))
            if (row.group_id === value.groupId) {
              accounts.push({ account: publicAccount(row), jobId: null })
              continue
            }
            if (!destination) {
              const setup = await readAccountSetup(tx, row, crypto)
              const individual = projectManagedCollection({
                ...setup,
                remote: [],
                target: 'active',
              }).configuration
              await tx.run(
                'UPDATE managed_accounts SET personal_enc = $1, addon_overrides_enc = $2, addons_initialized = 1 WHERE owner_id = $3 AND id = $4',
                [
                  crypto.seal(individual, context(owner, row.id, 'personal-addons')),
                  crypto.seal(
                    emptyAccountOverrides(),
                    context(owner, row.id, 'account-addon-overrides')
                  ),
                  owner,
                  row.id,
                ]
              )
            } else if (value.useGroupAddons) {
              const groupUrls = new Set(
                destinationAddons.map((addon) => addonUrlIdentity(addon.transportUrl))
              )
              const additions = personal(row).filter(
                (addon) => !groupUrls.has(addonUrlIdentity(addon.transportUrl))
              )
              await tx.run(
                'UPDATE managed_accounts SET personal_enc = $1, addon_overrides_enc = $2 WHERE owner_id = $3 AND id = $4',
                [
                  crypto.seal(additions, context(owner, row.id, 'personal-addons')),
                  crypto.seal(
                    emptyAccountOverrides(),
                    context(owner, row.id, 'account-addon-overrides')
                  ),
                  owner,
                  row.id,
                ]
              )
            }
            await tx.run(
              'UPDATE managed_accounts SET group_id = $1, record_version = record_version + 1, policy_version = policy_version + 1, updated_at = $2 WHERE owner_id = $3 AND id = $4',
              [value.groupId, timestamp, owner, row.id]
            )
            const updated = await tx.get(
              'SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2',
              [owner, row.id]
            )
            const job =
              updated.state === 'active'
                ? await jobs.enqueueInTransaction(tx, updated, 'assignment', timestamp)
                : null
            accounts.push({ account: publicAccount(updated), jobId: job?.id ?? null })
          }
          await audit(
            tx,
            owner,
            'accounts.group-assigned',
            value.groupId ?? owner,
            { accountIds: accounts.map((entry) => entry.account.id), groupId: value.groupId },
            timestamp
          )
          return { accounts, replayed: false }
        })
      )
    },
  }
}
