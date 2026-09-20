import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagedApi, ManagedApiError } from '../src/api/managed'
import { prepareCredentialUpload } from '../src/lib/managed/prepare-import'
import { parseCredentialImport } from '../src/lib/managed/credential-import'
import { deriveSyncToken } from '../src/lib/crypto'
import './helpers'

const auth = { managerId: 'synthetic-manager', password: 'synthetic-manager-password' }
const body = {
  version: '2.0.0',
  accounts: [{ email: 'person@example.invalid', password: ' \tSyntheticPassword🔑\r\n ' }],
}
const publicPreview = {
  sourceFormat: 'aiomanager-2.0.0',
  totalRows: 1,
  accounts: [
    {
      email: 'person@example.invalid',
      name: 'person@example.invalid',
      sourceRows: [1],
      status: 'ready',
    },
  ],
  issues: [],
}
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

test('browser upload allowlists credentials while retaining every source-row issue', () => {
  const source = JSON.stringify({
    ...body,
    accounts: [
      {
        ...body.accounts[0],
        name: 'discard',
        addons: [{ secret: 'addon-private' }],
        authKey: 'provider-private',
      },
      { email: 'PERSON@example.invalid', password: body.accounts[0].password },
      { email: 'other@example.invalid', password: 'first' },
      { email: 'other@example.invalid', password: 'second' },
      { email: 'missing@example.invalid' },
      { email: { secret: 'discard-email' }, password: 'unused' },
      { email: 'bad-password@example.invalid', password: { secret: 'discard-password' } },
      false,
      null,
    ],
    autopilotRules: [{ token: 'automation-private' }],
    vault: 'vault-private',
  })
  const prepared = prepareCredentialUpload(source)
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const upload = JSON.stringify(prepared.upload)
  for (const ignored of [
    'addon-private',
    'provider-private',
    'automation-private',
    'vault-private',
    'discard',
  ])
    assert.ok(!upload.includes(ignored))
  assert.deepEqual(parseCredentialImport(upload), parseCredentialImport(source))
  assert.equal(prepared.upload.accounts[0]?.password, body.accounts[0].password)
})

test('browser preparation rejects unknown formats instead of uploading an unreviewed export', () => {
  const result = prepareCredentialUpload(JSON.stringify({ ...body, version: 'unknown' }))
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.error.code, 'UNSUPPORTED_VERSION')
})

test('managed client sends derived auth headers, no cookies, and refuses redirect forwarding', async () => {
  let calls = 0
  const api = createManagedApi({
    ...auth,
    serverUrl: 'https://synthetic.invalid/api/',
    fetch: async (url, options) => {
      calls++
      assert.equal(url, 'https://synthetic.invalid/api/managed/imports/preview')
      assert.equal(options?.credentials, 'omit')
      assert.equal(options?.redirect, 'error')
      assert.equal(options?.cache, 'no-store')
      assert.equal(options?.referrerPolicy, 'no-referrer')
      const headers = new Headers(options?.headers)
      assert.equal(headers.get('x-manager-id'), auth.managerId)
      assert.equal(headers.get('x-sync-password'), await deriveSyncToken(auth.password))
      assert.ok(!JSON.stringify(options).includes(auth.password))
      return reply(publicPreview)
    },
  })
  await api.previewImport({ accounts: body.accounts })
  assert.equal(calls, 1)
})

test('managed client strips unexpected credential fields from successful response objects', async () => {
  const api = createManagedApi({
    ...auth,
    fetch: async () =>
      reply({
        ...publicPreview,
        password: 'server-secret',
        accounts: [{ ...publicPreview.accounts[0], password: 'another-secret' }],
      }),
  })
  const response = await api.previewImport({ accounts: [] })
  assert.ok(!JSON.stringify(response).includes('secret'))
  assert.ok(!JSON.stringify(response).includes('password'))
})

test('invalid responses and server errors never expose raw error text or parser details', async () => {
  for (const response of [
    reply({ error: { code: 'INTERNAL_ERROR', message: 'password-SECRET' } }, 500),
    reply({ totalRows: 'SECRET', password: 'SECRET' }),
    new Response('SECRET-not-json'),
  ]) {
    const api = createManagedApi({ ...auth, fetch: async () => response })
    await assert.rejects(
      api.status(),
      (error: unknown) => error instanceof ManagedApiError && !error.message.includes('SECRET')
    )
  }
  const api = createManagedApi({
    ...auth,
    fetch: async () => {
      throw new Error('password-SECRET')
    },
  })
  await assert.rejects(api.status(), { code: 'NETWORK_ERROR' })
})

test('invalid server URLs and already-cancelled requests send no credentials', async () => {
  let calls = 0
  const transport: typeof fetch = async () => {
    calls++
    return reply({})
  }
  for (const serverUrl of [
    '//unreviewed.invalid',
    'https://user:password@synthetic.invalid/api',
    'javascript:alert(1)',
    '/api?token=private',
    '/api\\other',
  ]) {
    const api = createManagedApi({ ...auth, serverUrl, fetch: transport })
    await assert.rejects(api.status(), { code: 'INVALID_SERVER' })
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(createManagedApi({ ...auth, fetch: transport }).status(controller.signal), {
    code: 'CANCELLED',
  })
  assert.equal(calls, 0)
})

test('a cancelled in-flight request is not automatically retried or logged', async () => {
  let calls = 0
  const controller = new AbortController()
  const api = createManagedApi({
    ...auth,
    fetch: async (_url, options) => {
      calls++
      controller.abort()
      assert.equal(options?.signal?.aborted, true)
      throw new Error('raw-private-network-error')
    },
  })
  await assert.rejects(api.status(controller.signal), { code: 'CANCELLED' })
  assert.equal(calls, 1)
})
