import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/app.js'
import {
  defaultExpiryNotice,
  EXPIRY_NOTICE_ADDON_ID,
  expiryNoticePresentation,
} from '../shared/expiry-notice.js'

test('public expiry addon serves a card and source notice without account data; owner settings require authentication', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-notice-api-'))
  let app
  try {
    app = await buildServer({
      env: { CORS_ORIGINS: 'https://manager.example.invalid' },
      dataDir: directory,
      encryptionKey: 'synthetic-notice-key',
      logger: false,
      serveStatic: false,
    })
    const headers = {
      'x-manager-id': 'synthetic-notice-owner',
      'x-sync-password': 'synthetic-notice-token',
    }
    const post = async (url, payload, expected = 200, requestHeaders = headers) => {
      const response = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { ...requestHeaders, 'idempotency-key': randomUUID() },
      })
      assert.equal(response.statusCode, expected, response.body)
      return response.json()
    }
    await post('/api/sync/synthetic-notice-owner', { accounts: [] })
    const empty = await app.inject({ method: 'GET', url: '/api/managed/expiry-notice', headers })
    assert.equal(empty.json().settings.enabled, false)
    const settings = {
      ...defaultExpiryNotice,
      enabled: true,
      baseUrl: 'https://manager.example.invalid',
      message: 'Expired <script>alert("test")</script> & contact your manager.',
    }
    await post('/api/managed/expiry-notice', { expectedVersion: null, settings }, 401, {})
    for (const baseUrl of [
      '',
      'javascript:alert(1)',
      'https://name:password@example.invalid',
      'https://example.invalid?q=secret',
      'https://example.invalid\\path',
    ]) {
      await post(
        '/api/managed/expiry-notice',
        { expectedVersion: null, settings: { ...settings, baseUrl } },
        400
      )
    }
    const saved = await post('/api/managed/expiry-notice', { expectedVersion: null, settings })
    const manifestPath = new URL(saved.settings.manifestUrl).pathname
    const base = manifestPath.slice(0, -'/manifest.json'.length)
    const get = async (url) => {
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { origin: 'https://web.stremio.com' },
      })
      assert.equal(response.statusCode, 200, response.body)
      assert.equal(response.headers['access-control-allow-origin'], '*')
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(response.body.includes(headers['x-manager-id']), false)
      assert.equal(response.body.includes(headers['x-sync-password']), false)
      return response
    }
    const manifest = (await get(manifestPath)).json()
    assert.equal(manifest.id, EXPIRY_NOTICE_ADDON_ID)
    assert.deepEqual(manifest.types, ['movie', 'series'])
    const catalog = (await get(`${base}/catalog/movie/membership.json`)).json()
    assert.equal(catalog.metas.length, 1)
    assert.equal(catalog.metas[0].description, settings.message)
    const meta = (await get(`${base}/meta/movie/aiomanager%3Amembership-expired.json`)).json().meta
    assert.equal(meta.id, catalog.metas[0].id)
    const poster = await get(new URL(meta.poster).pathname)
    assert.equal(poster.headers['content-type'], 'image/png')
    assert.equal(poster.rawPayload.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.ok(poster.rawPayload.length < 100_000)
    assert.deepEqual((await get(`${base}/catalog/movie/membership/skip=100.json`)).json().metas, [])
    for (const resource of [
      'movie/aiomanager:membership-expired',
      'movie/tt0123456',
      'series/tt0123456:1:2',
    ]) {
      const streams = (await get(`${base}/stream/${resource}.json`)).json().streams
      assert.deepEqual(streams, [
        {
          name: 'Membership expired',
          description: settings.message,
          externalUrl: `https://manager.example.invalid${base}/renew`,
        },
      ])
    }
    const landing = await get(`${base}/renew`)
    assert.equal(landing.body.includes('<script>'), false)
    assert.ok(landing.body.includes('&lt;script&gt;'))
    assert.ok(landing.headers['content-security-policy'].includes("default-src 'none'"))
    for (const url of [
      `/api/notice/${'0'.repeat(64)}/manifest.json`,
      '/api/notice/invalid/manifest.json',
      `${base}/meta/movie/tt0123456.json`,
    ]) {
      assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404)
    }
    const nonTelegram = await post('/api/managed/expiry-notice', {
      expectedVersion: saved.version,
      settings: { ...settings, renewalUrl: 'https://renew.example.invalid/?plan=monthly' },
    })
    assert.equal(
      (await get(`${base}/stream/movie/tt0123456.json`)).json().streams[0].externalUrl,
      'https://renew.example.invalid/?plan=monthly'
    )
    assert.deepEqual((await get(`${base}/poster.png`)).rawPayload, poster.rawPayload)
    const renewalUrl = 'https://t.me/Example_Renewals'
    const telegram = await post('/api/managed/expiry-notice', {
      expectedVersion: nonTelegram.version,
      settings: { ...settings, renewalUrl },
    })
    const label = 'Telegram @Example_Renewals'
    const card = (await get(`${base}/catalog/movie/membership.json`)).json().metas[0]
    assert.equal(card.description, settings.message + '\n' + label)
    assert.deepEqual(
      (await get(`${base}/meta/movie/aiomanager%3Amembership-expired.json`)).json().meta,
      card
    )
    assert.equal(card.links[0].url, renewalUrl)
    const image = new URL(card.poster)
    assert.ok(image.search)
    const rendered = (await get(image.pathname + image.search)).rawPayload
    assert.equal(rendered.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.notDeepEqual(rendered, poster.rawPayload)
    assert.deepEqual((await get(image.pathname + image.search)).rawPayload, rendered)
    for (const path of ['movie/tt123', 'series/tt123:1:1']) {
      const [stream] = (await get(`${base}/stream/${path}.json`)).json().streams
      assert.equal(stream.name, label)
      assert.equal(stream.description, card.description)
      assert.equal(Object.hasOwn(stream, 'title'), false)
      assert.equal(stream.externalUrl, renewalUrl)
    }
    await post('/api/managed/expiry-notice', {
      expectedVersion: telegram.version,
      settings: { ...settings, renewalUrl: 'https://t.me/Other_Username' },
    })
    const other = (await get(`${base}/catalog/movie/membership.json`)).json().metas[0]
    assert.notEqual(other.poster, card.poster)
    const otherImage = new URL(other.poster)
    assert.notDeepEqual((await get(otherImage.pathname + otherImage.search)).rawPayload, rendered)
    const group = (await post('/api/managed/groups', { name: 'Delete via HTTP', addons: [] })).group
    await post(
      `/api/managed/groups/${group.id}/delete`,
      { expectedVersion: group.version },
      401,
      {}
    )
    await post(`/api/managed/groups/${group.id}/delete`, { expectedVersion: group.version })
    assert.deepEqual(
      (await app.inject({ method: 'GET', url: '/api/managed/groups', headers })).json().groups,
      []
    )
  } finally {
    await app?.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-notice-api-'))
    await rm(target, { recursive: true, force: true })
  }
})

test('Telegram notice text preserves existing messages and keeps special links as actions', () => {
  for (const renewalUrl of [
    '',
    'https://t.me/+invite',
    'https://t.me/m/business',
    'https://t.me/share/url?url=data',
    'https://t.me.example.org/customer',
    'https://example.com/customer',
  ]) {
    assert.deepEqual(expiryNoticePresentation({ message: 'Expired', renewalUrl }), {
      handle: '',
      contact: '',
      description: 'Expired',
    })
  }
  const message = 'Please message @Support_Name to renew.'
  assert.equal(
    expiryNoticePresentation({ message, renewalUrl: 'https://telegram.me/support_name/' })
      .description,
    message
  )
})
