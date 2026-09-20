import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { canonicalJson } from './crypto.js'
import { ManagedError } from './errors.js'
import { checkedCollection, projectManagedCollection } from './projection.js'

const workers = new WeakSet()
const retryable = new Set([
  'NETWORK_ERROR',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'OUTCOME_UNKNOWN',
  'VERIFICATION_MISMATCH',
])
const terminal = new Set([
  'INVALID_CREDENTIALS',
  'IDENTITY_MISMATCH',
  'DATA_UNREADABLE',
  'INVALID_STATE',
])
const same = (first, second) => canonicalJson(first) === canonicalJson(second)

// Provider implementations must discard remote error text, URLs and credentials.
export class ProviderFailure extends Error {
  constructor(code, retryAfterMs = 0) {
    super('The provider operation could not be verified.')
    if (!retryable.has(code) && !terminal.has(code)) throw new TypeError('Invalid provider failure')
    if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0)
      throw new TypeError('Invalid retry delay')
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

export function retryAfterMilliseconds(value, now) {
  if (typeof value !== 'string') return 0
  if (/^\d+$/.test(value.trim())) {
    const ms = Number(value.trim()) * 1000
    return Number.isSafeInteger(ms) ? ms : 0
  }
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - now) : 0
}

/**
 * Internal runner with an explicitly injected, abort-aware provider. No default
 * network transport, listener, timer or activation is installed. The application
 * must acquire deployment-wide writer ownership before wiring this runner in.
 * The local guard prevents duplicate runners for the same database object only.
 */
export function createManagedWorker({
  db,
  jobs,
  provider,
  now = Date.now,
  monotonic = () => performance.now(),
  wait = (ms, signal) => delay(ms, undefined, { signal }),
  random = Math.random,
  requestTimeoutMs = 10_000,
  requestSpacingMs = 500,
  maxAttempts = 5,
  circuitThreshold = 3,
  circuitMs = 30_000,
}) {
  if (
    !db ||
    !jobs ||
    !provider ||
    ['getIdentity', 'getCollection', 'setCollection'].some(
      (name) => typeof provider[name] !== 'function'
    ) ||
    !Number.isInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 30_000 ||
    !Number.isInteger(requestSpacingMs) ||
    requestSpacingMs < 0 ||
    requestSpacingMs > 10_000 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 10 ||
    !Number.isInteger(circuitThreshold) ||
    circuitThreshold < 1 ||
    circuitThreshold > 20 ||
    !Number.isInteger(circuitMs) ||
    circuitMs < 1 ||
    circuitMs > 300_000 ||
    workers.has(db)
  )
    throw new ManagedError('INVALID_INPUT')
  workers.add(db)
  const shutdown = new AbortController()
  let running = null,
    closing = null,
    closed = false,
    failures = 0,
    blockedUntil = 0,
    nextRequest = 0

  async function request(claim, policy, operation, writing = false) {
    const remaining = Math.max(0, nextRequest - monotonic())
    if (remaining) await wait(remaining, shutdown.signal)
    if (shutdown.signal.aborted) throw new ProviderFailure('NETWORK_ERROR')
    await jobs.heartbeat(claim)
    await jobs.checkDispatch(claim, policy.stamp)
    if (shutdown.signal.aborted) throw new ProviderFailure('NETWORK_ERROR')
    nextRequest = monotonic() + requestSpacingMs
    const controller = new AbortController()
    const abort = () => controller.abort()
    shutdown.signal.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, requestTimeoutMs)
    try {
      // Deliberately await settlement after abort. Racing the promise and freeing
      // the slot would let a slow old request overlap the next writer.
      const result = await operation(controller.signal)
      if (controller.signal.aborted)
        throw new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'NETWORK_ERROR')
      return result
    } catch (error) {
      if (controller.signal.aborted)
        throw new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'NETWORK_ERROR')
      throw error instanceof ProviderFailure
        ? error
        : new ProviderFailure(writing ? 'OUTCOME_UNKNOWN' : 'NETWORK_ERROR')
    } finally {
      clearTimeout(timeout)
      shutdown.signal.removeEventListener('abort', abort)
    }
  }

  async function execute() {
    if (closed) return { state: 'stopped' }
    // Scanning is passive even while a provider is unavailable or writes paused.
    await jobs.scanExpiry()
    if (monotonic() < blockedUntil) return { state: 'backoff' }
    await jobs.recoverExpired()
    const claim = await jobs.claim()
    if (!claim) return { state: 'idle' }
    try {
      const execution = await jobs.readExecution(claim)
      if (execution.state !== 'current') return { state: execution.state }
      const { policy } = execution
      const identity = await request(claim, policy, (signal) =>
        provider.getIdentity(policy.provider, { signal })
      )
      if (identity !== policy.provider.id) throw new ProviderFailure('IDENTITY_MISMATCH')
      const before = checkedCollection(
        await request(claim, policy, (signal) =>
          provider.getCollection(policy.provider, { signal })
        )
      )
      // Exact acceptance uses the durable plan. Otherwise recompute protection
      // against the fresh read, retaining the clean saved descriptors; a retry
      // must not remove a newly protected/default entry introduced meanwhile.
      const plan =
        execution.plan && same(before, execution.plan.expected)
          ? execution.plan
          : { ...projectManagedCollection({ ...policy, remote: before }), stamp: policy.stamp }
      if (!same(before, plan.expected)) {
        await jobs.beginWrite(claim, before, plan)
        await request(
          claim,
          policy,
          (signal) =>
            provider.setCollection(policy.provider, structuredClone(plan.expected), { signal }),
          true
        )
      }
      let observed = before
      if (!same(before, plan.expected)) {
        for (let read = 0; read < 2; read++) {
          observed = checkedCollection(
            await request(claim, policy, (signal) =>
              provider.getCollection(policy.provider, { signal })
            )
          )
          if (same(observed, plan.expected)) break
        }
      }
      if (!same(observed, plan.expected)) throw new ProviderFailure('VERIFICATION_MISMATCH')
      const result = await jobs.completeVerified(claim, { expected: plan.expected, observed, plan })
      failures = 0
      return { ...result, jobId: claim.id }
    } catch (error) {
      if (error?.code === 'LEASE_LOST') return { state: 'lease-lost', jobId: claim.id }
      if (error?.code === 'VERSION_CONFLICT') {
        try {
          return { ...(await jobs.reschedulePolicy(claim)), jobId: claim.id }
        } catch (lost) {
          if (lost?.code === 'LEASE_LOST') return { state: 'lease-lost', jobId: claim.id }
          throw lost
        }
      }
      const code =
        error instanceof ProviderFailure || error instanceof ManagedError
          ? error.code
          : 'DATA_UNREADABLE'
      const paused = code === 'WRITE_PAUSED'
      const failureCode =
        retryable.has(code) || terminal.has(code) || paused ? code : 'DATA_UNREADABLE'
      const retryAfter = error instanceof ProviderFailure ? error.retryAfterMs : 0
      if (retryable.has(failureCode) && failureCode !== 'VERIFICATION_MISMATCH') failures++
      if (failures >= circuitThreshold || retryAfter > 0)
        blockedUntil = Math.max(blockedUntil, monotonic() + Math.max(circuitMs, retryAfter))
      const jitter = Math.min(1, Math.max(0, random()))
      const backoff = Math.min(300_000, 1000 * 2 ** Math.min(8, claim.attempts - 1))
      const dueAt =
        now() + Math.max(Math.ceil(backoff * (0.75 + jitter / 2)), retryAfter, paused ? 1000 : 0)
      try {
        return {
          ...(await jobs.retry(claim, {
            code: failureCode,
            dueAt,
            terminal: !paused && (terminal.has(failureCode) || claim.attempts >= maxAttempts),
          })),
          jobId: claim.id,
          code: failureCode,
        }
      } catch (lost) {
        if (lost?.code === 'LEASE_LOST') return { state: 'lease-lost', jobId: claim.id }
        // A database failure leaves the durable running claim for lease recovery.
        // Never log/rethrow an arbitrary provider exception containing secrets.
        throw new ManagedError('DATA_UNREADABLE')
      }
    }
  }

  return Object.freeze({
    runOnce() {
      if (!running)
        running = execute().finally(() => {
          running = null
        })
      return running
    },
    close() {
      if (!closing) {
        closed = true
        shutdown.abort()
        closing = Promise.resolve(running).finally(() => {
          workers.delete(db)
        })
      }
      return closing
    },
  })
}
