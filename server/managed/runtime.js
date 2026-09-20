import { createStremioProvider } from './stremio.js'
import { acquireWriterOwnership } from './writer-owner.js'
import { createManagedJobStore } from './jobs.js'
import { createManagedWorker } from './worker.js'
import { providerIdentityKey } from './execution.js'
import { ManagedError } from './errors.js'

/** One deployment owner, one complete operation at a time, one shared HTTP budget. */
export function createManagedRuntime({
  db,
  crypto,
  enabled = false,
  provider = createStremioProvider(),
  now = Date.now,
  pollMs = 1000,
  ownershipOptions,
  onError = () => {},
  workerOptions = {},
}) {
  const jobs = createManagedJobStore({ db, crypto, now })
  let ownership = null,
    acquiring = null,
    tail = Promise.resolve(),
    queued = 0,
    worker = null,
    timer = null,
    started = false,
    closed = false,
    closing = null
  async function ensureOwner() {
    if (closed) throw new ManagedError('WRITER_UNAVAILABLE')
    if (!ownership) {
      if (!acquiring)
        acquiring = acquireWriterOwnership(db, { now, ...ownershipOptions })
          .then((value) => {
            ownership = value
            return value
          })
          .finally(() => {
            acquiring = null
          })
      await acquiring
    }
    await ownership.assertOwned()
  }
  function exclusive(operation) {
    if (closed || queued >= 100) return Promise.reject(new ManagedError('WRITER_UNAVAILABLE'))
    queued++
    const result = tail.then(async () => {
      await ensureOwner()
      return operation()
    })
    tail = result
      .catch(() => {})
      .finally(() => {
        queued--
      })
    return result
  }
  const guardedOptions = (options = {}) => ({
    ...options,
    signal: ownership
      ? options.signal
        ? AbortSignal.any([options.signal, ownership.signal])
        : ownership.signal
      : options.signal,
    beforeDispatch: async () => {
      await ensureOwner()
      await options.beforeDispatch?.()
    },
  })
  const guardedProvider = {
    normalizeCollection: provider.normalizeCollection,
    getIdentity: (session, options) => provider.getIdentity(session, guardedOptions(options)),
    getCollection: (session, options) => provider.getCollection(session, guardedOptions(options)),
    setCollection: (session, addons, options) =>
      provider.setCollection(session, addons, guardedOptions(options)),
    login: (credentials, options) => provider.login(credentials, guardedOptions(options)),
  }
  async function ensureUnmanaged(id) {
    const key = providerIdentityKey(crypto, id)
    if (
      (await db.get('SELECT id FROM managed_accounts WHERE provider_key = $1', [key])) ||
      (await db.get('SELECT account_id FROM managed_offboarded WHERE provider_key = $1', [key]))
    )
      throw new ManagedError('MANAGED_ACCOUNT')
  }
  const runtime = {
    enabled,
    jobs,
    provider: guardedProvider,
    exclusive,
    async status() {
      const metadata = await db.get(
        'SELECT write_paused, last_scan_at, last_backup_at FROM managed_metadata WHERE id = 1'
      )
      let ready = false
      if (ownership && enabled && !closed) {
        try {
          await ownership.assertOwned()
          ready = true
        } catch {
          /* report unavailable without secrets */
        }
      }
      return {
        enabled,
        ready,
        writePaused: !ready || metadata.write_paused !== 0,
        lastScanAt: metadata.last_scan_at,
        lastBackupAt: metadata.last_backup_at,
      }
    },
    // Reads and library operations share the HTTP budget. Collection mutations
    // must always use legacySet; an account label is never an identity proof.
    raw(type, payload, options) {
      if (type === 'AddonCollectionSet' || type === 'Auth') throw new ManagedError('INVALID_INPUT')
      return provider.raw(type, payload, options)
    },
    legacySet(authKey, addons) {
      return exclusive(async () => {
        const session = { authKey }
        const id = await guardedProvider.getIdentity(session)
        await ensureUnmanaged(id)
        await guardedProvider.setCollection(session, addons, {
          beforeDispatch: () => ensureUnmanaged(id),
        })
        return { result: { success: true } }
      })
    },
    async start({ schedule = true } = {}) {
      if (!enabled || started || closed) return
      started = true
      // Recovering ownership can take a quarantine interval after an abrupt exit.
      // Polling remains passive until assertOwned succeeds.
      try {
        await ensureOwner()
      } catch {
        onError('WRITER_UNAVAILABLE')
      }
      await db.run('UPDATE managed_metadata SET write_paused = 0 WHERE id = 1')
      worker = createManagedWorker({
        db,
        jobs,
        provider: guardedProvider,
        now,
        requestSpacingMs: 0,
        ...workerOptions,
      })
      if (schedule) {
        const tick = async () => {
          if (closed) return
          try {
            await runtime.runOnce()
          } catch {
            onError('MANAGED_WORKER_ERROR')
          }
          if (!closed) {
            timer = setTimeout(tick, pollMs)
            timer.unref?.()
          }
        }
        timer = setTimeout(tick, 0)
        timer.unref?.()
      }
    },
    runOnce() {
      if (!enabled || !worker || closed) return Promise.resolve({ state: 'stopped' })
      return exclusive(() => worker.runOnce())
    },
    close() {
      if (!closing) {
        closed = true
        clearTimeout(timer)
        closing = (async () => {
          await Promise.all([worker?.close(), provider.close?.()])
          await tail
          await acquiring?.catch(() => {})
          await ownership?.close()
        })()
      }
      return closing
    },
  }
  return Object.freeze(runtime)
}
