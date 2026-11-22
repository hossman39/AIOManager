import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/app.js'
import { createNuvioProvider } from '../server/managed/nuvio.js'
import { createStremioProvider } from '../server/managed/stremio.js'
import { defaultExpiryNotice } from '../shared/expiry-notice.js'
import { fakeStremio } from './fixtures/stremio.mjs'

const login = { email: 'pilot@example.invalid', password: 'only-for-fixtures' }
const hosted = 'https://fixtures.example.invalid/my-addon'
const manifest = {
  id: 'fixture.source',
  name: 'Test source',
  version: '1.0.0',
  types: ['movie'],
  resources: ['stream'],
  catalogs: [],
}

function fakeNuvio() {
  const user = { id: randomUUID(), email: login.email }
  const profiles = [1, 2, 3].map((slot) => ({
    profile_index: slot,
    id: randomUUID(),
    name: 'Profile ' + slot,
    uses_primary_addons: slot === 2,
  }))
  const addons = new Map([
    [1, [{ url: hosted, name: manifest.name, enabled: true, sort_order: 0 }]],
  ])
  const watched = [],
    progress = [],
    writes = []
  async function transport(url, options) {
    const { origin, pathname, searchParams } = new URL(url)
    assert.equal(origin, 'https://api.nuvio.tv')
    assert.equal(options.redirect, 'error')
    const body = options.body && JSON.parse(options.body)
    if (pathname === '/auth/v1/signup' || pathname === '/auth/v1/token') {
      if (body.email !== login.email || body.password !== login.password)
        return new Response(null, { status: 400 })
      return Response.json({ user, access_token: 'test-token', expires_in: 3600 })
    }
    assert.equal(options.headers.Authorization, 'Bearer test-token')
    if (pathname.endsWith('/sync_pull_profiles')) return Response.json(profiles)
    if (pathname === '/rest/v1/addons')
      return Response.json(addons.get(Number(searchParams.get('profile_id').slice(3))) ?? [])
    if (pathname.endsWith('/sync_push_addons')) {
      addons.set(body.p_profile_id, body.p_addons)
      writes.push(pathname)
    } else {
      assert.equal(body.p_profile_id, 2)
      if (pathname.endsWith('/sync_pull_watch_progress')) {
        assert.deepEqual(Object.keys(body).sort(), [
          'p_limit',
          'p_profile_id',
          'p_since_last_watched',
        ])
        return Response.json(
          progress.slice(
            Number(searchParams.get('offset')),
            Number(searchParams.get('offset')) + Number(searchParams.get('limit'))
          )
        )
      }
      if (pathname.endsWith('/sync_pull_watched_items'))
        return Response.json(
          watched.slice((body.p_page - 1) * body.p_page_size, body.p_page * body.p_page_size)
        )
      if (pathname.endsWith('/sync_push_watch_progress')) progress.push(...body.p_entries)
      else if (pathname.endsWith('/sync_push_watched_items')) watched.push(...body.p_items)
      else throw Error('Unhandled fake endpoint ' + pathname)
      writes.push(pathname)
    }
    return new Response(null, { status: 204 })
  }
  return { transport, profiles, addons, watched, progress, writes }
}

export async function nuvioLifecycle(database) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-nuvio-'))
  const nuvio = fakeNuvio()
  const stremio = fakeStremio([login])
  const date = '2026-01-01T20:00:00Z'
  const items = [
    { _id: 'tt1', type: 'movie', name: 'Finished', state: { timesWatched: 1, lastWatched: date } },
    {
      _id: 'tt2',
      type: 'movie',
      name: 'Started',
      state: { timeOffset: 120000, duration: 1800000, lastWatched: date },
    },
    {
      _id: 'tt3',
      type: 'movie',
      name: 'Newer on device',
      state: { timeOffset: 300000, duration: 1800000, lastWatched: date },
    },
    { _id: 'custom-show', type: 'series', name: 'Unmapped show', state: { watched: 'opaque' } },
  ]
  const fetchStremio = (url, opts) =>
    JSON.parse(opts.body).type === 'DatastoreGet'
      ? Response.json({ result: items })
      : stremio.fetch(url, opts)
  let app
  let clockOffset = 0
  try {
    app = await buildServer({
      env: { MANAGED_WRITES_ENABLED: 'true' },
      database,
      managedRuntimeOptions: { now: () => Date.now() + clockOffset },
      dataDir: directory,
      encryptionKey: 'nuvio-test-only',
      serveStatic: false,
      logger: false,
      stremioProvider: createStremioProvider({ fetch: fetchStremio, spacingMs: 0 }),
      nuvioProvider: createNuvioProvider({
        fetch: nuvio.transport,
        fetchManifest: async () => manifest,
      }),
      manifestService: { close: async () => {}, validateManifests: async () => true },
    })
    await app.managedRuntime.start({ schedule: false })
    const headers = { 'x-manager-id': 'pilot-owner', 'x-sync-password': 'manager-fixture-password' }
    async function request(url, body, expected = 200, h = headers) {
      const response = await app.inject({
        url,
        method: body === undefined ? 'GET' : 'POST',
        payload: body,
        headers: { 'idempotency-key': randomUUID(), ...h },
      })
      assert.equal(response.statusCode, expected, response.body)
      return response.json()
    }
    await request('/api/sync/pilot-owner', { accounts: [] })
    const prefix = '/api/managed'
    const paused = await request(prefix + '/status')
    assert.equal(paused.capabilities.providerWrites, true)
    assert.equal(paused.ownerWritePaused, true)
    await request(prefix + '/nuvio/register', login, 409)
    assert.equal((await request(prefix + '/nuvio/profiles', login)).profiles.length, 3)
    await request(prefix + '/settings', {
      expectedVersion: paused.version,
      writePaused: false,
      safeMode: paused.safeMode,
    })
    assert.equal((await request(prefix + '/nuvio/register', login)).profiles[1].inherits, true)
    await request(prefix + '/nuvio/connect', { ...login, name: 'Shared', profileId: 2 }, 409)
    const { account } = await request(prefix + '/nuvio/connect', {
      ...login,
      name: 'Pilot',
      profileId: 1,
    })
    assert.equal(account.platform, 'nuvio')
    const source = (
      await request(prefix + '/accounts/connect', {
        accounts: [{ ...login, localId: 'stremio-pilot' }],
      })
    ).connections[0].account
    const base = prefix + '/accounts/' + account.id
    const initial = await request(base + '/addons')
    assert.equal(initial.source, 'nuvio')
    assert.equal(initial.addons[0].manifest.id, manifest.id)
    assert.equal(initial.addons[0].transportUrl, hosted + '/manifest.json')
    const group = (
      await request(prefix + '/groups', {
        name: 'Nuvio pilot',
        safeMode: false,
        addons: [{ transportUrl: 'https://fixture.invalid/group/manifest.json', manifest }],
      })
    ).group
    const reviewed = await request(prefix + '/groups/' + group.id + '/preview', {
      expectedVersion: group.version,
    })
    await request(
      prefix + '/groups/' + group.id + '/publish',
      { expectedVersion: group.version, receipt: reviewed.receipt },
      201
    )
    const assigned = await request(prefix + '/accounts/assign-group', {
      groupId: group.id,
      useGroupAddons: true,
      startSync: true,
      accounts: [{ id: account.id, expectedVersion: account.version }],
    })
    assert.equal(assigned.accounts[0].account.groupSyncRequested, true)
    assert.equal(assigned.accounts[0].jobId, null)
    assert.equal((await app.managedRuntime.runOnce()).state, 'idle')
    const membership = async (details) =>
      request(base + '/membership', { expectedVersion: (await request(base)).version, ...details })
    assert.ok((await membership({ mode: 'lifetime' })).jobId)
    const sync = async () => assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    await sync()
    assert.equal((await request(base)).state, 'active')
    const active = structuredClone(nuvio.addons.get(1))
    assert.deepEqual(
      active.map((a) => a.url),
      ['https://fixture.invalid/group/manifest.json']
    )
    const settings = {
      ...defaultExpiryNotice,
      enabled: true,
      baseUrl: 'https://manager.example.invalid',
      renewalUrl: 'https://t.me/fixture_renewals',
    }
    const notice = (
      await request(prefix + '/expiry-notice', {
        expectedVersion: (await request(prefix + '/expiry-notice')).version,
        settings,
      })
    ).settings.manifestUrl
    const override = async (value) =>
      (
        await request(base + '/access-override', {
          expectedVersion: (await request(base)).version,
          override: value,
        })
      ).account
    const expiredIds = async () =>
      (await request(prefix + '/accounts?view=expired')).accounts.map((a) => a.id)
    assert.equal((await override('suspended')).membershipType, 'lifetime')
    await sync()
    assert.deepEqual(
      nuvio.addons.get(1).map((a) => a.url),
      [notice]
    )
    assert.deepEqual(await expiredIds(), [account.id])
    assert.equal((await override('automatic')).expired, false)
    await sync()
    assert.deepEqual(nuvio.addons.get(1), active)
    await membership({ mode: 'term', local: '2020-01-01T12:00', timezone: 'America/New_York' })
    await sync()
    assert.deepEqual(
      nuvio.addons.get(1).map((a) => a.url),
      [notice]
    )
    const stream = await request(
      new URL(notice).pathname.replace('manifest.json', 'stream/movie/tt1.json')
    )
    assert.equal(stream.streams[0].externalUrl, settings.renewalUrl)
    const installed = await request(base + '/addons?live=true')
    assert.equal(installed.expiryMatchesInstalled, true)
    assert.equal(installed.installed[0].manifest.id, 'org.aiomanager.membership')
    const cutoff = (await request(base)).expiry
    const allowed = await override('active')
    assert.deepEqual(allowed.expiry, cutoff)
    assert.equal(allowed.expired, false)
    assert.deepEqual(await expiredIds(), [])
    await sync()
    assert.deepEqual(nuvio.addons.get(1), active)
    assert.equal((await app.managedRuntime.runOnce()).state, 'idle')
    assert.equal((await override('automatic')).expired, true)
    await sync()
    assert.deepEqual(
      nuvio.addons.get(1).map((a) => a.url),
      [notice]
    )
    await membership({ mode: 'lifetime' })
    await sync()
    assert.deepEqual(nuvio.addons.get(1), active)
    assert.equal(nuvio.addons.has(3), false)

    const selection = { sourceId: source.id, profileId: 2 }
    const preview = await request(base + '/history/preview', selection)
    assert.deepEqual(
      [preview.watched, preview.progress, preview.skipped],
      [1, 2, ['Unmapped show']]
    )
    assert.equal(nuvio.watched.length, 0)
    nuvio.progress.push({
      content_type: 'movie',
      content_id: 'tt3',
      position: 750000,
      last_watched: Date.parse(date) + 1,
    })
    const payload = { preview: preview.preview }
    const [result, concurrent] = await Promise.all([
      request(base + '/history/import', payload),
      request(base + '/history/import', payload),
    ])
    assert.deepEqual(concurrent, result)
    assert.deepEqual(result, { watched: 1, progress: 1, preserved: 1, unconfirmed: 0 })
    assert.deepEqual(
      nuvio.watched.map((r) => r.content_id),
      ['tt1']
    )
    assert.deepEqual(
      nuvio.progress.map((r) => [r.content_id, r.position]),
      [
        ['tt3', 750000],
        ['tt2', 120000],
      ]
    )
    assert.deepEqual(await request(base + '/history/import', payload), result)
    const again = await request(base + '/history/preview', selection)
    assert.equal(again.watched + again.progress, 0)
    assert.ok(stremio.calls.every((c) => !['DatastorePut', 'AddonCollectionSet'].includes(c.type)))
    const beforeReplacement = await request(base + '/history/preview', selection)
    nuvio.profiles[1].id = randomUUID()
    await request(base + '/history/import', { preview: beforeReplacement.preview }, 409)

    const sourceBase = prefix + '/accounts/' + source.id
    await request(prefix + '/accounts/assign-group', {
      groupId: group.id,
      accounts: [{ id: source.id, expectedVersion: source.version }],
    })
    await request(sourceBase + '/membership', {
      expectedVersion: (await request(sourceBase)).version,
      mode: 'term',
      local: '2020-01-05T22:15',
      timezone: 'America/New_York',
    })
    const original = (
      await request(sourceBase + '/access-override', {
        expectedVersion: (await request(sourceBase)).version,
        override: 'active',
      })
    ).account
    const copy = {
      ...login,
      profileId: 3,
      name: 'Separate',
      copyFrom: { id: source.id, expectedVersion: original.version },
    }
    const connect = prefix + '/nuvio/connect'
    await request(
      connect,
      { ...copy, copyFrom: { id: source.id, expectedVersion: source.version } },
      409
    )
    const receipt = { ...headers, 'idempotency-key': randomUUID() }
    const additional = (await request(connect, copy, 200, receipt)).account
    assert.deepEqual((await request(connect, copy, 200, receipt)).account, additional)
    assert.notEqual(additional.id, account.id)
    assert.deepEqual(additional.expiry, original.expiry)
    assert.equal(additional.groupId, group.id)
    assert.equal(additional.groupSyncRequested, true)
    assert.equal(additional.accessOverride, 'active')
    assert.equal(additional.expired, false)
    assert.equal((await request(connect, copy, 409)).error.code, 'ACCOUNT_EXISTS')
    await sync()
    assert.deepEqual(nuvio.addons.get(3), active)
    assert.deepEqual(nuvio.addons.get(1), active)
    assert.equal((await request(sourceBase)).version, original.version)
    assert.equal((await app.managedRuntime.runOnce()).state, 'idle')

    const future = new Date(Date.now() + 3_600_000).toISOString().slice(0, 16)
    await membership({ mode: 'term', local: future, timezone: 'UTC' })
    await sync()
    assert.deepEqual(nuvio.addons.get(1), active)
    clockOffset = 7_200_000
    await sync()
    assert.deepEqual(
      nuvio.addons.get(1).map((a) => a.url),
      [notice]
    )
    assert.equal((await request(base)).appliedTarget, 'suspended')
    await membership({ mode: 'lifetime' })
    await sync()
    assert.deepEqual(nuvio.addons.get(1), active)
    assert.deepEqual(nuvio.addons.get(3), active)
  } finally {
    await app?.close()
    assert.equal(path.dirname(directory), path.resolve(tmpdir()))
    assert.ok(path.basename(directory).startsWith('aiomanager-nuvio-'))
    await rm(directory, { recursive: true, force: true })
  }
}
