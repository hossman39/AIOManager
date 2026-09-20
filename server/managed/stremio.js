import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { ProviderFailure, retryAfterMilliseconds } from './worker.js'
import { ManagedError } from './errors.js'
import { checkedCollection } from './projection.js'

const types = new Set([
  'GetUser',
  'AddonCollectionGet',
  'AddonCollectionSet',
  'DatastoreGet',
  'DatastorePut',
  'Auth',
])
export function stremioCollection(value) {
  return checkedCollection(value).map(({ transportUrl, manifest, flags }) => ({
    transportUrl,
    manifest,
    flags: { official: flags?.official === true, protected: flags?.protected === true },
  }))
}

/** Fixed-origin, bounded, non-retrying transport shared by every Stremio path. */
export function createStremioProvider({
  fetch: transport = globalThis.fetch,
  now = Date.now,
  monotonic = () => performance.now(),
  wait = (ms, signal) => delay(ms, undefined, { signal }),
  spacingMs = 500,
  timeoutMs = 10_000,
  maxQueue = 100,
  maxBytes = 4 * 1024 * 1024,
} = {}) {
  if (
    typeof transport !== 'function' ||
    !Number.isInteger(spacingMs) ||
    spacingMs < 0 ||
    spacingMs > 10_000 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isInteger(maxQueue) ||
    maxQueue < 1 ||
    maxQueue > 1000 ||
    !Number.isInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 100 * 1024 * 1024
  )
    throw new ManagedError('INVALID_INPUT')
  const shutdown = new AbortController()
  let queue = [],
    running = null,
    closed = false,
    nextStart = 0
  async function perform(type, payload, options) {
    if (closed || options.signal?.aborted) throw new ProviderFailure('NETWORK_ERROR')
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    shutdown.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, timeoutMs)
    let dispatched = false
    const writing = type === 'AddonCollectionSet' || type === 'DatastorePut'
    try {
      const remaining = Math.max(0, nextStart - monotonic())
      if (remaining >= timeoutMs) throw new ProviderFailure('RATE_LIMITED', Math.ceil(remaining))
      if (remaining) await wait(remaining, controller.signal)
      await options.beforeDispatch?.()
      if (controller.signal.aborted) throw new ProviderFailure('NETWORK_ERROR')
      nextStart = monotonic() + spacingMs
      dispatched = true
      const response = await transport(
        `https://api.strem.io/api/${type === 'Auth' ? 'login' : type[0].toLowerCase() + type.slice(1)}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ ...payload, type }),
        }
      )
      if (response.status === 429) {
        const retryAfterMs = retryAfterMilliseconds(response.headers.get('retry-after'), now())
        nextStart = Math.max(nextStart, monotonic() + retryAfterMs)
        await response.body?.cancel()
        throw new ProviderFailure('RATE_LIMITED', retryAfterMs)
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new ProviderFailure(
          response.status === 401 || response.status === 403
            ? 'INVALID_CREDENTIALS'
            : response.status >= 500
              ? 'PROVIDER_UNAVAILABLE'
              : 'INVALID_STATE'
        )
      }
      if (
        !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
        Number(response.headers.get('content-length')) > maxBytes ||
        !response.body
      ) {
        await response.body?.cancel()
        throw new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'DATA_UNREADABLE')
      }
      const reader = response.body.getReader()
      const chunks = []
      let bytes = 0
      try {
        while (true) {
          const chunk = await reader.read()
          if (controller.signal.aborted)
            throw new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'NETWORK_ERROR')
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > maxBytes)
            throw new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'DATA_UNREADABLE')
          chunks.push(Buffer.from(chunk.value))
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
      let data
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        throw new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'DATA_UNREADABLE')
      }
      if (data?.error)
        throw new ProviderFailure(
          type === 'Auth' || type === 'GetUser' ? 'INVALID_CREDENTIALS' : 'PROVIDER_UNAVAILABLE'
        )
      if (!data || !Object.hasOwn(data, 'result') || data.result === null)
        throw new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'DATA_UNREADABLE')
      return data
    } catch (error) {
      if (error instanceof ManagedError || error instanceof ProviderFailure) throw error
      throw new ProviderFailure(writing && dispatched ? 'OUTCOME_UNKNOWN' : 'NETWORK_ERROR')
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      shutdown.signal.removeEventListener('abort', abort)
    }
  }
  function drain() {
    if (running || !queue.length) return
    const item = queue.shift()
    running = perform(item.type, item.payload, item.options)
      .then(item.resolve, item.reject)
      .finally(() => {
        running = null
        drain()
      })
  }
  function raw(type, payload, options = {}) {
    if (!types.has(type) || !payload || typeof payload !== 'object')
      return Promise.reject(new ProviderFailure('INVALID_STATE'))
    if (closed || queue.length >= maxQueue)
      return Promise.reject(new ProviderFailure('PROVIDER_UNAVAILABLE', 1000))
    return new Promise((resolve, reject) => {
      queue.push({ type, payload, options, resolve, reject })
      drain()
    })
  }
  const profile = (value) => {
    if (
      !value ||
      typeof value._id !== 'string' ||
      !value._id ||
      value._id.length > 256 ||
      typeof value.email !== 'string' ||
      !value.email
    )
      throw new ProviderFailure('DATA_UNREADABLE')
    return { id: value._id, email: value.email }
  }
  return Object.freeze({
    raw,
    normalizeCollection: stremioCollection,
    async login({ email, password }, options) {
      const { result } = await raw('Auth', { email, password }, options)
      if (typeof result.authKey !== 'string' || !result.authKey || result.authKey.length > 16_384)
        throw new ProviderFailure('DATA_UNREADABLE')
      return { ...profile(result.user), authKey: result.authKey }
    },
    async getIdentity({ authKey }, options) {
      return profile((await raw('GetUser', { authKey }, options)).result).id
    },
    async getCollection({ authKey }, options) {
      return stremioCollection(
        (await raw('AddonCollectionGet', { authKey, update: false }, options)).result.addons
      )
    },
    async setCollection({ authKey }, addons, options) {
      const { result } = await raw(
        'AddonCollectionSet',
        { authKey, addons: stremioCollection(addons) },
        options
      )
      if (result?.success !== true) throw new ProviderFailure('OUTCOME_UNKNOWN')
    },
    async close() {
      closed = true
      shutdown.abort()
      const waiting = queue
      queue = []
      for (const item of waiting) item.reject(new ProviderFailure('NETWORK_ERROR'))
      await running
    },
  })
}
