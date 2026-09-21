import { z } from 'zod'
import { accountSetupChanges, sameAddonSetup } from '../../shared/account-addons.js'
import { checkedCollection, projectManagedCollection, providerCollection } from './projection.js'
import { stremioCollection } from './stremio.js'
import { readAccountSetup } from './account-setup.js'
import { providerIdentityKey } from './execution.js'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { parseAddonConfiguration } from '../../shared/addon-config.js'
import { isExpiryNotice } from '../../shared/expiry-notice.js'

const saveSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  groupVersion: z.number().int().positive().nullable(),
  addons: z.unknown(),
  allowEmpty: z.boolean().default(false),
})
const binding = (row, purpose) => ({ owner: row.owner_id, id: row.id, purpose })

export function createAccountAddonRepository({
  db,
  crypto,
  authorize,
  ownerTransaction,
  idempotent,
  publicAccount,
  jobs,
  runtime,
}) {
  const get = async (tx, owner, id) => {
    const row = await tx.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
      owner,
      id,
    ])
    if (!row) throw new ManagedError('NOT_FOUND')
    return row
  }
  const readRemote = async (row) => {
    if (!runtime?.enabled) throw new ManagedError('WRITE_PAUSED')
    return runtime.exclusive(async () => {
      const session = await runtime.provider.login(
        crypto.open(row.credentials_enc, binding(row, 'credentials'))
      )
      const key = providerIdentityKey(crypto, session.id)
      if (row.provider_key && !equalSecret(row.provider_key, key))
        throw new ManagedError('IDENTITY_MISMATCH')
      if (!row.provider_key) {
        const existing = await db.get('SELECT id FROM managed_accounts WHERE provider_key = $1', [
          key,
        ])
        if (
          (existing && existing.id !== row.id) ||
          (await db.get('SELECT account_id FROM managed_offboarded WHERE provider_key = $1', [key]))
        )
          throw new ManagedError('MANAGED_ACCOUNT')
      }
      const observed = await runtime.provider.getCollection(session)
      const current = await get(db, row.owner_id, row.id)
      if (current.record_version !== row.record_version) throw new ManagedError('VERSION_CONFLICT')
      return checkedCollection(observed)
    })
  }
  const response = (row, setup, addons, installed = null, source = 'saved') => ({
    account: publicAccount(row),
    addons,
    groupAddons: setup.group,
    groupVersion: setup.groupVersion,
    groupName: setup.groupName,
    overrides: setup.accountOverrides,
    source,
    installed,
    installedAt: installed === null ? null : Date.now(),
    savedMatchesInstalled:
      installed === null
        ? null
        : sameAddonSetup(installed, stremioCollection(providerCollection(addons))),
  })
  return {
    async getAccountAddons(auth, id, { live = false } = {}) {
      const owner = await authorize(auth),
        row = await get(db, owner, id)
      const setup = await readAccountSetup(db, row, crypto)
      const initial =
        setup.individual &&
        row.state === 'staged' &&
        !row.addons_initialized &&
        setup.personal.length === 0
      const installed = initial || live ? await readRemote(row) : null
      const addons = initial
        ? installed.filter((addon) => !isExpiryNotice(addon))
        : projectManagedCollection({ ...setup, remote: [], target: 'active' }).configuration
      return response(row, setup, addons, installed, initial ? 'stremio' : 'saved')
    },
    async setAccountAddons(auth, id, input, key) {
      const parsed = saveSchema.safeParse(input)
      if (!parsed.success) throw new ManagedError('INVALID_INPUT')
      const value = parsed.data
      const configuration = parseAddonConfiguration(value.addons)
      if (!configuration.ok) throw new ManagedError(configuration.code)
      value.addons = configuration.addons
      if (value.addons.some(isExpiryNotice)) throw new ManagedError('INVALID_ADDON_CONFIG')
      if (!value.addons.some((addon) => addon.flags?.enabled !== false) && !value.allowEmpty)
        throw new ManagedError('EMPTY_PUBLICATION_CONFIRMATION')
      return ownerTransaction(auth, (tx, owner, _settings, timestamp) =>
        idempotent(tx, owner, 'accounts.addons', key, { id, ...value }, timestamp, async () => {
          const row = await get(tx, owner, id)
          if (row.record_version !== value.expectedVersion)
            throw new ManagedError('VERSION_CONFLICT')
          if (row.state === 'offboarding') throw new ManagedError('INVALID_STATE')
          const setup = await readAccountSetup(tx, row, crypto)
          if (setup.groupVersion !== value.groupVersion) throw new ManagedError('VERSION_CONFLICT')
          const changes = accountSetupChanges(setup.group, value.addons)
          if (!changes.ok) throw new ManagedError(changes.code)
          if (
            row.addons_initialized &&
            sameAddonSetup(changes.personal, setup.personal) &&
            sameAddonSetup(changes.overrides, setup.accountOverrides)
          ) {
            return { ...response(row, setup, value.addons), jobId: null, replayed: false }
          }
          await tx.run(
            'UPDATE managed_accounts SET personal_enc = $1, addon_overrides_enc = $2, addons_initialized = 1, record_version = record_version + 1, policy_version = policy_version + 1, updated_at = $3 WHERE owner_id = $4 AND id = $5',
            [
              crypto.seal(changes.personal, binding(row, 'personal-addons')),
              crypto.seal(changes.overrides, binding(row, 'account-addon-overrides')),
              timestamp,
              owner,
              id,
            ]
          )
          const updated = await get(tx, owner, id)
          const job =
            updated.state === 'active'
              ? await jobs.enqueueInTransaction(tx, updated, 'personal', timestamp)
              : null
          return {
            ...response(
              updated,
              { ...setup, personal: changes.personal, accountOverrides: changes.overrides },
              value.addons
            ),
            jobId: job?.id ?? null,
            replayed: false,
          }
        })
      )
    },
  }
}
