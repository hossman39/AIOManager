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

async function fixture(t) {
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
      env: {},
      database: db,
      dataDir: directory,
      encryptionKey,
      logger: false,
      serveStatic: false,
      fetch: noNetwork,
      httpClient: { post: noNetwork },
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
