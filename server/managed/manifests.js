import { z } from 'zod'
import { parseAddonConfiguration, MAX_ADDON_CONFIG_BYTES } from '../../shared/addon-config.js'
import { ManagedError } from './errors.js'
import {
  manifestUrl,
  privateManifestOrigins,
  resolveManifestTarget,
  readManifestResponse,
  decodeManifestBody,
} from './manifest-network.js'

const resource = z.union([
  z.string().min(1),
  z.looseObject({
    name: z.string().min(1),
    types: z.array(z.string()).optional(),
    idPrefixes: z.array(z.string()).optional(),
  }),
])
const remoteShape = z.looseObject({
  description: z.string(),
  types: z.array(z.string()),
  resources: z.array(resource),
  catalogs: z.array(z.unknown()),
})
const timeoutError = () => new ManagedError('MANIFEST_TIMEOUT')
const unavailable = () => new ManagedError('MANIFEST_UNAVAILABLE')

function boundedReads(concurrency, maxPending) {
  let active = 0
  const waiting = []
  const pump = () => {
    while (active < concurrency && waiting.length) {
      const next = waiting.shift()
      next.signal.removeEventListener('abort', next.abort)
      if (next.signal.aborted) {
        next.reject(timeoutError())
        continue
      }
      active++
      let released = false
      next.resolve(() => {
        if (released) return
        released = true
        active--
        pump()
      })
    }
  }
  return (signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(timeoutError())
      if (active >= concurrency && waiting.length >= maxPending)
        return reject(new ManagedError('MANIFEST_BUSY'))
      const entry = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = waiting.indexOf(entry)
          if (index >= 0) waiting.splice(index, 1)
          reject(timeoutError())
        },
      }
      signal.addEventListener('abort', entry.abort, { once: true })
      waiting.push(entry)
      pump()
    })
}

function deadline(parent, shutdown, milliseconds) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  // Node composes these without adding an ever-growing public listener set to
  // the shared shutdown signal during a burst of concurrent previews.
  const signal = AbortSignal.any([parent, shutdown, controller.signal].filter(Boolean))
  const timer = setTimeout(abort, milliseconds)
  return {
    signal,
    abort,
    dispose: () => clearTimeout(timer),
  }
}

/** Read-only service. No cache, credentials, provider writes, timers until called. */
export function createManagedManifestService({
  privateOrigins = [],
  resolve,
  read = readManifestResponse,
  concurrency = 3,
  maxPending = 12,
  timeoutMs = 8000,
  batchTimeoutMs = 25_000,
  maxBytes = MAX_ADDON_CONFIG_BYTES,
} = {}) {
  for (const [value, limit] of [
    [concurrency, 8],
    [maxPending, 200],
    [timeoutMs, 30_000],
    [batchTimeoutMs, 60_000],
    [maxBytes, MAX_ADDON_CONFIG_BYTES],
  ]) {
    if (!Number.isInteger(value) || value < 1 || value > limit)
      throw new TypeError('Invalid managed manifest limits')
  }
  const origins = privateManifestOrigins(privateOrigins)
  const shutdown = new AbortController()
  const acquire = boundedReads(concurrency, maxPending)

  async function fetchManifest(value, { signal: parent } = {}) {
    if (shutdown.signal.aborted) throw unavailable()
    const request = deadline(parent, shutdown.signal, timeoutMs)
    let release
    try {
      let url = manifestUrl(value)
      const origin = url.origin
      release = await acquire(request.signal)
      for (let redirects = 0; redirects <= 2; redirects++) {
        const addresses = await resolveManifestTarget(url, {
          signal: request.signal,
          resolve,
          privateOrigins: origins,
        })
        const response = await read(url, addresses, { signal: request.signal, maxBytes })
        request.signal.throwIfAborted()
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects === 2 || typeof response.headers.location !== 'string') throw unavailable()
          url = manifestUrl(new URL(response.headers.location, url).href)
          if (url.origin !== origin) throw new ManagedError('MANIFEST_UNSAFE_URL')
          continue
        }
        if (response.status !== 200) throw unavailable()
        let manifest
        try {
          manifest = await decodeManifestBody(
            response.body,
            response.headers['content-encoding'],
            maxBytes
          )
        } catch {
          throw new ManagedError('MANIFEST_INVALID')
        }
        request.signal.throwIfAborted()
        const parsed = parseAddonConfiguration([{ transportUrl: value, manifest }])
        if (!parsed.ok || !remoteShape.safeParse(manifest).success)
          throw new ManagedError('MANIFEST_INVALID')
        if (manifest.behaviorHints?.configurationRequired === true)
          throw new ManagedError('MANIFEST_CONFIGURATION_REQUIRED')
        return parsed.addons[0].manifest
      }
      throw unavailable()
    } catch (error) {
      if (request.signal.aborted) throw timeoutError()
      if (error instanceof ManagedError) throw error
      throw unavailable()
    } finally {
      release?.()
      request.dispose()
    }
  }

  async function validateManifests(addons, { signal } = {}) {
    const parsed = parseAddonConfiguration(addons)
    if (!parsed.ok) throw new ManagedError('INVALID_ADDON_CONFIG')
    const enabled = parsed.addons.filter((addon) => addon.flags?.enabled !== false)
    const batch = deadline(signal, shutdown.signal, batchTimeoutMs)
    let index = 0
    let failure
    try {
      await Promise.all(
        Array.from({ length: Math.min(concurrency, enabled.length) }, async () => {
          while (index < enabled.length && !batch.signal.aborted) {
            const addon = enabled[index++]
            try {
              const manifest = await fetchManifest(addon.transportUrl, { signal: batch.signal })
              if (manifest.id !== addon.manifest.id) throw new ManagedError('MANIFEST_ID_MISMATCH')
              if (addon.manifest.behaviorHints?.configurationRequired === true)
                throw new ManagedError('MANIFEST_CONFIGURATION_REQUIRED')
            } catch (error) {
              failure ??= error
              batch.abort()
            }
          }
        })
      )
      if (failure) throw failure
      if (batch.signal.aborted) throw timeoutError()
      return true
    } finally {
      batch.dispose()
    }
  }

  return Object.freeze({ fetchManifest, validateManifests, close: () => shutdown.abort() })
}
