import { createHash } from 'node:crypto'
import { z } from 'zod'
import { checkedCollection } from './projection.js'
import { ProviderFailure, retryAfterMilliseconds } from './worker.js'
import { ManagedError } from './errors.js'
import { EXPIRY_NOTICE_ADDON_ID } from '../../shared/expiry-notice.js'

const origin = 'https://api.nuvio.tv'
// Public client configuration published in nuvio.tv/docs/server-api.
const publishableKey = 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN'
const fail = () => {
  throw new ProviderFailure('DATA_UNREADABLE')
}
const digest = (value) => createHash('sha256').update(value).digest('hex')
export const profileNumber = z.number().int().min(1).max(6)
const profileRows = z
  .array(
    z.object({
      profile_index: profileNumber,
      name: z.string(),
      id: z.uuid(),
      uses_primary_addons: z.boolean(),
    })
  )
  .max(6)
const addonRows = z
  .array(
    z.object({
      url: z.string().min(1),
      name: z.string().nullable(),
      enabled: z.boolean(),
      sort_order: z.number().int(),
    })
  )
  .max(200)

export async function boundedJson(response, limit = 4 * 1024 * 1024) {
  if (!response.body) return fail()
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > limit) return fail()
    chunks.push(chunk)
  }
  if (!size) return null
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return fail()
  }
}

function descriptor(rawUrl, name, enabled) {
  const url = new URL(rawUrl)
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash)
    return fail()
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!/\/manifest\.json$/i.test(url.pathname))
    url.pathname = url.pathname.replace(/\/$/, '') + '/manifest.json'
  const id = /\/api\/notice\/[a-f0-9]{64}\/manifest\.json$/.test(url.pathname)
    ? EXPIRY_NOTICE_ADDON_ID
    : 'nuvio.' + digest(url.href)
  return {
    transportUrl: url.href,
    manifest: { id, name: name || url.hostname, version: '1.0.0' },
    flags: {
      enabled,
      ...([
        'https://catalog.nuvio.tv/manifest.json',
        'https://opensubtitles-v3.strem.io/manifest.json',
      ].includes(url.href)
        ? { protected: true }
        : {}),
    },
  }
}

// Compare only the fields Nuvio can actually store. Keep rich manifests in the manager's saved setup.
export function nuvioCollection(addons) {
  return checkedCollection(
    addons.map((a) => descriptor(a.transportUrl, a.manifest.name, a.flags?.enabled !== false))
  )
}

export function createNuvioProvider({
  fetch: transport = globalThis.fetch,
  now = Date.now,
  fetchManifest,
} = {}) {
  const sessions = new Map()
  async function call(path, token, body, options = {}) {
    await options.beforeDispatch?.()
    const timeout = AbortSignal.timeout(15_000)
    try {
      const response = await transport(origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        redirect: 'error',
        headers: {
          apikey: publishableKey,
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        signal: options.signal ? AbortSignal.any([timeout, options.signal]) : timeout,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 429)
          throw new ProviderFailure(
            'RATE_LIMITED',
            retryAfterMilliseconds(response.headers.get('retry-after'), now())
          )
        if (
          [401, 403].includes(response.status) ||
          (path.startsWith('/auth/') && [400, 422].includes(response.status))
        ) {
          if (token)
            for (const [key, entry] of sessions) if (entry.token === token) sessions.delete(key)
          throw new ProviderFailure('INVALID_CREDENTIALS')
        }
        throw new ProviderFailure(response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'INVALID_STATE')
      }
      return response.status === 204 ? null : await boundedJson(response)
    } catch (error) {
      if (error instanceof ProviderFailure || error instanceof ManagedError) throw error
      throw new ProviderFailure('NETWORK_ERROR')
    }
  }
  async function access(credentials, options) {
    const key = digest(JSON.stringify([credentials.email.toLowerCase(), credentials.password]))
    const cached = sessions.get(key)
    if (cached?.until > now()) return cached
    const result = await call(
      '/auth/v1/token?grant_type=password',
      null,
      { email: credentials.email, password: credentials.password },
      options
    )
    if (
      !z.uuid().safeParse(result?.user?.id).success ||
      !result.access_token ||
      result.user.email?.toLowerCase() !== credentials.email.toLowerCase()
    )
      return fail()
    const entry = {
      token: result.access_token,
      userId: result.user.id,
      until: now() + Math.min(Number(result.expires_in) || 0, 3600) * 1000 - 60_000,
    }
    if (sessions.size >= 256) sessions.delete(sessions.keys().next().value)
    sessions.set(key, entry)
    return entry
  }
  const rpc = (method, token, body, options) => call('/rest/v1/rpc/' + method, token, body, options)
  async function profiles(token, options) {
    const rows = profileRows.safeParse(await rpc('sync_pull_profiles', token, {}, options))
    if (!rows.success || new Set(rows.data.map((p) => p.profile_index)).size !== rows.data.length)
      return fail()
    return rows.data
  }
  async function inspect(credentials, options) {
    let grant = await access(credentials, options)
    let list
    try {
      list = await profiles(grant.token, options)
    } catch (error) {
      if (error.code !== 'INVALID_CREDENTIALS') throw error
      // A device sign-in may have invalidated our cached grant. Reauthenticate once.
      grant = await access(credentials, options)
      list = await profiles(grant.token, options)
    }
    const { token, userId } = grant
    if (!list.some((p) => p.profile_index === 1))
      list.unshift({ profile_index: 1, id: null, name: 'Primary', uses_primary_addons: false })
    return { token, userId, profiles: list }
  }
  async function login(credentials, options) {
    const data = await inspect(credentials, options)
    const slot = credentials.profileId ?? 1
    const profile = data.profiles.find((p) => p.profile_index === slot)
    if (!profile || (slot !== 1 && profile.uses_primary_addons))
      throw new ManagedError('NUVIO_PROFILE')
    const id = data.userId + ':' + (slot === 1 ? 'primary' : profile.id)
    if (credentials.id && credentials.id !== id) throw new ProviderFailure('IDENTITY_MISMATCH')
    return {
      platform: 'nuvio',
      profileId: slot,
      id,
      email: credentials.email,
      password: credentials.password,
    }
  }
  async function verifiedAccess(session, options) {
    await login(session, options)
    return (await access(session, options)).token
  }
  return {
    inspect,
    login,
    rpc,
    progressPage(token, profileId, offset, limit, options) {
      // PostgREST paginates the returned row set. The RPC itself has no offset parameter.
      return rpc(
        'sync_pull_watch_progress?order=id&limit=' + limit + '&offset=' + offset,
        token,
        { p_profile_id: profileId, p_since_last_watched: -1, p_limit: 100001 },
        options
      )
    },
    normalizeCollection: nuvioCollection,
    async register(credentials, options) {
      const data = await call(
        '/auth/v1/signup',
        null,
        { email: credentials.email, password: credentials.password },
        options
      )
      if (!data?.access_token) throw new ManagedError('NUVIO_CONFIRM_EMAIL')
    },
    async getIdentity(session, options) {
      return (await login(session, options)).id
    },
    async getCollection(session, options = {}) {
      const token = await verifiedAccess(session, options)
      const result = addonRows.safeParse(
        await call(
          '/rest/v1/addons?select=url,name,enabled,sort_order&profile_id=eq.' +
            session.profileId +
            '&user_id=eq.' +
            session.id.split(':')[0] +
            '&order=sort_order,id&limit=201',
          token,
          undefined,
          options
        )
      )
      if (!result.success) return fail()
      const addons = checkedCollection(result.data.map((a) => descriptor(a.url, a.name, a.enabled)))
      if (!options.hydrate) return addons
      for (const [index, addon] of addons.entries()) {
        const manifest =
          addon.transportUrl === options.expiryNotice?.transportUrl
            ? options.expiryNotice.manifest
            : await fetchManifest(addon.transportUrl, { signal: options.signal })
        addon.manifest = { ...manifest, name: result.data[index].name || manifest.name }
      }
      return addons
    },
    async setCollection(session, addons, options) {
      const token = await verifiedAccess(session, options)
      await rpc(
        'sync_push_addons',
        token,
        {
          p_profile_id: session.profileId,
          p_addons: nuvioCollection(addons).map((a, i) => ({
            url: a.transportUrl,
            name: a.manifest.name,
            enabled: a.flags.enabled,
            sort_order: i,
          })),
        },
        options
      )
    },
    close() {
      sessions.clear()
    },
  }
}
