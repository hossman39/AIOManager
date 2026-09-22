import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/app.js'
import { DB } from '../server/db.js'
import { firstAuth, secondAuth, syntheticKey } from './managed-contract.mjs'
import { API_SCOPES } from '../server/managed/api-keys.js'
import { configuredAddon } from './fixtures/addon-config.mjs'
import { fakeStremio } from './fixtures/stremio.mjs'
import { createStremioProvider } from '../server/managed/stremio.js'

const manager = (auth = firstAuth) => ({
  'x-manager-id': auth.owner,
  'x-sync-password': auth.token,
})
async function fixture(t, live = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-api-v1-'))
  const apps = []
  let calls = 0
  const fake = fakeStremio([
    { email: 'test@example.invalid', password: ' \tExact synthetic password! ' },
  ])
  const noNetwork = async () => {
    calls++
    throw new Error('Synthetic transport rejects network')
  }
  t.after(async () => {
    for (const app of apps) await app.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-api-v1-'))
    await rm(target, { recursive: true, force: true })
  })
  async function start() {
    const db = new DB({ env: {}, sqlitePath: path.join(directory, 'aio.db') })
    const app = await buildServer({
      env: { MANAGED_WRITES_ENABLED: String(live) },
      database: db,
      dataDir: directory,
      encryptionKey: syntheticKey,
      logger: false,
      serveStatic: false,
      fetch: noNetwork,
      httpClient: { post: noNetwork },
      manifestService: { close: async () => {}, validateManifests: async () => true },
      ...(live
        ? { stremioProvider: createStremioProvider({ fetch: fake.fetch, spacingMs: 0 }) }
        : {}),
    })
    apps.push(app)
    if (live) await app.managedRuntime.start({ schedule: false })
    return { app, db }
  }
  const initial = await start()
  for (const auth of [firstAuth, secondAuth]) {
    const response = await initial.app.inject({
      method: 'POST',
      url: `/api/sync/${auth.owner}`,
      headers: manager(auth),
      payload: { accounts: [] },
    })
    assert.equal(response.statusCode, 200)
  }
  const issue = async (scopes = API_SCOPES, owner = firstAuth) => {
    const response = await initial.app.inject({
      method: 'POST',
      url: '/api/managed/api-keys',
      headers: manager(owner),
      payload: { name: 'Synthetic integration', scopes, expiresInDays: 90 },
    })
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
  }
  return { ...initial, start, issue, calls: () => calls, fake }
}
const request = (app, token, method, url, payload, key = randomUUID()) =>
  app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${token}`,
      ...(method === 'POST' ? { 'idempotency-key': key } : {}),
    },
    ...(payload === undefined ? {} : { payload }),
  })
const input = {
  externalRef: 'customer:api-test',
  email: 'test@example.invalid',
  password: ' \tExact synthetic password! ',
}

test('versioned HTTP API enforces bearer authentication, permission boundaries, revocation and redaction', async (t) => {
  const { app, db, issue, calls } = await fixture(t)
  assert.equal((await app.inject({ url: '/api/v1/me', headers: manager() })).statusCode, 401)
  assert.equal((await app.inject({ url: '/api/managed/api-keys' })).statusCode, 401)
  const ownerKey = await issue()
  const readKey = await issue(['read'])
  const otherKey = await issue(API_SCOPES, secondAuth)
  const created = await request(app, ownerKey.token, 'POST', '/accounts', input)
  assert.equal(created.statusCode, 200, created.body)
  const id = created.json().account.id
  assert.ok(!created.body.includes(input.password))
  const list = await request(app, readKey.token, 'GET', '/accounts')
  assert.equal(list.json().accounts.length, 1)
  assert.ok(!list.body.includes(input.password))
  assert.equal(
    (
      await request(app, readKey.token, 'POST', `/accounts/${id}/membership`, {
        expectedVersion: 1,
        mode: 'lifetime',
      })
    ).statusCode,
    403
  )
  assert.equal(
    (await request(app, readKey.token, 'GET', `/accounts/${id}/credentials`)).statusCode,
    403
  )
  assert.equal((await request(app, readKey.token, 'GET', `/accounts/${id}/addons`)).statusCode, 403)
  assert.equal((await request(app, otherKey.token, 'GET', `/accounts/${id}`)).statusCode, 404)
  assert.equal(
    (await request(app, otherKey.token, 'GET', `/accounts/${id}/credentials`)).statusCode,
    404
  )
  const secret = await request(app, ownerKey.token, 'GET', `/accounts/${id}/credentials`)
  assert.equal(secret.json().password, input.password)
  assert.equal(secret.headers['cache-control'], 'no-store')
  assert.ok(secret.headers['x-request-id'])
  const keys = await app.inject({ url: '/api/managed/api-keys', headers: manager() })
  assert.ok(!keys.body.includes(ownerKey.token))
  assert.ok(keys.json().keys.find((key) => key.id === ownerKey.key.id).lastUsedAt)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
  assert.equal(calls(), 0)
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: `/api/managed/api-keys/${ownerKey.key.id}/revoke`,
        headers: manager(),
        payload: {},
      })
    ).statusCode,
    200
  )
  assert.equal((await request(app, ownerKey.token, 'GET', '/me')).statusCode, 401)
  await db.run('UPDATE managed_api_keys SET expires_at = 1 WHERE id = $1', [readKey.key.id])
  assert.equal((await request(app, readKey.token, 'GET', '/me')).statusCode, 401)
})

test('HTTP mutations replay after lost responses and restart; token rotation retains recovery access', async (t) => {
  const { app, issue, start } = await fixture(t)
  const original = await issue()
  const next = await issue()
  const key = randomUUID()
  const first = await request(app, original.token, 'POST', '/accounts', input, key)
  assert.equal(first.statusCode, 200, first.body)
  const id = first.json().account.id
  const replay = await request(app, next.token, 'POST', '/accounts', input, key)
  assert.equal(replay.json().account.id, id)
  assert.equal(replay.json().replayed, true)
  assert.equal(
    (await request(app, next.token, 'POST', '/accounts', { ...input, password: 'changed' }, key))
      .statusCode,
    409
  )
  assert.equal(
    (await request(app, next.token, 'GET', `/receipts/create/${key}`)).json().account.id,
    id
  )
  const readonly = await issue(['read'])
  assert.equal(
    (await request(app, readonly.token, 'GET', `/receipts/create/${key}`)).statusCode,
    403
  )
  const memberKey = randomUUID()
  const membership = {
    expectedVersion: 1,
    mode: 'term',
    local: '2027-01-02T12:30',
    timezone: 'Asia/Kathmandu',
  }
  const saved = await request(
    app,
    original.token,
    'POST',
    `/accounts/${id}/membership`,
    membership,
    memberKey
  )
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().account.expiry.timezone, 'Asia/Kathmandu')
  assert.equal(
    (await request(app, original.token, 'POST', `/accounts/${id}/membership`, membership))
      .statusCode,
    409
  )
  await app.close()
  const restarted = await start()
  assert.equal(
    (
      await request(
        restarted.app,
        next.token,
        'POST',
        `/accounts/${id}/membership`,
        membership,
        memberKey
      )
    ).json().replayed,
    true
  )
  assert.equal(
    (
      await request(restarted.app, next.token, 'GET', '/account-references/customer:api-test')
    ).json().accountId,
    id
  )
  assert.equal(
    (await request(restarted.app, next.token, 'GET', `/receipts/membership/${memberKey}`)).json()
      .account.expiry.timezone,
    'Asia/Kathmandu'
  )
})

test('API supports group assignment and safe staged configuration without activation; bounded requests have stable errors', async (t) => {
  const { app, db, issue, calls } = await fixture(t)
  const { token } = await issue()
  const created = (await request(app, token, 'POST', '/accounts', input)).json().account
  const group = await request(app, token, 'POST', '/groups', {
    name: 'Synthetic group',
    addons: [configuredAddon()],
    safeMode: null,
  })
  assert.equal(group.statusCode, 200, group.body)
  const assigned = await request(app, token, 'POST', '/accounts/assign-group', {
    groupId: group.json().group.id,
    accounts: [{ id: created.id, expectedVersion: 1 }],
  })
  assert.equal(assigned.statusCode, 200, assigned.body)
  const current = assigned.json().accounts[0].account
  assert.equal(current.state, 'staged')
  const config = await request(app, token, 'GET', `/accounts/${created.id}/addons`)
  assert.equal(config.statusCode, 200, config.body)
  assert.equal(config.json().addons.length, 1)
  const noKey = await app.inject({
    method: 'POST',
    url: `/api/v1/accounts/${created.id}/name`,
    headers: { authorization: `Bearer ${token}` },
    payload: { name: 'Updated', expectedVersion: current.version },
  })
  assert.equal(noKey.json().error.code, 'IDEMPOTENCY_KEY_REQUIRED')
  const oversized = await request(app, token, 'POST', '/accounts', {
    ...input,
    password: 's'.repeat(70_000),
  })
  assert.equal(oversized.statusCode, 413)
  assert.equal(oversized.json().error.code, 'REQUEST_TOO_LARGE')
  assert.ok(!oversized.body.includes('ssssssss'))
  const spec = (await request(app, token, 'GET', '/openapi.json')).json()
  assert.equal(spec.openapi, '3.1.1')
  assert.equal(
    spec.paths['/accounts/{id}/credentials'].get['x-required-scopes'].includes('credentials:read'),
    true
  )
  assert.equal(
    spec.paths['/accounts/{id}/reconnect'].post.requestBody.content[
      'application/json'
    ].schema.required.includes('password'),
    true
  )
  const connection = await request(app, token, 'GET', '/me')
  assert.equal(connection.json().capabilities.providerRegistration, false)
  assert.equal(connection.json().capabilities.billing, false)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
  assert.equal(calls(), 0)
})

test('integration requests have a bounded per-key rate and Retry-After', async (t) => {
  const { app, issue } = await fixture(t)
  const { token } = await issue(['read'])
  for (let i = 0; i < 120; i++)
    assert.equal((await request(app, token, 'GET', '/me')).statusCode, 200)
  const response = await request(app, token, 'GET', '/me')
  assert.equal(response.statusCode, 429)
  assert.equal(response.json().error.code, 'RATE_LIMITED')
  assert.ok(Number(response.headers['retry-after']) > 0)
})

test('bearer API drives verified sync, expiry, renewal and offboarding with durable operation history', async (t) => {
  const { app, issue, fake } = await fixture(t, true)
  const { token } = await issue()
  const post = async (url, body) => {
    const response = await request(app, token, 'POST', url, body)
    assert.equal(response.statusCode, 200, response.body)
    return response.json()
  }
  let account = (await post('/accounts', input)).account
  const base = `/accounts/${account.id}`
  account = (
    await post(`${base}/addons`, {
      expectedVersion: account.version,
      groupVersion: null,
      addons: [{ ...configuredAddon(), flags: { enabled: true } }],
    })
  ).account
  account = (
    await post(`${base}/membership`, { expectedVersion: account.version, mode: 'lifetime' })
  ).account
  const preview = await post(`${base}/activation-preview`, {
    expectedVersion: account.version,
    safeMode: null,
  })
  assert.equal(fake.calls.filter((call) => call.type === 'AddonCollectionSet').length, 0)
  const active = await post(`${base}/activate`, {
    expectedVersion: preview.version,
    receipt: preview.receipt,
  })
  const resume = await app.inject({
    method: 'POST',
    url: '/api/managed/settings',
    headers: { ...manager(), 'idempotency-key': randomUUID() },
    payload: { expectedVersion: 1, writePaused: false, safeMode: true },
  })
  assert.equal(resume.statusCode, 200, resume.body)
  assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
  assert.equal(
    (await request(app, token, 'GET', `/operations/${active.jobId}`)).json().state,
    'verified'
  )
  const expired = await post(`${base}/membership`, {
    expectedVersion: active.account.version,
    mode: 'term',
    local: '2020-01-01T00:00',
    timezone: 'Etc/UTC',
  })
  assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
  assert.equal(fake.accounts.get(input.email).addons.length, 0)
  const renewed = await post(`${base}/membership`, {
    expectedVersion: expired.account.version,
    mode: 'lifetime',
  })
  assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
  assert.equal(fake.accounts.get(input.email).addons.length, 1)
  const removed = await post(`${base}/offboard`, { expectedVersion: renewed.account.version })
  assert.equal((await app.managedRuntime.runOnce()).state, 'verified')
  const history = await request(app, token, 'GET', `/operations/${removed.jobId}`)
  assert.equal(history.statusCode, 200, history.body)
  assert.equal(history.json().state, 'verified')
  assert.equal(
    (await request(app, token, 'GET', '/account-references/customer:api-test')).json().removed,
    true
  )
  assert.equal((await request(app, token, 'POST', '/accounts', input)).statusCode, 409)
  assert.equal((await request(app, token, 'GET', `${base}/credentials`)).statusCode, 404)
})
