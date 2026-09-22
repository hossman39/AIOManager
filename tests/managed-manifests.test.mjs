import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import http from 'node:http'
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib'
import { createManagedManifestService } from '../server/managed/manifests.js'
import {
  manifestUrl,
  permittedManifestAddress,
  privateManifestOrigins,
  pinnedManifestLookup,
  resolveManifestHost,
  resolveManifestTarget,
  readManifestResponse,
} from '../server/managed/manifest-network.js'
import { configuredAddon } from './fixtures/addon-config.mjs'

const publicAddresses = [
  { address: '8.8.8.8', family: 4 },
  { address: '2001:4860:4860::8888', family: 6 },
]
const addon = () => {
  const value = configuredAddon()
  value.flags.enabled = true
  value.manifest.types = ['movie']
  return value
}
const response = (manifest = addon().manifest) => ({
  status: 200,
  headers: {},
  body: Buffer.from(JSON.stringify(manifest)),
})
const signal = () => new AbortController().signal
function fixture(t, options = {}) {
  const calls = []
  const resolves = []
  const service = createManagedManifestService({
    resolve: async (host) => {
      resolves.push(host)
      return publicAddresses
    },
    read: async (url, addresses, options) => {
      calls.push({ url: url.href, addresses, options })
      return response()
    },
    ...options,
  })
  t.after(service.close)
  return { ...service, calls, resolves }
}
const code = (value) => (error) => {
  assert.equal(error.code, value)
  assert.ok(!error.message.includes('GroupToken'))
  assert.ok(!error.message.includes('private.invalid'))
  return true
}
const untilAborted = (signal, onAbort = () => {}) =>
  new Promise((_resolve, reject) => {
    const abort = () => {
      onAbort()
      reject(new Error('Synthetic transport abort'))
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })

test('manifest validation preserves configured URL bytes and curated addon settings', async (t) => {
  const f = fixture(t)
  const saved = addon()
  saved.transportUrl =
    'stremio://addon.example.invalid/CaSe%2fTOKEN/manifest.json?b=2&a=AA%2fBB&a=3'
  const original = structuredClone(saved)
  assert.equal(await f.validateManifests([saved]), true)
  assert.deepEqual(saved, original)
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].url, saved.transportUrl.replace('stremio:', 'https:'))
  assert.deepEqual(f.calls[0].addresses, publicAddresses)
  assert.deepEqual(f.resolves, ['addon.example.invalid'])
  const loaded = await f.fetchManifest(saved.transportUrl)
  assert.deepEqual(loaded, addon().manifest)
  assert.notEqual(loaded, saved.manifest)
})

test('disabled descriptors stay intact and need no network validation', async (t) => {
  const f = fixture(t, {
    resolve: () => {
      throw new Error('Network forbidden')
    },
  })
  const saved = configuredAddon()
  saved.transportUrl = 'https://127.0.0.1/offline/manifest.json'
  const original = structuredClone(saved)
  assert.equal(await f.validateManifests([saved]), true)
  assert.equal(await f.validateManifests([]), true)
  assert.deepEqual(saved, original)
  assert.equal(f.calls.length, 0)
  await assert.rejects(
    f.validateManifests([{ ...saved, manifest: null }]),
    code('INVALID_ADDON_CONFIG')
  )
})

test('destination policy rejects IPv4/IPv6 local, special, mapped, and transition ranges', () => {
  const forbidden = [
    '0.0.0.0',
    '0.1.2.3',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '127.99.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '192.0.0.9',
    '192.0.2.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '168.63.129.16',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:8.8.8.8',
    '::127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::a00:1',
    '2002:7f00:1::',
    '2001::1',
    '2001:db8::1',
    '3fff::1',
    '4000::1',
    'fe80::1%eth0',
    'not-an-ip',
    '',
  ]
  for (const address of forbidden) assert.equal(permittedManifestAddress(address), false, address)
  for (const address of [
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2001:4860:4860::8888',
    '2606:4700:4700::1111',
  ])
    assert.equal(permittedManifestAddress(address), true, address)
})

test('URL aliases and unsafe schemes never reach the manifest HTTP transport', async (t) => {
  const f = fixture(t)
  for (const url of [
    'http://2130706433/manifest.json',
    'http://0x7f000001/manifest.json',
    'http://0177.0.0.1/manifest.json',
    'https://[::ffff:127.0.0.1]/manifest.json',
    'file:///etc/passwd',
    'ftp://addon.invalid/x',
    'https://user:GroupToken@addon.invalid/manifest.json',
    'https://addon.invalid/x#GroupToken',
    'https://addon.invalid:0/manifest.json',
    'https://addon.invalid\\@127.0.0.1/x',
  ])
    await assert.rejects(f.fetchManifest(url), code('MANIFEST_UNSAFE_URL'))
  assert.equal(f.calls.length, 0)
})

test('every DNS answer must be permitted and match its declared family', async (t) => {
  for (const addresses of [
    [],
    [publicAddresses[0], { address: '10.0.0.1', family: 4 }],
    [{ address: '8.8.8.8', family: 6 }],
    Array(65).fill(publicAddresses[0]),
    [publicAddresses[0], { address: '::1', family: 6 }],
  ]) {
    const f = fixture(t, { resolve: async () => addresses })
    await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_UNSAFE_URL'))
    assert.equal(f.calls.length, 0)
  }
})

test('private origins require exact server configuration and never allow metadata or loopback', async (t) => {
  const options = {
    privateOrigins: ['http://addon.internal:8080'],
    resolve: async () => [{ address: '10.0.1.2', family: 4 }],
  }
  const f = fixture(t, options)
  await f.fetchManifest('http://addon.internal:8080/GroupToken/manifest.json')
  for (const url of [
    'http://addon.internal:8081/manifest.json',
    'http://addon.internal.evil:8080/manifest.json',
    'https://addon.internal:8080/manifest.json',
  ])
    await assert.rejects(f.fetchManifest(url), code('MANIFEST_UNSAFE_URL'))
  for (const address of ['127.0.0.1', '169.254.169.254', '100.100.100.200', '168.63.129.16', '::1'])
    assert.equal(permittedManifestAddress(address, true), false)
  assert.equal(permittedManifestAddress('fd00::1', true), true)
  for (const value of [
    ['http://addon.internal/path'],
    ['https://x.invalid/?token=GroupToken'],
    ['*'],
    'https://addon.invalid',
  ])
    assert.throws(
      () => privateManifestOrigins(value),
      /Invalid managed manifest private-origin configuration/
    )
})

test('pinned lookup supports both Node callback shapes without another DNS lookup', async () => {
  const mutable = structuredClone(publicAddresses)
  const lookup = pinnedManifestLookup('addon.invalid', mutable)
  mutable[0].address = '127.0.0.1'
  const invoke = (host, options) =>
    new Promise((resolve, reject) =>
      lookup(host, options, (error, address, family) =>
        error ? reject(error) : resolve({ address, family })
      )
    )
  assert.deepEqual(await invoke('addon.invalid', { all: true }), {
    address: publicAddresses,
    family: undefined,
  })
  assert.deepEqual(await invoke('addon.invalid', { family: 6 }), publicAddresses[1])
  assert.deepEqual(await invoke('addon.invalid', 4), publicAddresses[0])
  await assert.rejects(invoke('other.invalid', { all: true }), code('MANIFEST_UNSAFE_URL'))
})

test('cancellable resolver requires both DNS family lookups to finish safely', async () => {
  let cancelled = 0
  const resolverFactory = () => ({
    resolve4: async () => ['8.8.8.8'],
    resolve6: async () => {
      throw Object.assign(new Error(), { code: 'ENODATA' })
    },
    cancel: () => cancelled++,
  })
  assert.deepEqual(
    await resolveManifestHost('synthetic.invalid', { signal: signal(), resolverFactory }),
    [publicAddresses[0]]
  )
  assert.equal(cancelled, 1)
  await assert.rejects(
    resolveManifestHost('synthetic.invalid', {
      signal: signal(),
      resolverFactory: () => ({
        ...resolverFactory(),
        resolve6: async () => {
          throw Object.assign(new Error(), { code: 'ETIMEOUT' })
        },
      }),
    }),
    code('MANIFEST_UNAVAILABLE')
  )
  const controller = new AbortController()
  const rejections = []
  const pending = () => new Promise((_resolve, reject) => rejections.push(reject))
  const result = resolveManifestHost('synthetic.invalid', {
    signal: controller.signal,
    resolverFactory: () => ({
      resolve4: pending,
      resolve6: pending,
      cancel: () =>
        rejections
          .splice(0)
          .forEach((reject) => reject(Object.assign(new Error(), { code: 'ECANCELLED' }))),
    }),
  })
  controller.abort()
  await assert.rejects(result)
  assert.equal(rejections.length, 0)
})

test('same-origin redirects are bounded and revalidated against DNS rebinding', async (t) => {
  const urls = []
  const f = fixture(t, {
    read: async (url) => {
      urls.push(url.href)
      return urls.length === 1
        ? { status: 302, headers: { location: '/ChangedCase/manifest.json?secret=AA%2fBB' } }
        : response()
    },
  })
  await f.fetchManifest(addon().transportUrl)
  assert.equal(urls.length, 2)
  assert.equal(f.resolves.length, 2)
  assert.equal(urls[1], 'https://addon.example.invalid/ChangedCase/manifest.json?secret=AA%2fBB')
  let lookups = 0
  let reads = 0
  const rebound = fixture(t, {
    resolve: async () =>
      ++lookups === 1 ? publicAddresses : [{ address: '127.0.0.1', family: 4 }],
    read: async () => {
      reads++
      return { status: 302, headers: { location: '/next' } }
    },
  })
  await assert.rejects(rebound.fetchManifest(addon().transportUrl), code('MANIFEST_UNSAFE_URL'))
  assert.equal(reads, 1)
})

test('cross-origin redirects, TLS downgrades and redirect loops are rejected', async (t) => {
  for (const location of [
    'https://other.invalid/GroupToken',
    'http://addon.example.invalid/GroupToken',
    'https://user:GroupToken@addon.example.invalid/x',
  ]) {
    let calls = 0
    const f = fixture(t, {
      read: async () => {
        calls++
        return { status: 302, headers: { location } }
      },
    })
    await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_UNSAFE_URL'))
    assert.equal(calls, 1)
  }
  let calls = 0
  const loop = fixture(t, {
    read: async () => {
      calls++
      return { status: 307, headers: { location: '/loop' } }
    },
  })
  await assert.rejects(loop.fetchManifest(addon().transportUrl), code('MANIFEST_UNAVAILABLE'))
  assert.equal(calls, 3)
})

test('failed statuses, transport errors and invalid JSON never become empty manifests or retry', async (t) => {
  for (const status of [204, 401, 403, 404, 429, 500, 503]) {
    let calls = 0
    const f = fixture(t, {
      read: async () => {
        calls++
        return { status, headers: {}, body: Buffer.from('GroupToken') }
      },
    })
    await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_UNAVAILABLE'))
    assert.equal(calls, 1)
  }
  for (const body of [
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from('{}'),
    Buffer.from('<html>GroupToken</html>'),
    Buffer.from('{'),
    Buffer.from([0xff, 0xff]),
    Buffer.from('{"__proto__":{"GroupToken":true}}'),
  ]) {
    const f = fixture(t, { read: async () => ({ status: 200, headers: {}, body }) })
    await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_INVALID'))
  }
  const failed = fixture(t, {
    read: async () => {
      throw new Error('https://private.invalid/GroupToken')
    },
  })
  await assert.rejects(failed.fetchManifest(addon().transportUrl), code('MANIFEST_UNAVAILABLE'))
})

test('remote manifest structure, configured state and saved identity are checked', async (t) => {
  for (const patch of [
    { types: null },
    { resources: [{}] },
    { catalogs: [{}] },
    { description: undefined },
    { version: '' },
  ]) {
    const f = fixture(t, { read: async () => response({ ...addon().manifest, ...patch }) })
    await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_INVALID'))
  }
  const required = fixture(t, {
    read: async () =>
      response({ ...addon().manifest, behaviorHints: { configurationRequired: true } }),
  })
  await assert.rejects(
    required.fetchManifest(addon().transportUrl),
    code('MANIFEST_CONFIGURATION_REQUIRED')
  )
  const wrong = fixture(t, {
    read: async () => response({ ...addon().manifest, id: 'different.addon' }),
  })
  await assert.rejects(wrong.validateManifests([addon()]), code('MANIFEST_ID_MISMATCH'))
})

test('gzip, deflate and Brotli are bounded before and after decompression', async (t) => {
  for (const [encoding, encode] of [
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
  ]) {
    const f = fixture(t, {
      maxBytes: 2048,
      read: async () => ({
        ...response(),
        headers: { 'content-encoding': encoding },
        body: encode(response().body),
      }),
    })
    assert.deepEqual(await f.fetchManifest(addon().transportUrl), addon().manifest)
    const bomb = fixture(t, {
      maxBytes: 2048,
      read: async () => ({
        status: 200,
        headers: { 'content-encoding': encoding },
        body: encode(Buffer.alloc(20_000, 65)),
      }),
    })
    await assert.rejects(bomb.fetchManifest(addon().transportUrl), code('MANIFEST_INVALID'))
  }
  const unknown = fixture(t, {
    read: async () => ({ ...response(), headers: { 'content-encoding': 'gzip, br' } }),
  })
  await assert.rejects(unknown.fetchManifest(addon().transportUrl), code('MANIFEST_INVALID'))
  const oversized = fixture(t, { maxBytes: 128 })
  await assert.rejects(oversized.fetchManifest(addon().transportUrl), code('MANIFEST_INVALID'))
})

test('per-request timeout includes DNS, not just connected socket inactivity', async (t) => {
  let aborted = false
  const f = fixture(t, {
    timeoutMs: 25,
    resolve: (_host, { signal }) =>
      untilAborted(signal, () => {
        aborted = true
      }),
  })
  await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_TIMEOUT'))
  assert.equal(aborted, true)
  assert.equal(f.calls.length, 0)
})

test('concurrency, waiting limit, cancellation and slot reuse are global across callers', async (t) => {
  let active = 0
  let peak = 0
  let calls = 0
  const f = fixture(t, {
    concurrency: 2,
    maxPending: 2,
    read: async (_url, _addresses, { signal }) => {
      calls++
      active++
      peak = Math.max(peak, active)
      try {
        await untilAborted(signal)
      } finally {
        active--
      }
    },
  })
  const controllers = Array.from({ length: 4 }, () => new AbortController())
  const work = controllers.map((controller) =>
    f
      .fetchManifest(addon().transportUrl, { signal: controller.signal })
      .catch((error) => error.code)
  )
  await new Promise((resolve) => setImmediate(resolve))
  await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_BUSY'))
  assert.equal(calls, 2)
  controllers[2].abort() // A queued item must not start when another slot opens.
  controllers[0].abort()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 3)
  controllers.forEach((controller) => controller.abort())
  assert.deepEqual(await Promise.all(work), Array(4).fill('MANIFEST_TIMEOUT'))
  assert.equal(peak, 2)
  assert.equal(active, 0)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(
    f.fetchManifest(addon().transportUrl, { signal: cancelled.signal }),
    code('MANIFEST_TIMEOUT')
  )
  assert.equal(calls, 3)
})

test('batch failure cancels other reads, and total batch deadline bounds slow shared validation', async (t) => {
  let aborted = 0
  let reads = 0
  const f = fixture(t, {
    read: async (_url, _addresses, { signal }) => {
      reads++
      if (reads === 1) return response({ ...addon().manifest, id: 'wrong.id' })
      return untilAborted(signal, () => aborted++)
    },
  })
  const addons = Array.from({ length: 20 }, (_, i) => ({
    ...addon(),
    transportUrl: `https://addon.invalid/${i}/manifest.json`,
  }))
  await assert.rejects(f.validateManifests(addons), code('MANIFEST_ID_MISMATCH'))
  assert.equal(reads, 3)
  assert.equal(aborted, 2)
  const slow = fixture(t, {
    batchTimeoutMs: 20,
    timeoutMs: 1000,
    read: (_url, _addresses, { signal }) => untilAborted(signal),
  })
  await assert.rejects(slow.validateManifests(addons), code('MANIFEST_TIMEOUT'))
})

test('service shutdown aborts active and waiting reads without starting new work', async (t) => {
  let calls = 0
  const f = fixture(t, {
    concurrency: 1,
    read: (_url, _addresses, { signal }) => {
      calls++
      return untilAborted(signal)
    },
  })
  const work = Array.from({ length: 4 }, () =>
    f.fetchManifest(addon().transportUrl).catch((error) => error.code)
  )
  await new Promise((resolve) => setImmediate(resolve))
  f.close()
  assert.deepEqual(await Promise.all(work), Array(4).fill('MANIFEST_TIMEOUT'))
  await assert.rejects(f.fetchManifest(addon().transportUrl), code('MANIFEST_UNAVAILABLE'))
  assert.equal(calls, 1)
})

test('a large request burst stays bounded without adding shutdown listener warnings', async (t) => {
  let calls = 0
  const warnings = []
  const observe = (warning) => warnings.push(warning.name)
  process.on('warning', observe)
  t.after(() => process.removeListener('warning', observe))
  const f = fixture(t, {
    read: (_url, _addresses, { signal }) => {
      calls++
      return untilAborted(signal)
    },
  })
  const work = Array.from({ length: 50 }, () =>
    f.fetchManifest(addon().transportUrl).catch((error) => error.code)
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 3)
  f.close()
  const results = await Promise.all(work)
  assert.equal(results.filter((code) => code === 'MANIFEST_BUSY').length, 35)
  assert.equal(results.filter((code) => code === 'MANIFEST_TIMEOUT').length, 15)
  assert.deepEqual(warnings, [])
})

function fakeRequest({
  status = 200,
  headers = {},
  chunks = [response().body],
  complete = true,
  observe = () => {},
} = {}) {
  return (url, options, callback) => {
    observe(url, options)
    const request = new EventEmitter()
    request.destroy = () => {
      request.destroyed = true
    }
    request.end = () =>
      queueMicrotask(() => {
        const incoming = Readable.from(chunks, { objectMode: false })
        incoming.statusCode = status
        incoming.headers = headers
        incoming.complete = complete
        callback(incoming)
      })
    return request
  }
}

test('native request construction pins DNS, verifies TLS and sends no authentication headers', async () => {
  let options
  const url = manifestUrl(addon().transportUrl)
  const result = await readManifestResponse(url, publicAddresses, {
    signal: signal(),
    maxBytes: 2048,
    request: fakeRequest({
      observe: (seen, requestOptions) => {
        assert.equal(seen.href, url.href)
        options = requestOptions
      },
    }),
  })
  assert.deepEqual(result.body, response().body)
  assert.deepEqual(options.headers, {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate, br',
  })
  assert.equal(options.method, 'GET')
  assert.equal(options.rejectUnauthorized, true)
  assert.equal(options.autoSelectFamily, true)
  assert.equal(options.maxHeaderSize, 16384)
  assert.notEqual(options.agent, http.globalAgent)
  assert.deepEqual(options.agent.options.proxyEnv, {})
  const pinned = await new Promise((resolve, reject) =>
    options.lookup(url.hostname, { all: true }, (error, addresses) =>
      error ? reject(error) : resolve(addresses)
    )
  )
  assert.deepEqual(pinned, publicAddresses)
})

test('stream reader rejects declared/actual oversize and incomplete response bodies', async () => {
  for (const options of [
    { headers: { 'content-length': '999999' } },
    { chunks: [Buffer.alloc(101)] },
    { headers: { 'content-length': '-1' } },
  ])
    await assert.rejects(
      readManifestResponse(manifestUrl(addon().transportUrl), publicAddresses, {
        signal: signal(),
        maxBytes: 100,
        request: fakeRequest(options),
      }),
      code('MANIFEST_INVALID')
    )
  await assert.rejects(
    readManifestResponse(manifestUrl(addon().transportUrl), publicAddresses, {
      signal: signal(),
      maxBytes: 2048,
      request: fakeRequest({ complete: false }),
    }),
    code('MANIFEST_UNAVAILABLE')
  )
  const controller = new AbortController()
  let destroyed = false
  const result = readManifestResponse(manifestUrl(addon().transportUrl), publicAddresses, {
    signal: controller.signal,
    maxBytes: 2048,
    request: () =>
      Object.assign(new EventEmitter(), {
        end: () => {},
        destroy: () => {
          destroyed = true
        },
      }),
  })
  controller.abort()
  await assert.rejects(result, code('MANIFEST_TIMEOUT'))
  assert.equal(destroyed, true)
})

test('loopback transport rehearsal checks real HTTP streaming without weakening production policy', async (t) => {
  const received = []
  const server = http.createServer((request, reply) => {
    received.push({ url: request.url, headers: request.headers })
    if (request.url.startsWith('/redirect')) {
      reply.writeHead(302, { location: '/final?Case=AA%2fBB' })
      reply.end()
      return
    }
    if (request.url.startsWith('/partial')) {
      reply.writeHead(200, { 'content-length': 999, connection: 'close' })
      reply.end('{}')
      return
    }
    reply.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' })
    reply.end(gzipSync(response().body))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
  )
  const port = server.address().port
  const f = fixture(t, {
    read: (url, addresses, options) =>
      readManifestResponse(url, addresses, {
        ...options,
        request: (original, requestOptions, callback) => {
          // Test-only transport injection: the production target checker still sees
          // and validates the synthetic public DNS records, never loopback permission.
          const local = new URL(`http://127.0.0.1:${port}${original.pathname}${original.search}`)
          return http.request(
            local,
            { ...requestOptions, headers: { ...requestOptions.headers, host: original.host } },
            callback
          )
        },
      }),
  })
  await assert.rejects(
    resolveManifestTarget(new URL(`http://127.0.0.1:${port}/`), { signal: signal() }),
    code('MANIFEST_UNSAFE_URL')
  )
  assert.deepEqual(await f.fetchManifest('http://addon.example.invalid/redirect'), addon().manifest)
  assert.equal(received.length, 2)
  assert.equal(received[1].url, '/final?Case=AA%2fBB')
  assert.equal(received[0].headers.host, 'addon.example.invalid')
  assert.equal(received[0].headers.authorization, undefined)
  await assert.rejects(
    f.fetchManifest('http://addon.example.invalid/partial'),
    code('MANIFEST_UNAVAILABLE')
  )
  // Exercise Node's real family-selection/lookup path as well. The private pin
  // is supplied only to this low-level transport test, never to the service.
  const pinned = await readManifestResponse(
    new URL(`http://pin.example.invalid:${port}/pinned`),
    [{ address: '127.0.0.1', family: 4 }],
    { signal: signal(), maxBytes: 2048 }
  )
  assert.equal(pinned.status, 200)
  assert.equal(received.at(-1).headers.host, `pin.example.invalid:${port}`)
})
