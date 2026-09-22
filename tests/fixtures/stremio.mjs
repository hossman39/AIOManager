import { stremioCollection } from '../../server/managed/stremio.js'

/** Synthetic fixed-origin API, shared by integration tests and the local demo. */
export function fakeStremio(users = []) {
  const accounts = new Map(
    users.map(({ email, password, addons = [] }, index) => [
      email.toLowerCase(),
      {
        email,
        password,
        id: `synthetic-stremio-${index}`,
        authKey: `synthetic-session-${index}`,
        addons: stremioCollection(addons),
      },
    ])
  )
  const calls = [],
    hooks = {}
  const response = (result) => Response.json({ result })
  const fetch = async (url, options) => {
    if (!url.startsWith('https://api.strem.io/api/') || options.method !== 'POST')
      throw new Error('Synthetic provider only')
    const body = JSON.parse(options.body)
    calls.push({ type: body.type, body: structuredClone(body), signal: options.signal })
    await hooks.before?.(body, options)
    await options.signal?.throwIfAborted()
    if (body.type === 'Auth') {
      const user = accounts.get(body.email.toLowerCase())
      if (!user || user.password !== body.password)
        return Response.json({ error: { code: 1, message: 'Synthetic rejected login' } })
      return response({ authKey: user.authKey, user: { _id: user.id, email: user.email } })
    }
    const user = [...accounts.values()].find((user) => user.authKey === body.authKey)
    if (!user) return Response.json({ error: { code: 1, message: 'Synthetic invalid session' } })
    if (body.type === 'GetUser') return response({ _id: user.id, email: user.email })
    if (body.type === 'AddonCollectionGet')
      return response({ addons: structuredClone(user.addons), lastModified: 1 })
    if (body.type === 'AddonCollectionSet') {
      user.addons = structuredClone(body.addons)
      const overridden = await hooks.afterSet?.(body, options)
      return overridden ?? response({ success: true })
    }
    if (body.type === 'DatastoreGet') return response({ library: [] })
    if (body.type === 'DatastorePut') return response({ success: true })
    throw new Error('Unsupported synthetic API method')
  }
  return { accounts, calls, hooks, fetch }
}
