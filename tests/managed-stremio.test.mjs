import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createStremioProvider } from '../server/managed/stremio.js'
import { ManagedError } from '../server/managed/errors.js'

test('managed collection reads reject missing sessions instead of reporting anonymous default addons', async () => {
  let requests = 0
  const provider = createStremioProvider({
    fetch: async () => {
      requests++
      return Response.json({ result: { addons: [] } })
    },
  })
  try {
    for (const session of [undefined, null, {}, 'a-session-string', { authKey: '' }]) {
      await assert.rejects(provider.getCollection(session), { code: 'INVALID_CREDENTIALS' })
      await assert.rejects(provider.getIdentity(session), { code: 'INVALID_CREDENTIALS' })
      await assert.rejects(provider.setCollection(session, []), { code: 'INVALID_CREDENTIALS' })
    }
    assert.equal(requests, 0)
  } finally {
    await provider.close()
  }
})

test('the native transport rejects malformed, excessive, redirected, and ambiguous responses without remote text', async () => {
  for (const fetch of [
    async () => Response.json({ error: { message: 'https://secret.invalid/token', code: 9 } }),
    async () => Response.json({ wrong: 'shape' }),
    async () => new Response('<secret>', { headers: { 'content-type': 'text/html' } }),
    async () => new Response('bad-json', { headers: { 'content-type': 'application/json' } }),
    async () => Response.json({ result: 'x'.repeat(2048) }),
    async (_url, options) => {
      assert.equal(options.redirect, 'error')
      throw new Error('private provider error')
    },
  ]) {
    const provider = createStremioProvider({ fetch, spacingMs: 0, maxBytes: 1024 })
    try {
      await assert.rejects(provider.raw('GetUser', { authKey: 'synthetic-secret' }), (error) => {
        assert.equal(/secret|private|https:/.test(error.message), false)
        return true
      })
    } finally {
      await provider.close()
    }
  }
})

test('native transport shares spacing and honors Retry-After without blind writes', async () => {
  let clock = 0
  const starts = []
  const provider = createStremioProvider({
    now: () => clock,
    monotonic: () => clock,
    wait: async (ms) => {
      clock += ms
    },
    fetch: async () => {
      starts.push(clock)
      return starts.length === 1
        ? new Response('', { status: 429, headers: { 'retry-after': '3' } })
        : Response.json({ result: {} })
    },
  })
  try {
    const first = provider.raw('AddonCollectionSet', { authKey: 'synthetic', addons: [] })
    const next = provider.raw('DatastoreGet', { authKey: 'synthetic' })
    await assert.rejects(first, { code: 'RATE_LIMITED', retryAfterMs: 3000 })
    await next
    assert.deepEqual(starts, [0, 3000])
  } finally {
    await provider.close()
  }
})

test('a full response-body timeout aborts and keeps the shared slot until a slow request settles', async () => {
  let release,
    started,
    signal,
    calls = 0
  const entered = new Promise((resolve) => {
    started = resolve
  })
  const held = new Promise((resolve) => {
    release = resolve
  })
  const provider = createStremioProvider({
    spacingMs: 0,
    timeoutMs: 15,
    fetch: async (_url, options) => {
      calls++
      signal = options.signal
      if (calls === 1)
        return new Response(
          new ReadableStream({
            async start(controller) {
              started()
              await held
              controller.enqueue(new TextEncoder().encode('{"result":{}}'))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        )
      return Response.json({ result: {} })
    },
  })
  try {
    const first = provider.raw('AddonCollectionSet', { authKey: 'synthetic', addons: [] })
    const rejected = assert.rejects(first, { code: 'OUTCOME_UNKNOWN' })
    await entered
    const next = provider.raw('GetUser', { authKey: 'synthetic' })
    await delay(35)
    assert.equal(signal.aborted, true)
    assert.equal(calls, 1)
    release()
    await rejected
    await next
    assert.equal(calls, 2)
  } finally {
    release()
    await provider.close()
  }
})

test('dispatch checks run after queue waiting and can prevent a now-forbidden write', async () => {
  let release, entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const held = new Promise((resolve) => {
    release = resolve
  })
  const types = []
  const provider = createStremioProvider({
    spacingMs: 0,
    fetch: async (_url, options) => {
      types.push(JSON.parse(options.body).type)
      entered()
      await held
      return Response.json({ result: {} })
    },
  })
  try {
    const first = provider.raw('GetUser', {})
    await started
    let paused = false
    const next = provider.raw(
      'AddonCollectionSet',
      { addons: [] },
      {
        beforeDispatch: () => {
          if (paused) throw new ManagedError('WRITE_PAUSED')
        },
      }
    )
    const rejected = assert.rejects(next, { code: 'WRITE_PAUSED' })
    paused = true
    release()
    await first
    await rejected
    assert.deepEqual(types, ['GetUser'])
  } finally {
    release()
    await provider.close()
  }
})

test('shutdown aborts active requests and rejects bounded queued requests', async () => {
  let entered
  const started = new Promise((resolve) => {
    entered = resolve
  })
  const provider = createStremioProvider({
    spacingMs: 0,
    maxQueue: 1,
    fetch: async (_url, options) => {
      entered()
      await new Promise((resolve) =>
        options.signal.addEventListener('abort', resolve, { once: true })
      )
      throw new Error('synthetic aborted')
    },
  })
  const first = provider.raw('GetUser', {})
  const firstFailed = assert.rejects(first, { code: 'NETWORK_ERROR' })
  await started
  const next = provider.raw('GetUser', {})
  const nextFailed = assert.rejects(next, { code: 'NETWORK_ERROR' })
  await assert.rejects(provider.raw('GetUser', {}), { code: 'PROVIDER_UNAVAILABLE' })
  await provider.close()
  await firstFailed
  await nextFailed
  await provider.close()
})
