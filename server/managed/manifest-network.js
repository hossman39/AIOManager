import { Resolver } from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { promisify } from 'node:util'
import { gunzip, inflate, brotliDecompress } from 'node:zlib'
import ipaddr from 'ipaddr.js'
import { addonUrlIdentity } from '../../shared/addon-config.js'
import { ManagedError } from './errors.js'

const globalV6 = ipaddr.parseCIDR('2000::/3')
const documentationV6 = ipaddr.parseCIDR('3fff::/20')
const decompress = {
  gzip: promisify(gunzip),
  deflate: promisify(inflate),
  br: promisify(brotliDecompress),
}
const unsafe = () => new ManagedError('MANIFEST_UNSAFE_URL')
const unavailable = () => new ManagedError('MANIFEST_UNAVAILABLE')
const hostname = (url) => url.hostname.replace(/^\[|\]$/g, '')

export function manifestUrl(value) {
  const identity = addonUrlIdentity(value)
  if (!identity) throw unsafe()
  const url = new URL(identity)
  if (url.port === '0' || !url.hostname) throw unsafe()
  return url
}

/** Configuration is server-owned: exact origins, never URL-prefix comparisons. */
export function privateManifestOrigins(values = []) {
  if (!Array.isArray(values) || values.length > 50)
    throw new TypeError('Invalid managed manifest private-origin configuration')
  const origins = new Set()
  for (const value of values) {
    let url
    try {
      url = manifestUrl(value)
      if (url.pathname !== '/' || url.search || !/^https?:\/\//.test(value)) throw unsafe()
    } catch {
      throw new TypeError('Invalid managed manifest private-origin configuration')
    }
    origins.add(url.origin)
  }
  return origins
}

export function permittedManifestAddress(value, permitPrivate = false) {
  if (typeof value !== 'string' || !isIP(value) || value.includes('%')) return false
  const address = ipaddr.parse(value)
  // Refuse all mapped/transition forms, not only their commonly private examples.
  const range = address.range()
  if (permitPrivate && ['private', 'uniqueLocal'].includes(range)) return true
  if (range !== 'unicast' || value === '168.63.129.16') return false
  return address.kind() === 'ipv4' || (address.match(globalV6) && !address.match(documentationV6))
}

/** A/AAAA queries can be cancelled; no unbounded, orphaned getaddrinfo work. */
export async function resolveManifestHost(
  host,
  { signal, resolverFactory = () => new Resolver({ timeout: 4000, tries: 1 }) }
) {
  signal.throwIfAborted()
  const resolver = resolverFactory()
  const abort = () => resolver.cancel()
  signal.addEventListener('abort', abort, { once: true })
  try {
    const records = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
    signal.throwIfAborted()
    const addresses = []
    records.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        addresses.push(...result.value.map((address) => ({ address, family: index === 0 ? 4 : 6 })))
      } else if (!['ENODATA', 'ENOTFOUND'].includes(result.reason?.code)) {
        throw unavailable()
      }
    })
    return addresses
  } finally {
    signal.removeEventListener('abort', abort)
    resolver.cancel()
  }
}

export async function resolveManifestTarget(
  url,
  { signal, resolve = resolveManifestHost, privateOrigins = new Set() }
) {
  const host = hostname(url)
  signal.throwIfAborted()
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await resolve(host, { signal })
  signal.throwIfAborted()
  if (!Array.isArray(addresses) || !addresses.length || addresses.length > 64) throw unsafe()
  const permitPrivate = privateOrigins.has(url.origin)
  if (
    addresses.some(
      (record) =>
        !record ||
        isIP(record.address) !== record.family ||
        !permittedManifestAddress(record.address, permitPrivate)
    )
  )
    throw unsafe()
  // Copy trusted results so a resolver/caller cannot mutate a later connection.
  return addresses.map(({ address, family }) => ({ address, family }))
}

/** Node's family auto-selection asks for all=true; older paths ask for one. */
export function pinnedManifestLookup(expectedHost, addresses) {
  const pinned = addresses.map((record) => ({ ...record }))
  return (host, options, callback) => {
    if (host !== expectedHost) return callback(unsafe())
    const family = typeof options === 'number' ? options : options?.family
    const candidates = pinned.filter((record) => !family || record.family === family)
    if (!candidates.length) return callback(unavailable())
    if (options?.all)
      return callback(
        null,
        candidates.map((record) => ({ ...record }))
      )
    callback(null, candidates[0].address, candidates[0].family)
  }
}

/** Low-level GET. Tests may replace request, but never production address policy. */
export async function readManifestResponse(url, addresses, { signal, maxBytes, request }) {
  signal.throwIfAborted()
  const transport = url.protocol === 'https:' ? https : http
  // Dedicated agents do not inherit the global agent's proxy or pooled sockets.
  const agent = new transport.Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} })
  try {
    return await new Promise((resolve, reject) => {
      let response
      let req
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', abort)
        response?.destroy()
        req?.destroy()
        if (error) reject(error)
        else resolve(value)
      }
      const abort = () => finish(new ManagedError('MANIFEST_TIMEOUT'))
      signal.addEventListener('abort', abort, { once: true })
      try {
        req = (request ?? transport.request)(
          url,
          {
            method: 'GET',
            agent,
            autoSelectFamily: true,
            lookup: pinnedManifestLookup(hostname(url), addresses),
            rejectUnauthorized: true,
            maxHeaderSize: 16 * 1024,
            headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate, br' },
          },
          (incoming) => {
            response = incoming
            incoming.once('error', () => finish(unavailable()))
            incoming.once('aborted', () => finish(unavailable()))
            if (incoming.statusCode !== 200) {
              finish(null, {
                status: incoming.statusCode,
                headers: incoming.headers,
                body: Buffer.alloc(0),
              })
              return
            }
            const declared = incoming.headers['content-length']
            if (
              declared !== undefined &&
              (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
            ) {
              finish(new ManagedError('MANIFEST_INVALID'))
              return
            }
            let length = 0
            const chunks = []
            incoming.on('data', (chunk) => {
              if (settled) return
              length += chunk.length
              if (length > maxBytes) return finish(new ManagedError('MANIFEST_INVALID'))
              chunks.push(chunk)
            })
            incoming.once('end', () => {
              if (incoming.complete === false) return finish(unavailable())
              finish(null, {
                status: 200,
                headers: incoming.headers,
                body: Buffer.concat(chunks, length),
              })
            })
          }
        )
        req.once('error', () => finish(unavailable()))
        req.once('close', () => {
          if (!settled) finish(unavailable())
        })
        req.once('upgrade', (_response, socket) => {
          socket.destroy()
          finish(unavailable())
        })
        req.end()
      } catch {
        finish(unavailable())
      }
    })
  } finally {
    agent.destroy()
  }
}

export async function decodeManifestBody(body, encoding, maxBytes) {
  if (!Buffer.isBuffer(body) || body.length > maxBytes) throw new ManagedError('MANIFEST_INVALID')
  const value = (encoding ?? 'identity').trim().toLowerCase()
  const decoded =
    value === 'identity'
      ? body
      : Object.hasOwn(decompress, value)
        ? await decompress[value](body, { maxOutputLength: maxBytes })
        : null
  if (!decoded || decoded.length > maxBytes) throw new ManagedError('MANIFEST_INVALID')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded))
}
