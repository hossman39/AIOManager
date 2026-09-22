import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../server/app.js'
import { DB } from '../server/db.js'

async function removeSyntheticDirectory(directory) {
  const target = path.resolve(directory)
  assert.equal(path.dirname(target), path.resolve(tmpdir()))
  assert.ok(path.basename(target).startsWith('aiomanager-server-test-'))
  await rm(target, { recursive: true, force: true })
}

async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-server-test-'))
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: path.join(directory, 'aio.db') })
  let calls = 0
  const rejectNetwork = async () => {
    calls++
    throw new Error('Network disabled in lifecycle tests')
  }
  let app
  t.after(async () => {
    try {
      if (app) await app.close()
      else await db.close()
    } finally {
      await removeSyntheticDirectory(directory)
    }
  })
  app = await buildServer({
    env: {},
    database: db,
    dataDir: directory,
    encryptionKey: 'synthetic-key-for-tests-only',
    logger: false,
    serveStatic: false,
    fetch: rejectNetwork,
    httpClient: { post: rejectNetwork },
    ...overrides,
  })
  return { app, db, directory, networkCalls: () => calls }
}

test('importing server factory has no filesystem, listener, signal, or worker side effects', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-server-test-'))
  t.after(() => removeSyntheticDirectory(directory))
  const target = path.join(directory, 'must-not-exist')
  const script = `
    import fs from 'node:fs';
    const before = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    await import(${JSON.stringify(new URL('../server/app.js', import.meta.url).href)});
    const after = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    console.log(JSON.stringify({before, after, created: fs.existsSync(process.env.DATA_DIR)}));
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, DATA_DIR: target },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { before: 0, after: 0, created: false })
})

test('isolated server supports health injection without a listener or background work', async (t) => {
  const { app, networkCalls } = await fixture(t)
  const response = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().database.healthy, true)
  assert.equal(response.json().autopilot.lastRun, 0)
  assert.equal(response.json().autopilot.running, false)
  assert.equal(app.server.listening, false)
  assert.equal(networkCalls(), 0)
})

test('existing encrypted sync round-trip survives the server/database extraction', async (t) => {
  const { app, db, directory } = await fixture(t)
  const headers = { 'x-sync-password': 'synthetic-sync-secret' }
  const payload = { encryptedPayload: 'synthetic-private-data', accounts: [] }
  const saved = await app.inject({
    method: 'POST',
    url: '/api/sync/synthetic-manager',
    headers,
    payload,
  })
  assert.equal(saved.statusCode, 200, saved.body)
  const loaded = await app.inject({ method: 'GET', url: '/api/sync/synthetic-manager', headers })
  assert.equal(loaded.statusCode, 200)
  assert.equal(loaded.json().encryptedPayload, payload.encryptedPayload)
  const row = await db.get('SELECT * FROM kv_store WHERE key = $1', ['synthetic-manager'])
  assert.ok(!row.value.includes(payload.encryptedPayload))
  assert.ok(!row.password.includes(headers['x-sync-password']))
  await app.close()
  const raw = await readFile(path.join(directory, 'aio.db'))
  assert.equal(raw.includes(Buffer.from(payload.encryptedPayload)), false)
  assert.equal(raw.includes(Buffer.from(headers['x-sync-password'])), false)
})

test('legacy sync rejects an incorrect manager password without changing saved data', async (t) => {
  const { app } = await fixture(t)
  const url = '/api/sync/synthetic-manager'
  await app.inject({
    method: 'POST',
    url,
    headers: { 'x-sync-password': 'right' },
    payload: { value: 'keep' },
  })
  for (const method of ['GET', 'POST', 'DELETE']) {
    const response = await app.inject({
      method,
      url,
      headers: { 'x-sync-password': 'wrong' },
      ...(method === 'POST' ? { payload: { value: 'replace' } } : {}),
    })
    assert.equal(response.statusCode, 401)
  }
  const response = await app.inject({ method: 'GET', url, headers: { 'x-sync-password': 'right' } })
  assert.equal(response.json().value, 'keep')
})

test('app instances keep their state and custom configuration separate', async (t) => {
  const first = await fixture(t, { env: { CUSTOM_HTML: 'first' } })
  const second = await fixture(t, { env: { CUSTOM_HTML: 'second' } })
  assert.equal((await first.app.inject('/api/config')).json().customHtml, 'first')
  assert.equal((await second.app.inject('/api/config')).json().customHtml, 'second')
  await first.db.run('INSERT INTO kv_store (key) VALUES ($1)', ['only-first'])
  assert.equal(
    await second.db.get('SELECT * FROM kv_store WHERE key = $1', ['only-first']),
    undefined
  )
})

test('default construction and listening do not start workers without an explicit opt-in', async (t) => {
  const { app, networkCalls } = await fixture(t)
  await app.listen({ host: '127.0.0.1', port: 0 })
  assert.equal((await app.inject('/api/health')).json().autopilot.lastRun, 0)
  await app.close()
  assert.equal(app.server.listening, false)
  assert.equal(networkCalls(), 0)
})

test('explicit worker startup runs only after listen and shuts down cleanly', async (t) => {
  const { app, db, networkCalls } = await fixture(t, { backgroundWorkers: true })
  assert.equal((await app.inject('/api/health')).json().autopilot.lastRun, 0)
  await app.listen({ host: '127.0.0.1', port: 0 })
  assert.ok((await app.inject('/api/health')).json().autopilot.lastRun > 0)
  await app.close()
  assert.equal(db.client, null)
  assert.equal(networkCalls(), 0)
})

test('server construction failure closes its database', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-server-test-'))
  t.after(() => removeSyntheticDirectory(directory))
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  const originalExec = db.exec.bind(db)
  db.exec = (sql) =>
    sql.includes('CREATE TABLE')
      ? Promise.reject(new Error('Synthetic schema error'))
      : originalExec(sql)
  await assert.rejects(
    buildServer({
      env: {},
      dataDir: directory,
      database: db,
      encryptionKey: 'synthetic',
      logger: false,
    }),
    /Synthetic schema error/
  )
  assert.equal(db.client, null)
})

test('generated encryption keys persist across restarts', async (t) => {
  const first = await fixture(t, { encryptionKey: undefined })
  const key = await readFile(path.join(first.directory, 'server_secret.key'), 'utf8')
  assert.match(key, /^[a-f0-9]{64}$/)
  const headers = { 'x-sync-password': 'synthetic-password' }
  await first.app.inject({
    method: 'POST',
    url: '/api/sync/synthetic-manager',
    headers,
    payload: { value: 'retained' },
  })
  await first.app.close()
  const second = await buildServer({
    env: {},
    dataDir: first.directory,
    logger: false,
    serveStatic: false,
  })
  try {
    const response = await second.inject({
      method: 'GET',
      url: '/api/sync/synthetic-manager',
      headers,
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().value, 'retained')
    assert.equal(await readFile(path.join(first.directory, 'server_secret.key'), 'utf8'), key)
  } finally {
    await second.close()
  }
})

test('missing encryption key with retained data stops startup without generating a replacement', async (t) => {
  const first = await fixture(t, { encryptionKey: undefined })
  await first.app.inject({
    method: 'POST',
    url: '/api/sync/synthetic-manager',
    headers: { 'x-sync-password': 'synthetic-password' },
    payload: { value: 'retained' },
  })
  await first.app.close()
  const filename = path.join(first.directory, 'server_secret.key')
  // Delete only the exact synthetic fixture key to model volume/key loss.
  await unlink(filename)
  await assert.rejects(
    buildServer({ env: {}, dataDir: first.directory, logger: false }),
    /key is missing/
  )
  await assert.rejects(readFile(filename), { code: 'ENOENT' })
})

test('an empty persistent key is an error, not permission to replace it', async (t) => {
  const first = await fixture(t, { encryptionKey: undefined })
  await first.app.close()
  const filename = path.join(first.directory, 'server_secret.key')
  await writeFile(filename, '', 'utf8')
  await assert.rejects(
    buildServer({ env: {}, dataDir: first.directory, logger: false }),
    /key is empty/
  )
  assert.equal(await readFile(filename, 'utf8'), '')
})

test('static plugin still serves the built SPA and rejects source file disclosure', async (t) => {
  const { app } = await fixture(t, {
    serveStatic: true,
    staticDir: fileURLToPath(new URL('./fixtures/site', import.meta.url)),
  })
  const index = await app.inject('/')
  assert.equal(index.statusCode, 200)
  assert.match(index.headers['content-type'], /text\/html/)
  const route = await app.inject('/settings')
  assert.equal(route.statusCode, 200)
  for (const url of ['/../server/crypto.js', '/%2e%2e/server/crypto.js', '/server%2fcrypto.js']) {
    const response = await app.inject(url)
    assert.ok(!response.body.includes('createCipheriv'))
  }
})
