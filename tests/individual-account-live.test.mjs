import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/app.js'
import { createStremioProvider } from '../server/managed/stremio.js'
import { fakeStremio } from './fixtures/stremio.mjs'

const addon = (id, transportUrl = 'https://example.invalid/' + id + '/manifest.json') => ({
  transportUrl,
  manifest: { id, name: id, version: '1.0.0', types: ['movie'], resources: [], catalogs: [] },
  flags: { enabled: true },
})

test('individual accounts sync without a group, retain isolated edits through group updates, detach and renew', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-individual-api-'))
  const localFiles = {
    ...addon('local-files', 'http://127.0.0.1:11470/local-addon/manifest.json'),
    flags: { enabled: true, protected: true },
  }
  const extra = addon('account-only')
  const fake = fakeStremio([
    { email: 'first@example.invalid', password: 'synthetic-only', addons: [localFiles, extra] },
    { email: 'second@example.invalid', password: 'synthetic-only' },
  ])
  const validations = []
  let app
  try {
    app = await buildServer({
      env: { MANAGED_WRITES_ENABLED: 'true' },
      dataDir: directory,
      encryptionKey: 'synthetic-individual-key',
      logger: false,
      serveStatic: false,
      stremioProvider: createStremioProvider({ fetch: fake.fetch, spacingMs: 0 }),
      manifestService: {
        validateManifests: async (addons) => {
          validations.push(addons)
          return true
        },
        close: async () => {},
      },
    })
    await app.managedRuntime.start({ schedule: false })
    const headers = {
      'x-manager-id': 'individual-owner',
      'x-sync-password': 'synthetic-owner-token',
    }
    const post = async (url, payload, status = 200) => {
      const result = await app.inject({
        method: 'POST',
        url,
        headers: { ...headers, 'idempotency-key': randomUUID() },
        payload,
      })
      assert.equal(result.statusCode, status, result.body)
      return result.json()
    }
    const get = async (url) => {
      const result = await app.inject({ method: 'GET', url, headers })
      assert.equal(result.statusCode, 200, result.body)
      return result.json()
    }
    await post('/api/sync/individual-owner', { accounts: [] })
    const accounts = (
      await post('/api/managed/accounts/connect', {
        accounts: [
          { localId: 'first', email: 'first@example.invalid', password: 'synthetic-only' },
          { localId: 'second', email: 'second@example.invalid', password: 'synthetic-only' },
        ],
      })
    ).connections.map((entry) => entry.account)
    const base = (index) => '/api/managed/accounts/' + accounts[index].id
    const initial = await get(base(0) + '/addons')
    assert.equal(initial.source, 'stremio')
    assert.equal(initial.addons.length, 2)
    assert.equal(fake.calls.filter((call) => call.type === 'AddonCollectionSet').length, 0)
    const own = initial.addons.map((entry) => ({
      ...entry,
      metadata: { customName: 'Personal ' + entry.manifest.name },
    }))
    const saved = await post(base(0) + '/addons', {
      expectedVersion: 1,
      groupVersion: null,
      addons: own,
    })
    const membership = await post(base(0) + '/membership', {
      expectedVersion: saved.account.version,
      mode: 'lifetime',
    })
    const preview = await post(base(0) + '/activation-preview', {
      expectedVersion: membership.account.version,
      safeMode: null,
    })
    assert.ok(validations.at(-1).every((entry) => !entry.transportUrl.startsWith('http://127.')))
    await post(base(0) + '/activate', {
      expectedVersion: preview.version,
      receipt: preview.receipt,
    })
    await post('/api/managed/settings', { expectedVersion: 1, writePaused: false, safeMode: true })
    assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    const first = fake.accounts.get('first@example.invalid'),
      second = fake.accounts.get('second@example.invalid')
    assert.equal(first.addons[0].manifest.name, 'Personal local-files')

    let group = (
      await post('/api/managed/groups', {
        name: 'Optional shared group',
        addons: [addon('shared')],
        safeMode: false,
      })
    ).group
    const publish = async () => {
      const review = await post('/api/managed/groups/' + group.id + '/preview', {
        expectedVersion: group.version,
      })
      const result = await post(
        '/api/managed/groups/' + group.id + '/publish',
        { expectedVersion: group.version, receipt: review.receipt },
        201
      )
      group = await get('/api/managed/groups/' + group.id)
      return result
    }
    await publish()
    await post('/api/managed/accounts/assign-group', {
      groupId: group.id,
      useGroupAddons: true,
      accounts: [
        { id: accounts[0].id, expectedVersion: (await get(base(0))).version },
        { id: accounts[1].id, expectedVersion: 1 },
      ],
    })
    const secondMember = await post(base(1) + '/membership', {
      expectedVersion: 2,
      mode: 'lifetime',
    })
    const secondReview = await post(base(1) + '/activation-preview', {
      expectedVersion: secondMember.account.version,
      safeMode: null,
    })
    await post(base(1) + '/activate', {
      expectedVersion: secondReview.version,
      receipt: secondReview.receipt,
    })
    for (let i = 0; i < 3; i++) await app.managedRuntime.runOnce()

    const grouped = await get(base(0) + '/addons')
    const changed = grouped.addons.map((entry) =>
      entry.manifest.id === 'shared'
        ? { ...entry, metadata: { customName: 'First account override' } }
        : entry
    )
    await post(base(0) + '/addons', {
      expectedVersion: grouped.account.version,
      groupVersion: grouped.groupVersion,
      addons: changed,
    })
    await app.managedRuntime.runOnce()
    assert.equal(
      second.addons.find((entry) => entry.manifest.id === 'shared').manifest.name,
      'shared'
    )
    group = (
      await post('/api/managed/groups/' + group.id + '/draft', {
        expectedVersion: group.version,
        name: group.name,
        safeMode: false,
        addons: [{ ...addon('shared'), metadata: { customName: 'Updated shared version' } }, extra],
      })
    ).group
    await publish()
    for (let i = 0; i < 3; i++) await app.managedRuntime.runOnce()
    assert.equal(
      first.addons.find((entry) => entry.manifest.id === 'shared').manifest.name,
      'First account override'
    )
    assert.equal(
      second.addons.find((entry) => entry.manifest.id === 'shared').manifest.name,
      'Updated shared version'
    )
    assert.equal(first.addons.filter((entry) => entry.manifest.id === 'account-only').length, 1)
    assert.equal(
      first.addons.find((entry) => entry.manifest.id === 'account-only').manifest.name,
      'Personal account-only'
    )

    const before = structuredClone(first.addons)
    await post('/api/managed/accounts/assign-group', {
      groupId: null,
      accounts: [{ id: accounts[0].id, expectedVersion: (await get(base(0))).version }],
    })
    assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    assert.deepEqual(first.addons, before)
    assert.equal((await get(base(0))).groupId, null)
    await post(base(0) + '/membership', {
      expectedVersion: (await get(base(0))).version,
      mode: 'term',
      local: '2020-01-01T12:00',
      timezone: 'Asia/Tokyo',
    })
    assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    assert.deepEqual(first.addons, [])
    await post(base(0) + '/membership', {
      expectedVersion: (await get(base(0))).version,
      mode: 'lifetime',
    })
    assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    assert.deepEqual(first.addons, before)
  } finally {
    await app?.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-individual-api-'))
    await rm(target, { recursive: true, force: true })
  }
})
