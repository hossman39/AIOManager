import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/app.js'
import { DB } from '../server/db.js'
import { encrypt, decrypt } from '../server/crypto.js'
import { syntheticAccount, syntheticKey, firstAuth, secondAuth } from './managed-contract.mjs'
import { configuredAddon } from './fixtures/addon-config.mjs'
import { createManagedManifestService } from '../server/managed/manifests.js'

const headers = (auth = firstAuth) => ({
  'x-manager-id': auth.owner,
  'x-sync-password': auth.token,
})
const importRequest = (extra = {}) => ({
  method: 'POST',
  url: '/api/managed/imports',
  headers: { ...headers(), 'idempotency-key': randomUUID() },
  payload: { version: '2.0.0', accounts: [syntheticAccount] },
  ...extra,
})

async function fixture(t, manifestOptions = {}, env = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-managed-test-'))
  const apps = []
  let networkCalls = 0
  const noNetwork = async () => {
    networkCalls++
    throw new Error('Provider access prohibited in passive import tests')
  }
  t.after(async () => {
    try {
      for (const app of apps) await app.close()
    } finally {
      const target = path.resolve(directory)
      assert.equal(path.dirname(target), path.resolve(tmpdir()))
      assert.ok(path.basename(target).startsWith('aiomanager-managed-test-'))
      await rm(target, { recursive: true, force: true })
    }
  })
  const start = async (encryptionKey = syntheticKey) => {
    const db = new DB({ env: {}, sqlitePath: path.join(directory, 'aio.db') })
    const app = await buildServer({
      env,
      database: db,
      dataDir: directory,
      encryptionKey,
      logger: false,
      serveStatic: false,
      fetch: noNetwork,
      httpClient: { post: noNetwork },
      manifestService: createManagedManifestService({
        resolve: noNetwork,
        read: noNetwork,
        ...manifestOptions,
      }),
    })
    apps.push(app)
    return { app, db }
  }
  const { app, db } = await start()
  for (const auth of [firstAuth, secondAuth]) {
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: `/api/sync/${auth.owner}`,
          headers: { 'x-sync-password': auth.token },
          payload: { accounts: [] },
        })
      ).statusCode,
      200
    )
  }
  return { app, db, directory, start, networkCalls: () => networkCalls }
}

test('every managed API requires server-verified owner credentials', async (t) => {
  const { app, db } = await fixture(t)
  for (const requestHeaders of [
    {},
    headers({ ...firstAuth, token: 'wrong' }),
    headers({ owner: 'unknown', token: firstAuth.token }),
    { 'x-account-context': firstAuth.owner },
  ]) {
    for (const request of [
      { method: 'GET', url: '/api/managed/status' },
      importRequest(),
      { method: 'GET', url: '/api/managed/accounts' },
      { method: 'GET', url: '/api/managed/groups' },
      { method: 'POST', url: '/api/managed/groups', payload: { name: 'Synthetic' } },
      {
        method: 'POST',
        url: '/api/managed/manifests/resolve',
        payload: { url: 'https://not-called.invalid/manifest.json' },
      },
      {
        method: 'POST',
        url: `/api/managed/groups/${randomUUID()}/preview`,
        payload: { expectedVersion: 1 },
      },
      { method: 'POST', url: `/api/managed/groups/${randomUUID()}/publish`, payload: {} },
      { method: 'POST', url: `/api/managed/groups/${randomUUID()}/publish-changes`, payload: {} },
      {
        method: 'POST',
        url: `/api/managed/groups/${randomUUID()}/members/membership`,
        payload: {},
      },
      { method: 'POST', url: `/api/managed/groups/${randomUUID()}/members/sync`, payload: {} },
      { method: 'GET', url: `/api/managed/deployments/${randomUUID()}` },
      { method: 'GET', url: `/api/managed/groups/${randomUUID()}/deployment` },
      { method: 'POST', url: '/api/managed/accounts/assign-group', payload: {} },
      { method: 'GET', url: `/api/managed/accounts/${randomUUID()}/personal-addons` },
      {
        method: 'POST',
        url: `/api/managed/accounts/${randomUUID()}/membership`,
        payload: { mode: 'lifetime', expectedVersion: 1 },
      },
    ]) {
      const result = await app.inject({ ...request, headers: requestHeaders })
      assert.equal(result.statusCode, 401, result.body)
      assert.equal(result.json().error.code, 'UNAUTHORIZED')
      assert.equal(result.headers['cache-control'], 'no-store')
    }
  }
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 0)
})

test('preview and staging never call a provider or import source addon/automation state', async (t) => {
  const { app, db, networkCalls } = await fixture(t)
  const payload = {
    version: '2.0.0',
    accounts: [
      { ...syntheticAccount, addons: [{ transportUrl: 'https://private.invalid/manifest.json' }] },
    ],
    autopilotRules: [{ authKey: 'ignored' }],
  }
  const preview = await app.inject(importRequest({ url: '/api/managed/imports/preview', payload }))
  assert.equal(preview.statusCode, 200, preview.body)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_owners')).count, 0)
  const staged = await app.inject(importRequest({ payload }))
  assert.equal(staged.statusCode, 201, staged.body)
  for (const response of [preview, staged]) {
    assert.ok(!response.body.includes('password'))
    assert.ok(!response.body.includes('private.invalid'))
    assert.ok(!response.body.includes('ignored'))
  }
  for (const table of ['autopilot_rules', 'managed_jobs', 'managed_snapshots'])
    assert.equal((await db.get(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0)
  assert.equal(networkCalls(), 0)
})

test('HTTP retries replay a committed import and reject changed requests with the same key', async (t) => {
  const { app } = await fixture(t)
  const request = importRequest()
  const first = await app.inject(request)
  const again = await app.inject(request)
  assert.equal(first.statusCode, 201)
  assert.equal(again.statusCode, 200)
  assert.equal(first.json().batchId, again.json().batchId)
  const changed = await app.inject({
    ...request,
    payload: [{ email: 'changed@example.invalid', password: 'different' }],
  })
  assert.equal(changed.statusCode, 409)
  assert.equal(changed.json().error.code, 'IDEMPOTENCY_CONFLICT')
  assert.equal((await app.inject(importRequest({ headers: headers() }))).statusCode, 400)
})

test('malformed, oversized, and unsupported imports have fixed secret-free error messages', async (t) => {
  const { app } = await fixture(t)
  const malformed = await app.inject(
    importRequest({
      headers: { ...headers(), 'content-type': 'application/json' },
      payload: '{"password":"SENSITIVE_INPUT"',
    })
  )
  assert.equal(malformed.statusCode, 400)
  assert.ok(!malformed.body.includes('SENSITIVE_INPUT'))
  const unsupported = await app.inject(
    importRequest({ payload: { version: 'unexpected', accounts: [] } })
  )
  assert.equal(unsupported.statusCode, 422)
  assert.equal(unsupported.json().error.code, 'UNSUPPORTED_VERSION')
  const oversized = await app.inject(
    importRequest({ payload: { ignored: 'x'.repeat(10 * 1024 * 1024), accounts: [] } })
  )
  assert.equal(oversized.statusCode, 413)
  assert.equal(oversized.json().error.code, 'FILE_TOO_LARGE')
})

test('a different manager cannot read accounts or batch reports by guessed identifiers', async (t) => {
  const { app } = await fixture(t)
  const staged = (await app.inject(importRequest())).json()
  for (const url of [
    `/api/managed/accounts/${staged.accounts[0].id}`,
    `/api/managed/imports/${staged.batchId}`,
  ]) {
    assert.equal(
      (await app.inject({ method: 'GET', url, headers: headers(secondAuth) })).statusCode,
      404
    )
    assert.equal((await app.inject({ method: 'GET', url, headers: headers() })).statusCode, 200)
  }
  assert.deepEqual(
    (await app.inject({ url: '/api/managed/accounts', headers: headers(secondAuth) })).json()
      .accounts,
    []
  )
})

test('retained managed owners cannot be deleted and reclaimed through legacy sync', async (t) => {
  const { app } = await fixture(t)
  await app.inject(importRequest())
  const result = await app.inject({
    method: 'DELETE',
    url: `/api/sync/${firstAuth.owner}`,
    headers: headers(),
  })
  assert.equal(result.statusCode, 409)
  const reclaim = await app.inject({
    method: 'POST',
    url: `/api/sync/${firstAuth.owner}`,
    headers: { 'x-sync-password': 'different-token' },
    payload: {},
  })
  assert.equal(reclaim.statusCode, 401)
  assert.equal(
    (
      await app.inject({
        method: 'DELETE',
        url: `/api/sync/${secondAuth.owner}`,
        headers: headers(secondAuth),
      })
    ).statusCode,
    200
  )
})

test('concurrent legacy identity claims cannot substitute a different password', async (t) => {
  const { app } = await fixture(t)
  const claims = await Promise.all(
    ['synthetic-first', 'synthetic-second'].map((token) =>
      app.inject({
        method: 'POST',
        url: '/api/sync/new-owner',
        headers: { 'x-sync-password': token },
        payload: { value: token },
      })
    )
  )
  assert.deepEqual(claims.map((response) => response.statusCode).sort(), [200, 401])
})

test('legacy read-side encryption upgrade cannot overwrite a newer cloud save', async (t) => {
  const { app, db } = await fixture(t)
  await db.run('INSERT INTO kv_store (key, value, password) VALUES ($1, $2, $3)', [
    'legacy-race',
    JSON.stringify({ value: 'older' }),
    firstAuth.token,
  ])
  const originalGet = db.get.bind(db)
  db.get = async (sql, params) => {
    const row = await originalGet(sql, params)
    if (
      sql === 'SELECT value, password FROM kv_store WHERE key = $1' &&
      params[0] === 'legacy-race'
    ) {
      await db.run('UPDATE kv_store SET value = $1, password = $2 WHERE key = $3', [
        encrypt(JSON.stringify({ value: 'newer' }), syntheticKey),
        encrypt(firstAuth.token, syntheticKey),
        'legacy-race',
      ])
    }
    return row
  }
  const result = await app.inject({ url: '/api/sync/legacy-race', headers: headers() })
  db.get = originalGet
  assert.equal(result.statusCode, 200)
  const persisted = await db.get('SELECT value FROM kv_store WHERE key = $1', ['legacy-race'])
  assert.equal(JSON.parse(decrypt(persisted.value, syntheticKey)).value, 'newer')
})

test('restart preserves encrypted staged records and their idempotency responses', async (t) => {
  const { app, directory, start, networkCalls } = await fixture(t)
  const request = importRequest()
  const staged = (await app.inject(request)).json()
  await app.close()
  const raw = await readFile(path.join(directory, 'aio.db'))
  assert.equal(raw.includes(Buffer.from(syntheticAccount.email)), false)
  assert.equal(raw.includes(Buffer.from(syntheticAccount.password)), false)
  const next = await start()
  const replay = await next.app.inject(request)
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.json().batchId, staged.batchId)
  const account = await next.app.inject({
    url: `/api/managed/accounts/${staged.accounts[0].id}`,
    headers: headers(),
  })
  assert.equal(account.json().name, syntheticAccount.email)
  assert.equal(account.json().state, 'staged')
  assert.equal(networkCalls(), 0)
})

test('wrong nonempty encryption key stops startup with retained managed data', async (t) => {
  const { app, start } = await fixture(t)
  await app.inject(importRequest())
  await app.close()
  await assert.rejects(start('wrong-but-nonempty'), { code: 'DATA_UNREADABLE' })
})

test('internal storage errors do not disclose SQL, credential data, or stack traces', async (t) => {
  const { app, db } = await fixture(t)
  const original = db.statement.bind(db)
  db.statement = (connection, method, sql, params) => {
    if (sql.startsWith('INSERT INTO managed_batches'))
      throw new Error('secret-password SELECT * FROM managed_accounts')
    return original(connection, method, sql, params)
  }
  const response = await app.inject(importRequest())
  db.statement = original
  assert.equal(response.statusCode, 500)
  assert.equal(response.json().error.code, 'INTERNAL_ERROR')
  assert.ok(!response.body.includes('secret-password'))
  assert.ok(!response.body.includes('SELECT'))
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 0)
})

test('membership HTTP edits are passive, scoped, retry-safe, and retained across restart', async (t) => {
  const { app, db, start, networkCalls } = await fixture(t)
  const id = (await app.inject(importRequest())).json().accounts[0].id
  const request = {
    method: 'POST',
    url: `/api/managed/accounts/${id}/membership`,
    headers: { ...headers(), 'idempotency-key': randomUUID() },
    payload: { mode: 'lifetime', expectedVersion: 1 },
  }
  const other = await app.inject({
    ...request,
    headers: { ...headers(secondAuth), 'idempotency-key': randomUUID() },
  })
  assert.equal(other.statusCode, 404)
  const saved = await app.inject(request)
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(saved.json().account.membershipType, 'lifetime')
  assert.equal(saved.json().account.state, 'staged')
  assert.equal(saved.json().account.expiry, null)
  assert.equal(saved.json().jobId, null)
  assert.equal(saved.headers['cache-control'], 'no-store')
  assert.ok(!saved.body.includes('password'))
  assert.ok(!saved.body.includes(syntheticAccount.password))
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
  const stale = await app.inject({
    ...request,
    headers: { ...headers(), 'idempotency-key': randomUUID() },
  })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().error.code, 'VERSION_CONFLICT')
  await app.close()
  const restarted = await start()
  const again = await restarted.app.inject(request)
  assert.equal(again.statusCode, 200, again.body)
  assert.equal(again.json().replayed, true)
  const inventory = (
    await restarted.app.inject({ url: '/api/managed/accounts', headers: headers() })
  ).json()
  assert.equal(inventory.accounts[0].membershipType, 'lifetime')
  assert.equal(inventory.accounts[0].version, saved.json().account.version)
  assert.equal(networkCalls(), 0)
})

test('membership HTTP rejects hidden cutoffs, missing versions, DST gaps, and oversized bodies', async (t) => {
  const { app, db } = await fixture(t)
  const id = (await app.inject(importRequest())).json().accounts[0].id
  for (const [payload, status, code] of [
    [{ mode: 'lifetime', expectedVersion: 1, local: '2027-01-01T00:00' }, 400, 'INVALID_INPUT'],
    [{ mode: 'lifetime' }, 400, 'INVALID_INPUT'],
    [{ mode: 'unset', expectedVersion: 1 }, 400, 'INVALID_INPUT'],
    [{ mode: 'term', expectedVersion: 1, local: '2026-03-08T02:30' }, 422, 'NONEXISTENT_EXPIRY'],
    [{ mode: 'term', expectedVersion: 1, local: '2026-11-01T01:30' }, 422, 'AMBIGUOUS_EXPIRY'],
    [
      { mode: 'term', expectedVersion: 1, local: '2026-11-01T01:30', offset: 60 },
      422,
      'INVALID_EXPIRY',
    ],
    [
      { mode: 'lifetime', expectedVersion: 1, secret: 'SENSITIVE'.repeat(1024) },
      413,
      'REQUEST_TOO_LARGE',
    ],
  ]) {
    const result = await app.inject({
      method: 'POST',
      url: `/api/managed/accounts/${id}/membership`,
      headers: { ...headers(), 'idempotency-key': randomUUID() },
      payload,
    })
    assert.equal(result.statusCode, status, result.body)
    assert.equal(result.json().error.code, code)
    assert.ok(!result.body.includes('SENSITIVE'))
  }
  assert.equal(
    (await db.get('SELECT record_version FROM managed_accounts WHERE id = $1', [id]))
      .record_version,
    1
  )
})

test('HTTP group drafts, personal addons and bulk staging assignments stay passive across restart', async (t) => {
  const { app, db, start, networkCalls } = await fixture(t)
  const id = (await app.inject(importRequest())).json().accounts[0].id
  const post = (url, payload) => ({
    method: 'POST',
    url: `/api/managed${url}`,
    headers: { ...headers(), 'idempotency-key': randomUUID() },
    payload,
  })
  const request = post('/groups', { name: 'Test group', addons: [configuredAddon()] })
  const created = await app.inject(request)
  assert.equal(created.statusCode, 200, created.body)
  const group = created.json().group
  assert.equal((await app.inject(request)).json().replayed, true)
  const assigned = await app.inject(
    post('/accounts/assign-group', { groupId: group.id, accounts: [{ id, expectedVersion: 1 }] })
  )
  assert.equal(assigned.statusCode, 200, assigned.body)
  assert.equal(assigned.json().accounts[0].account.state, 'staged')
  const personalRequest = post(`/accounts/${id}/personal-addons`, {
    expectedVersion: 2,
    addons: [configuredAddon('Personal')],
  })
  const personal = await app.inject(personalRequest)
  assert.equal(personal.statusCode, 200, personal.body)
  assert.equal(personal.json().jobId, null)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
  const denied = await app.inject({
    ...personalRequest,
    headers: { ...headers(secondAuth), 'idempotency-key': randomUUID() },
  })
  assert.equal(denied.statusCode, 404)
  assert.ok(!denied.body.includes('Personal'))
  await app.close()
  const next = await start()
  const savedGroup = await next.app.inject({
    url: `/api/managed/groups/${group.id}`,
    headers: headers(),
  })
  assert.deepEqual(savedGroup.json().draft, [configuredAddon()])
  const savedPersonal = await next.app.inject({
    url: `/api/managed/accounts/${id}/personal-addons`,
    headers: headers(),
  })
  assert.deepEqual(savedPersonal.json().addons, [configuredAddon('Personal')])
  assert.equal(savedPersonal.json().account.groupId, group.id)
  assert.equal(savedPersonal.json().account.state, 'staged')
  assert.equal(networkCalls(), 0)
})

test('HTTP group validation cannot turn malformed addon configuration into an empty draft', async (t) => {
  const { app, db } = await fixture(t)
  for (const addons of [
    null,
    [{ transportUrl: 'SENSITIVE-broken-url' }],
    [configuredAddon(), configuredAddon()],
  ]) {
    const result = await app.inject({
      method: 'POST',
      url: '/api/managed/groups',
      headers: { ...headers(), 'idempotency-key': randomUUID() },
      payload: { name: 'Synthetic', addons },
    })
    assert.equal(result.statusCode, 422, result.body)
    assert.ok(!result.body.includes('SENSITIVE'))
    assert.ok(!result.body.includes('GroupToken'))
  }
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_groups')).count, 0)
})

const managedPost = (url, payload, auth = firstAuth) => ({
  method: 'POST',
  url: `/api/managed${url}`,
  headers: { ...headers(auth), 'idempotency-key': randomUUID() },
  payload,
})
const enabledFixtureAddon = () => {
  const addon = configuredAddon()
  addon.flags.enabled = true
  addon.manifest.types = ['movie']
  return addon
}
const fakePublicDns = async () => [{ address: '8.8.8.8', family: 4 }]
const fakeManifestResponse = () => ({
  status: 200,
  headers: {},
  body: Buffer.from(JSON.stringify(enabledFixtureAddon().manifest)),
})

test('group member bulk HTTP updates membership and queues sync without activating other members', async (t) => {
  const { app, db, networkCalls } = await fixture(t, {}, { MANAGED_WRITES_ENABLED: 'true' })
  const imported = (await app.inject(importRequest())).json().accounts
  const group = (await app.inject(managedPost('/groups', { name: 'Bulk HTTP group' }))).json().group
  const assigned = (
    await app.inject(
      managedPost('/accounts/assign-group', {
        groupId: group.id,
        accounts: imported.map(({ id }) => ({ id, expectedVersion: 1 })),
      })
    )
  ).json().accounts
  const payload = {
    accounts: assigned.map(({ account }) => ({ id: account.id, expectedVersion: account.version })),
    membership: { mode: 'term', local: '2027-01-01T12:00', timezone: 'Europe/London' },
  }
  const request = managedPost(`/groups/${group.id}/members/membership`, payload)
  const result = await app.inject(request)
  assert.equal(result.statusCode, 200, result.body)
  assert.equal(result.headers['cache-control'], 'no-store')
  const member = result.json().accounts[0].account
  assert.equal(member.expiry.timezone, 'Europe/London')
  assert.equal(member.state, 'staged')
  assert.equal(result.json().accounts[0].jobId, null)
  assert.equal((await app.inject(request)).json().replayed, true)
  const sync = managedPost(`/groups/${group.id}/members/sync`, {
    accounts: [{ id: member.id, expectedVersion: member.version }],
  })
  assert.equal((await app.inject(sync)).json().error.code, 'INVALID_STATE')
  await db.run(
    "UPDATE managed_accounts SET state = 'active', provider_key = 'synthetic-bulk-http', provider_enc = 'synthetic' WHERE id = $1",
    [member.id]
  )
  const queued = await app.inject(sync)
  assert.equal(queued.statusCode, 200, queued.body)
  assert.ok(queued.json().accounts[0].jobId)
  assert.equal((await app.inject(sync)).json().replayed, true)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 1)
  assert.equal(networkCalls(), 0)
})

test('manifest resolve HTTP is authenticated, read-only, bounded and redacts failures', async (t) => {
  let reads = 0
  const { app, db, networkCalls } = await fixture(t, {
    resolve: fakePublicDns,
    read: async () => {
      reads++
      return fakeManifestResponse()
    },
  })
  const result = await app.inject(
    managedPost('/manifests/resolve', { url: enabledFixtureAddon().transportUrl })
  )
  assert.equal(result.statusCode, 200, result.body)
  assert.deepEqual(result.json().manifest, enabledFixtureAddon().manifest)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(reads, 1)
  for (const [payload, status, code] of [
    [{ url: 'https://127.0.0.1/GroupToken' }, 422, 'MANIFEST_UNSAFE_URL'],
    [
      { url: enabledFixtureAddon().transportUrl, headers: { authorization: 'GroupToken' } },
      400,
      'INVALID_INPUT',
    ],
    [{ url: 'https://private.invalid/' + 'GroupToken'.repeat(10_000) }, 413, 'REQUEST_TOO_LARGE'],
  ]) {
    const failed = await app.inject(managedPost('/manifests/resolve', payload))
    assert.equal(failed.statusCode, status, failed.body)
    assert.equal(failed.json().error.code, code)
    assert.ok(!failed.body.includes('GroupToken'))
    assert.ok(!failed.body.includes('private.invalid'))
  }
  assert.equal(reads, 1)
  for (const table of [
    'managed_accounts',
    'managed_groups',
    'managed_group_revisions',
    'managed_jobs',
  ])
    assert.equal((await db.get(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0)
  assert.equal(networkCalls(), 0)
})

test('one-call publishing HTTP persists edits and replays after restart without manifest access', async (t) => {
  let offline = false
  let reads = 0
  const { app, db, start, networkCalls } = await fixture(t, {
    resolve: fakePublicDns,
    read: async () => {
      reads++
      if (offline) throw new Error('Synthetic offline manifest')
      return fakeManifestResponse()
    },
  })
  const group = (await app.inject(managedPost('/groups', { name: 'Before edits' }))).json().group
  const changes = {
    expectedVersion: group.version,
    name: 'Published edits',
    safeMode: false,
    addons: [enabledFixtureAddon()],
    allowEmpty: false,
  }
  const request = managedPost(`/groups/${group.id}/publish-changes`, changes)
  const result = await app.inject(request)
  assert.equal(result.statusCode, 201, result.body)
  assert.equal(result.json().group.name, changes.name)
  assert.deepEqual(result.json().group.draft, changes.addons)
  assert.equal(result.json().revision, 1)
  assert.equal(result.json().queued, 0)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count, 1)
  assert.equal(reads, 1)
  await app.close()
  offline = true
  const restarted = await start()
  const retry = await restarted.app.inject(request)
  assert.equal(retry.statusCode, 200, retry.body)
  assert.deepEqual(retry.json(), { ...result.json(), replayed: true })
  assert.equal(reads, 1)
  const denied = await restarted.app.inject({
    ...request,
    headers: { ...headers(secondAuth), 'idempotency-key': randomUUID() },
  })
  assert.equal(denied.statusCode, 404)
  assert.equal(reads, 1)
  const failed = await restarted.app.inject(
    managedPost(`/groups/${group.id}/publish-changes`, {
      ...changes,
      name: 'Must not save',
      expectedVersion: result.json().group.version,
    })
  )
  assert.equal(failed.statusCode, 422, failed.body)
  const current = (
    await restarted.app.inject({ url: `/api/managed/groups/${group.id}`, headers: headers() })
  ).json()
  assert.deepEqual(current, result.json().group)
  assert.equal(networkCalls(), 0)
})

test('publication HTTP commits a scoped mixed cohort, reports queued work, and replays after restart', async (t) => {
  let reads = 0
  const { app, db, start, networkCalls } = await fixture(t, {
    resolve: fakePublicDns,
    read: async () => {
      reads++
      return fakeManifestResponse()
    },
  })
  const imported = await app.inject(
    importRequest({
      payload: {
        accounts: Array.from({ length: 3 }, (_, i) => ({
          email: `publication-${i}@example.invalid`,
          password: 'SyntheticPassword',
        })),
      },
    })
  )
  const accounts = imported.json().accounts
  const created = await app.inject(
    managedPost('/groups', { name: 'Synthetic publication', addons: [enabledFixtureAddon()] })
  )
  const group = created.json().group
  assert.equal(
    (
      await app.inject(
        managedPost('/accounts/assign-group', {
          groupId: group.id,
          accounts: accounts.map(({ id }) => ({ id, expectedVersion: 1 })),
        })
      )
    ).statusCode,
    200
  )
  await app.inject(
    managedPost(`/accounts/${accounts[0].id}/membership`, { mode: 'lifetime', expectedVersion: 2 })
  )
  await app.inject(
    managedPost(`/accounts/${accounts[1].id}/membership`, {
      mode: 'term',
      local: '2020-01-01T12:00',
      expectedVersion: 2,
    })
  )
  // Internal synthetic enrollment only: there is still no HTTP activation path.
  for (const { id } of accounts.slice(0, 2))
    await db.run(
      "UPDATE managed_accounts SET state = 'active', provider_key = $1, provider_enc = 'synthetic-enrollment' WHERE id = $2",
      [`fake-subject-${id}`, id]
    )
  const denied = await app.inject(
    managedPost(`/groups/${group.id}/preview`, { expectedVersion: group.version }, secondAuth)
  )
  assert.equal(denied.statusCode, 404)
  assert.equal(reads, 0)
  const preview = await app.inject(
    managedPost(`/groups/${group.id}/preview`, { expectedVersion: group.version })
  )
  assert.equal(preview.statusCode, 200, preview.body)
  assert.deepEqual(preview.json().counts, { active: 1, suspended: 1, staged: 1, offboarding: 0 })
  assert.ok(!preview.body.includes('GroupToken'))
  const request = managedPost(`/groups/${group.id}/publish`, {
    expectedVersion: group.version,
    receipt: preview.json().receipt,
  })
  const published = await app.inject(request)
  assert.equal(published.statusCode, 201, published.body)
  assert.equal(published.json().queued, 2)
  assert.equal(published.json().revision, 1)
  assert.deepEqual(published.json().group.draft, [enabledFixtureAddon()])
  assert.equal(reads, 1)
  const progressRequest = {
    url: `/api/managed/deployments/${published.json().deploymentId}`,
    headers: headers(),
  }
  const progress = await app.inject(progressRequest)
  const latestRequest = {
    url: `/api/managed/groups/${published.json().group.id}/deployment`,
    headers: headers(),
  }
  assert.deepEqual((await app.inject(latestRequest)).json(), { deployment: progress.json() })
  assert.equal(
    (await app.inject({ ...latestRequest, headers: headers(secondAuth) })).statusCode,
    404
  )
  assert.equal(progress.statusCode, 200, progress.body)
  assert.equal(progress.json().counts.pending, 2)
  assert.equal(progress.json().counts.verified, 0)
  assert.deepEqual(
    progress
      .json()
      .members.map(({ target }) => target)
      .sort(),
    ['active', 'suspended']
  )
  assert.equal(progress.json().skipped.staged, 1)
  assert.ok(!progress.body.includes('GroupToken'))
  assert.ok(!progress.body.includes('SyntheticPassword'))
  assert.equal(
    (await app.inject({ ...progressRequest, headers: headers(secondAuth) })).statusCode,
    404
  )
  const status = (await app.inject({ url: '/api/managed/status', headers: headers() })).json()
  assert.equal(status.capabilities.groupPublication, true)
  assert.equal(status.capabilities.providerWrites, false)
  assert.equal(status.writePaused, true)
  await app.close()
  const restarted = await start()
  const replayed = await restarted.app.inject(request)
  assert.equal(replayed.statusCode, 200, replayed.body)
  assert.equal(replayed.json().replayed, true)
  assert.equal(replayed.json().deploymentId, published.json().deploymentId)
  assert.equal((await restarted.db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 2)
  assert.deepEqual((await restarted.app.inject(progressRequest)).json(), progress.json())
  assert.deepEqual((await restarted.app.inject(latestRequest)).json(), {
    deployment: progress.json(),
  })
  assert.equal(reads, 1)
  assert.equal(networkCalls(), 0)
})

test('HTTP publication refuses failed validation, invalid receipts and oversized publication bodies', async (t) => {
  let failed = true
  const { app, db } = await fixture(t, {
    resolve: fakePublicDns,
    read: async () => {
      if (failed) throw new Error('https://private.invalid/GroupToken')
      return fakeManifestResponse()
    },
  })
  const group = (
    await app.inject(managedPost('/groups', { name: 'Synthetic', addons: [enabledFixtureAddon()] }))
  ).json().group
  const prepare = () =>
    app.inject(managedPost(`/groups/${group.id}/preview`, { expectedVersion: group.version }))
  const invalid = await prepare()
  assert.equal(invalid.statusCode, 422)
  assert.equal(invalid.json().error.code, 'MANIFEST_UNAVAILABLE')
  assert.ok(!invalid.body.includes('GroupToken'))
  failed = false
  const preview = (await prepare()).json()
  for (const [receipt, status, code] of [
    ['tampered', 409, 'PREVIEW_STALE'],
    ['GroupToken'.repeat(2000), 413, 'REQUEST_TOO_LARGE'],
  ]) {
    const result = await app.inject(
      managedPost(`/groups/${group.id}/publish`, { expectedVersion: group.version, receipt })
    )
    assert.equal(result.statusCode, status, result.body)
    assert.equal(result.json().error.code, code)
    assert.ok(!result.body.includes('GroupToken'))
  }
  await app.inject(
    managedPost(`/groups/${group.id}/draft`, {
      name: group.name,
      addons: [configuredAddon()],
      safeMode: null,
      expectedVersion: group.version,
    })
  )
  const stale = await app.inject(
    managedPost(`/groups/${group.id}/publish`, {
      expectedVersion: group.version,
      receipt: preview.receipt,
    })
  )
  assert.equal(stale.statusCode, 409, stale.body)
  for (const table of ['managed_group_revisions', 'managed_jobs', 'managed_deployments'])
    assert.equal((await db.get(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0)
})

test('HTTP empty publication needs explicit consent and does not activate staged accounts', async (t) => {
  const { app, db, networkCalls } = await fixture(t)
  const group = (await app.inject(managedPost('/groups', { name: 'Intentionally empty' }))).json()
    .group
  const preview = (
    await app.inject(managedPost(`/groups/${group.id}/preview`, { expectedVersion: group.version }))
  ).json()
  assert.equal(preview.empty, true)
  const body = { expectedVersion: group.version, receipt: preview.receipt }
  const denied = await app.inject(managedPost(`/groups/${group.id}/publish`, body))
  assert.equal(denied.statusCode, 409, denied.body)
  assert.equal(denied.json().error.code, 'EMPTY_PUBLICATION_CONFIRMATION')
  const saved = await app.inject(
    managedPost(`/groups/${group.id}/publish`, { ...body, allowEmpty: true })
  )
  assert.equal(saved.statusCode, 201, saved.body)
  assert.equal(saved.json().queued, 0)
  assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
  assert.equal(networkCalls(), 0)
})

test(
  'disconnecting a real HTTP preview cancels its manifest read',
  { timeout: 5000 },
  async (t) => {
    const started = Promise.withResolvers()
    const cancelled = Promise.withResolvers()
    const { app } = await fixture(t, {
      resolve: fakePublicDns,
      read: (_url, _addresses, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              cancelled.resolve()
              reject(new Error('Synthetic cancellation'))
            },
            { once: true }
          )
          started.resolve()
        }),
    })
    const group = (
      await app.inject(
        managedPost('/groups', { name: 'Cancellation', addons: [enabledFixtureAddon()] })
      )
    ).json().group
    await app.listen({ port: 0, host: '127.0.0.1' })
    const controller = new AbortController()
    const request = fetch(
      `http://127.0.0.1:${app.server.address().port}/api/managed/groups/${group.id}/preview`,
      {
        method: 'POST',
        headers: { ...headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: group.version }),
        signal: controller.signal,
      }
    )
    await started.promise
    controller.abort()
    await assert.rejects(request)
    await cancelled.promise
  }
)
