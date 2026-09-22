import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/app.js'
import { createStremioProvider } from '../server/managed/stremio.js'
import { fakeStremio } from './fixtures/stremio.mjs'
import { configuredAddon } from './fixtures/addon-config.mjs'

test('authenticated HTTP lifecycle enforces first-sync review, expiry, legacy gates and verified removal', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-live-api-'))
  const fake = fakeStremio([{ email: 'synthetic@example.invalid', password: 'synthetic-password' }])
  let app
  try {
    app = await buildServer({
      env: { MANAGED_WRITES_ENABLED: 'true' },
      dataDir: directory,
      encryptionKey: 'synthetic-http-key',
      logger: false,
      serveStatic: false,
      stremioProvider: createStremioProvider({ fetch: fake.fetch, spacingMs: 0 }),
      manifestService: { validateManifests: async () => true, close: async () => {} },
    })
    await app.managedRuntime.start({ schedule: false })
    const headers = { 'x-manager-id': 'synthetic-owner', 'x-sync-password': 'synthetic-token' }
    const post = async (url, payload, expected = 200, extraHeaders = {}) => {
      const response = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: { ...headers, 'idempotency-key': randomUUID(), ...extraHeaders },
      })
      assert.equal(response.statusCode, expected, response.body)
      return response.json()
    }
    await post('/api/sync/synthetic-owner', { accounts: [] })
    const staged = await post(
      '/api/managed/imports',
      { accounts: [{ email: 'synthetic@example.invalid', password: 'synthetic-password' }] },
      201
    )
    const id = staged.accounts[0].id,
      base = `/api/managed/accounts/${id}`
    const connectionInput = {
      accounts: [
        {
          localId: 'synthetic-cache-id',
          email: 'synthetic@example.invalid',
          password: 'synthetic-password',
        },
      ],
    }
    const connected = await post('/api/managed/accounts/connect', connectionInput)
    assert.equal(connected.connections[0].account.id, id)
    assert.equal(fake.calls.length, 0)
    const group = (
      await post('/api/managed/groups', {
        name: 'Synthetic group',
        addons: [{ ...configuredAddon(), flags: { enabled: true } }],
        safeMode: null,
      })
    ).group
    const review = await post(`/api/managed/groups/${group.id}/preview`, {
      expectedVersion: group.version,
    })
    await post(
      `/api/managed/groups/${group.id}/publish`,
      { expectedVersion: group.version, receipt: review.receipt },
      201
    )
    await post('/api/managed/accounts/assign-group', {
      groupId: group.id,
      accounts: [{ id, expectedVersion: 1 }],
    })
    const membership = (await post(`${base}/membership`, { expectedVersion: 2, mode: 'lifetime' }))
      .account
    const denied = await app.inject({
      method: 'POST',
      url: `${base}/activation-preview`,
      payload: { expectedVersion: membership.version, safeMode: null },
    })
    assert.equal(denied.statusCode, 401)
    const first = await post(`${base}/activation-preview`, {
      expectedVersion: membership.version,
      safeMode: null,
    })
    assert.equal(fake.calls.filter((call) => call.type === 'AddonCollectionSet').length, 0)
    const activation = await post(`${base}/activate`, {
      expectedVersion: first.version,
      receipt: first.receipt,
    })
    await post('/api/managed/settings', { expectedVersion: 1, writePaused: false, safeMode: true })
    assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    const user = fake.accounts.get('synthetic@example.invalid')
    const gate = await post(
      '/api/stremio-proxy',
      { type: 'AddonCollectionSet', authKey: user.authKey, addons: [] },
      409,
      { 'x-account-context': 'fake-unmanaged-label' }
    )
    assert.equal(gate.code, 'MANAGED_ACCOUNT')
    assert.equal(user.addons.length, 1)
    // Existing library operations remain usable and share the provider budget.
    await post('/api/stremio-proxy', {
      type: 'DatastorePut',
      authKey: user.authKey,
      collection: 'libraryItem',
      changes: [{ removed: true }],
    })
    const sent = fake.calls.at(-1).body.changes[0]
    assert.equal(sent._ctime, '0001-01-01T00:00:00Z')
    const expired = (
      await post(`${base}/membership`, {
        expectedVersion: activation.account.version,
        mode: 'term',
        local: '2020-02-03T12:30',
        timezone: 'Asia/Tokyo',
      })
    ).account
    assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    assert.deepEqual(user.addons, [])
    const execution = await app.inject({ method: 'GET', url: `${base}/execution`, headers })
    assert.equal(execution.json().account.expired, true)
    assert.equal(execution.json().account.expiry.timezone, 'Asia/Tokyo')
    await post(`${base}/offboard`, { expectedVersion: expired.version })
    assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
    const removed = await app.inject({ method: 'GET', url: `${base}/execution`, headers })
    assert.equal(removed.json().account, null)
    assert.ok(removed.json().removedAt)
    assert.equal((await app.inject({ method: 'GET', url: base, headers })).statusCode, 404)
    const afterRemoval = await post('/api/managed/accounts/connect', connectionInput)
    assert.deepEqual(afterRemoval.connections, [
      { localId: 'synthetic-cache-id', status: 'removed', account: null },
    ])
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/managed/accounts', headers })).json().accounts
        .length,
      0
    )
    assert.ok(fake.calls.every((call) => !JSON.stringify(call.body).includes('Register')))
  } finally {
    await app?.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-live-api-'))
    await rm(target, { recursive: true, force: true })
  }
})
