import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ManagedError } from './errors.js'
import { profileNumber } from './nuvio.js'
import { historyCandidates, confirmHistory, mergeHistory, readHistory } from './nuvio-history.js'
import { providerIdentityKey } from './execution.js'
import { equalSecret } from './crypto.js'
import { isExpiryNotice } from '../../shared/expiry-notice.js'
import { readAccountSetup } from './account-setup.js'
import { lockAccountSelection } from './group-members.js'

const loginBody = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(4096),
})
const historyBody = z.union([
  z.strictObject({ sourceId: z.uuid(), profileId: profileNumber }),
  z.strictObject({ login: loginBody, profileId: profileNumber }),
])
const parse = (schema, value) => {
  const result = schema.safeParse(value)
  if (!result.success) throw new ManagedError('INVALID_INPUT')
  return result.data
}
const binding = (owner, id, purpose) => ({ owner, id, purpose })
function isStremioLocalFiles(url) {
  const { hostname, pathname } = new URL(url)
  return (
    ['127.0.0.1', 'localhost', '[::1]'].includes(hostname) &&
    /^\/local-addon(?:\/manifest\.json)?\/?$/.test(pathname)
  )
}
export function createNuvioAccounts({
  db,
  crypto,
  jobs,
  authorize,
  ownerTransaction,
  idempotent,
  publicAccount,
  runtime,
  now,
}) {
  const driver = runtime?.nuvio
  const previews = new Map()
  const credentials = (row) =>
    crypto.open(row.credentials_enc, binding(row.owner_id, row.id, 'credentials'))
  async function account(owner, id) {
    const row = await db.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
      owner,
      id,
    ])
    if (!row || row.state === 'offboarding') throw new ManagedError('NOT_FOUND')
    return row
  }
  async function writable(owner) {
    const paused = await db.get('SELECT write_paused FROM managed_owners WHERE owner_id = $1', [
      owner,
    ])
    const status = await runtime.status()
    if (!runtime.enabled || status.writePaused || paused?.write_paused !== 0)
      throw new ManagedError('WRITE_PAUSED')
  }
  const publicProfiles = (data) =>
    data.profiles.map((p) => ({
      id: p.profile_index,
      name: p.name,
      inherits: p.profile_index !== 1 && p.uses_primary_addons,
    }))
  async function destination(owner, id, profileId, options) {
    const row = await account(owner, id)
    const saved = credentials(row)
    if (saved.platform !== 'nuvio') throw new ManagedError('INVALID_INPUT')
    const info = await driver.inspect(saved, options)
    if (!saved.id?.startsWith(info.userId + ':')) throw new ManagedError('IDENTITY_MISMATCH')
    const profile = info.profiles.find((p) => p.profile_index === profileId)
    if (!profile) throw new ManagedError('NUVIO_PROFILE')
    return { token: info.token, profileKey: info.userId + ':' + (profile.id ?? 'primary') }
  }
  async function stremioSession(row, login, options) {
    if (login.platform === 'nuvio') throw new ManagedError('INVALID_INPUT')
    const session = await runtime.provider.login(login, options)
    if (
      session.email.toLowerCase() !== login.email.toLowerCase() ||
      (row?.provider_key && !equalSecret(row.provider_key, providerIdentityKey(crypto, session.id)))
    )
      throw new ManagedError('IDENTITY_MISMATCH')
    return session
  }
  async function storeProfile(auth, owner, value, session, key, conversion) {
    return ownerTransaction(auth, (tx, currentOwner, settings, at) =>
      idempotent(
        tx,
        currentOwner,
        conversion ? 'accounts.nuvio-convert' : 'accounts.nuvio-connect',
        key,
        value,
        at,
        async () => {
          if (conversion && settings.write_paused !== 0) throw new ManagedError('WRITE_PAUSED')
          const emailKey = crypto.fingerprint(
            [value.email.toLowerCase(), value.profileId],
            binding(owner, 'nuvio-email', 'lookup')
          )
          const existing = await tx.get(
            'SELECT * FROM managed_accounts WHERE owner_id=$1 AND email_key=$2',
            [owner, emailKey]
          )
          if (existing) {
            if (credentials(existing).id !== session.id) throw new ManagedError('IDENTITY_MISMATCH')
            if (existing.state === 'offboarding') throw new ManagedError('INVALID_STATE')
            if (!conversion) {
              if (value.copyFrom) throw new ManagedError('ACCOUNT_EXISTS')
              return { account: publicAccount(existing) }
            }
            if (credentials(existing).convertedFrom === value.copyFrom.id)
              return { account: publicAccount(existing) }
            const target = publicAccount(existing)
            if (
              target.version !== 1 ||
              target.state !== 'staged' ||
              target.setupSaved ||
              target.membershipType !== 'unset'
            )
              return { account: target, keptSetup: true }
          }
          const providerKey = providerIdentityKey(crypto, session.id, 'nuvio')
          if (
            await tx.get('SELECT account_id FROM managed_offboarded WHERE provider_key=$1', [
              providerKey,
            ])
          )
            throw new ManagedError('MANAGED_ACCOUNT')
          if (
            conversion &&
            (await tx.get('SELECT id FROM managed_accounts WHERE provider_key=$1', [providerKey]))
          )
            throw new ManagedError('MANAGED_ACCOUNT')
          const id = existing?.id ?? randomUUID()
          const seal = (v, purpose) => crypto.seal(v, binding(owner, id, purpose))
          const savedLogin = seal(
            {
              ...session,
              name: value.name || value.email,
              ...(conversion && { convertedFrom: value.copyFrom.id }),
            },
            'credentials'
          )
          if (existing) {
            await tx.run(
              'UPDATE managed_accounts SET credentials_enc=$1, record_version=record_version+1, policy_version=policy_version+1, updated_at=$2 WHERE id=$3',
              [savedLogin, at, id]
            )
          } else {
            await tx.run(
              `INSERT INTO managed_accounts
              (id,owner_id,email_key,credentials_enc,personal_enc,configuration_enc,created_at,updated_at)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
              [
                id,
                owner,
                emailKey,
                savedLogin,
                seal([], 'personal-addons'),
                seal([], 'configuration'),
                at,
              ]
            )
          }
          if (value.copyFrom) {
            const [source] = await lockAccountSelection(tx, owner, [value.copyFrom])
            if (credentials(source).platform === 'nuvio') throw new ManagedError('INVALID_INPUT')
            await tx.run(
              `UPDATE managed_accounts AS dest SET
               group_id = src.group_id, group_sync_requested = CASE WHEN src.group_id IS NULL THEN 0 ELSE 1 END,
               lifetime = src.lifetime, expiry_at = src.expiry_at, expiry_local = src.expiry_local,
               expiry_offset = src.expiry_offset, expiry_timezone = src.expiry_timezone,
               expiry_zone = src.expiry_zone, expiry_zone_offset = src.expiry_zone_offset,
               access_override = src.access_override, suspended_at = src.suspended_at
             FROM managed_accounts AS src
             WHERE dest.id = $1 AND src.id = $2 AND dest.owner_id = $3 AND src.owner_id = $3`,
              [id, source.id, owner]
            )
            if (conversion) {
              const setup = await readAccountSetup(tx, source, crypto)
              const portable = (addons) =>
                addons.filter(
                  (addon) => !isStremioLocalFiles(addon.transportUrl) && !isExpiryNotice(addon)
                )
              const overrides = {
                ...setup.accountOverrides,
                addons: portable(setup.accountOverrides.addons),
                removed: [
                  ...new Set([
                    ...setup.accountOverrides.removed,
                    ...setup.group
                      .filter((addon) => isStremioLocalFiles(addon.transportUrl))
                      .map((addon) => addon.transportUrl),
                  ]),
                ],
              }
              await tx.run(
                `UPDATE managed_accounts SET personal_enc=$1, addon_overrides_enc=$2,
                configuration_enc=$3, addons_initialized=$4, safe_mode=$5 WHERE id=$6`,
                [
                  seal(portable(conversion.liveAddons ?? setup.personal), 'personal-addons'),
                  seal(overrides, 'account-addon-overrides'),
                  seal(portable(setup.saved), 'configuration'),
                  source.group_id ? source.addons_initialized : 1,
                  source.safe_mode,
                  id,
                ]
              )
            }
            const auditId = randomUUID()
            await tx.run(
              'INSERT INTO managed_audit (id,owner_id,event_type,subject_id,detail_enc,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
              [
                auditId,
                owner,
                'account.membership-copied',
                id,
                crypto.seal(
                  {
                    sourceId: source.id,
                    sourceVersion: source.record_version,
                    groupId: source.group_id,
                  },
                  binding(owner, auditId, 'audit')
                ),
                at,
              ]
            )
          }
          const row = await tx.get('SELECT * FROM managed_accounts WHERE id=$1', [id])
          if (value.copyFrom) await jobs.enqueuePolicyChange(tx, row, 'assignment', at)
          return { account: publicAccount(row) }
        }
      )
    )
  }
  return {
    async nuvioProfiles(auth, input, register = false) {
      const owner = await authorize(auth)
      const login = parse(loginBody, input)
      if (!runtime?.enabled) throw new ManagedError('WRITE_PAUSED')
      if (register)
        await runtime.exclusive(async () => {
          await writable(owner)
          await driver.register(login)
        })
      return { profiles: publicProfiles(await driver.inspect(login)) }
    },
    async connectNuvio(auth, input, key) {
      const value = parse(
        loginBody.extend({
          profileId: profileNumber,
          name: z.string().trim().max(120),
          copyFrom: z
            .strictObject({ id: z.uuid(), expectedVersion: z.number().int().positive() })
            .optional(),
        }),
        input
      )
      const owner = await authorize(auth)
      if (!runtime?.enabled) throw new ManagedError('WRITE_PAUSED')
      const session = await driver.login(value)
      return storeProfile(auth, owner, value, session, key)
    },
    async convertToNuvio(auth, id, input, key) {
      const owner = await authorize(auth)
      const { expectedVersion } = parse(
        z.strictObject({ expectedVersion: z.number().int().positive() }),
        input
      )
      if (!runtime?.enabled) throw new ManagedError('WRITE_PAUSED')
      return runtime.exclusive(async () => {
        await writable(owner)
        const source = await account(owner, id)
        if (source.record_version !== expectedVersion) throw new ManagedError('VERSION_CONFLICT')
        const login = credentials(source)
        const from = await stremioSession(source, login)
        const value = {
          email: login.email,
          password: login.password,
          name: login.name || login.email,
          profileId: 1,
          copyFrom: { id, expectedVersion },
        }
        const emailKey = crypto.fingerprint(
          [login.email.toLowerCase(), 1],
          binding(owner, 'nuvio-email', 'lookup')
        )
        const existing = await db.get(
          'SELECT * FROM managed_accounts WHERE owner_id=$1 AND email_key=$2',
          [owner, emailKey]
        )
        if (existing?.state === 'offboarding') throw new ManagedError('INVALID_STATE')
        if (existing && credentials(existing).convertedFrom === id)
          return { account: publicAccount(existing) }
        let liveAddons
        if (!source.group_id && !source.addons_initialized && source.state === 'staged') {
          liveAddons = await runtime.provider.getCollection(from)
        }
        const options = { beforeDispatch: () => writable(owner) }
        const session = existing
          ? await driver.login(value, options)
          : await driver.connectOrRegister(value, options)
        await writable(owner)
        return storeProfile(auth, owner, value, session, key, { liveAddons })
      })
    },
    async historyProfiles(auth, id) {
      const owner = await authorize(auth)
      const saved = credentials(await account(owner, id))
      if (saved.platform !== 'nuvio' || !runtime?.enabled) throw new ManagedError('INVALID_STATE')
      const data = await driver.inspect(saved)
      if (!saved.id.startsWith(data.userId + ':')) throw new ManagedError('IDENTITY_MISMATCH')
      return { profiles: publicProfiles(data) }
    },
    async previewNuvioHistory(auth, id, input, { signal } = {}) {
      const owner = await authorize(auth)
      if (!runtime?.enabled) throw new ManagedError('WRITE_PAUSED')
      const { sourceId, login, profileId } = parse(historyBody, input)
      const { token, profileKey } = await destination(owner, id, profileId, { signal })
      const source = sourceId ? await account(owner, sourceId) : null
      const session = await stremioSession(source, source ? credentials(source) : login, { signal })
      const data = await runtime.raw(
        'DatastoreGet',
        { collection: 'libraryItem', all: true, authKey: session.authKey },
        { signal }
      )
      const candidates = await historyCandidates(
        Array.isArray(data.result) ? data.result : data.result?.library,
        { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180_000)]) : undefined }
      )
      const plan = mergeHistory(candidates, await readHistory(driver, token, profileId, { signal }))
      const preview = randomUUID()
      for (const [k, v] of previews)
        if (v.expires <= now() || (v.owner === owner && v.id === id)) previews.delete(k)
      if (previews.size >= 32 || JSON.stringify(plan).length > 8 * 1024 * 1024)
        throw new ManagedError('REQUEST_TOO_LARGE')
      previews.set(preview, {
        owner,
        id,
        sourceId,
        profileId,
        profileKey,
        plan,
        expires: now() + 600_000,
      })
      return {
        preview,
        watched: plan.watched.length,
        progress: plan.progress.length,
        skipped: plan.skipped.slice(0, 40),
        skippedCount: plan.skipped.length,
      }
    },
    async applyNuvioHistory(auth, id, input) {
      const owner = await authorize(auth)
      const { preview } = parse(z.strictObject({ preview: z.uuid() }), input)
      const job = previews.get(preview)
      if (!job || job.owner !== owner || job.id !== id || job.expires <= now())
        throw new ManagedError('PREVIEW_STALE')
      if (job.result) return job.result
      if (job.running) return job.running
      async function grant() {
        if (previews.get(preview) !== job) throw new ManagedError('PREVIEW_STALE')
        const { token, profileKey } = await destination(owner, id, job.profileId)
        if (profileKey !== job.profileKey) throw new ManagedError('PREVIEW_STALE')
        return token
      }
      async function importEntries() {
        await writable(owner)
        if (job.sourceId) await account(owner, job.sourceId)
        const plan = mergeHistory(job.plan, await readHistory(driver, await grant(), job.profileId))
        for (const [rows, method, field] of [
          [plan.watched, 'sync_push_watched_items', 'p_items'],
          [plan.progress, 'sync_push_watch_progress', 'p_entries'],
        ]) {
          for (let i = 0; i < rows.length; i += 200) {
            // Release the writer between batches so a large import can coexist with expiry jobs.
            await runtime.exclusive(async () => {
              await writable(owner)
              await driver.rpc(
                method,
                await grant(),
                { p_profile_id: job.profileId, [field]: rows.slice(i, i + 200) },
                { beforeDispatch: () => writable(owner) }
              )
            })
          }
        }
        const result = confirmHistory(
          job.plan,
          await readHistory(driver, await grant(), job.profileId)
        )
        if (!result.unconfirmed) job.result = result
        return result
      }
      job.running = importEntries().finally(() => {
        delete job.running
      })
      return job.running
    },
  }
}
