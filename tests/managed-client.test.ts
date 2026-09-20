import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createManagedApi, ManagedApiError } from '../src/api/managed'
import { prepareCredentialUpload } from '../src/lib/managed/prepare-import'
import { parseCredentialImport } from '../src/lib/managed/credential-import'
import { deriveSyncToken } from '../src/lib/crypto'
import './helpers'
import type { ManagedGroupDraft } from '../src/api/managed'

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

const publicAccount = {
  id: 'dcc6dd72-eaac-4b5a-aa25-ddba5a6866ce',
  email: 'person@example.invalid',
  name: 'person@example.invalid',
  state: 'staged',
  groupId: null,
  membershipType: 'lifetime',
  version: 2,
  policyVersion: 2,
  expiry: null,
  safeMode: null,
  appliedVersion: null,
  appliedTarget: null,
  verifiedAt: null,
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_100,
}

const groupId = '071c61f8-5bb3-4072-8600-0d36cd7bd724'
const deploymentId = '231b0d49-6a2c-4d75-9201-d4c942b69ad8'
const jobId = '85e5b1bc-7810-4cff-b5ee-ab0f2cc2471b'
const groupDraft: ManagedGroupDraft = {
  name: 'Synthetic group',
  safeMode: null,
  addons: [
    {
      transportUrl: 'https://addon.invalid/CaSe%2fTOKEN/manifest.json?b=2&a=1',
      manifest: {
        id: 'synthetic.addon',
        name: 'Name',
        version: '1.0.0',
        description: 'Description',
        extension: ['retained'],
      },
      flags: { enabled: false, protected: true },
      metadata: { customName: 'Curated' },
      catalogOverrides: { removed: ['movies'] },
    },
  ],
}
const publicGroup = {
  id: groupId,
  name: groupDraft.name,
  version: 2,
  publishedRevision: 1,
  archived: false,
  safeMode: null,
  effectiveSafeMode: true,
  addonCount: 1,
  draft: groupDraft.addons,
  createdAt: 1_790_000_000_000,
  updatedAt: 1_790_000_000_100,
}
const groupPublication = {
  group: publicGroup,
  deploymentId,
  revision: 1,
  queued: 1,
  unchanged: false,
  replayed: false,
}
const publicDeployment = {
  id: deploymentId,
  groupId,
  revision: 1,
  createdAt: 1_790_000_000_100,
  counts: { pending: 1, running: 0, retrying: 0, verified: 0, failed: 0, superseded: 0 },
  skipped: { staged: 0, offboarding: 0 },
  members: [
    {
      accountId: publicAccount.id,
      jobId,
      policyVersion: 2,
      target: 'active',
      status: 'pending',
      errorCode: null,
    },
  ],
}

test('group client sends scoped versioned APIs and retains full customization without extra response fields', async () => {
  const seen: { url: string; key: string | null; body: unknown }[] = []
  const last = () => seen[seen.length - 1]
  let data: unknown
  const api = createManagedApi({
    ...auth,
    fetch: async (url, options) => {
      seen.push({
        url: String(url),
        key: new Headers(options?.headers).get('idempotency-key'),
        body: options?.body ? JSON.parse(String(options.body)) : undefined,
      })
      return reply(data)
    },
  })
  data = {
    group: { ...publicGroup, password: 'discard-private' },
    replayed: false,
    providerToken: 'discard-private',
  }
  const created = await api.createGroup(groupDraft, 'synthetic-request-identifier')
  assert.deepEqual(created.group.draft, groupDraft.addons)
  assert.ok(!JSON.stringify(created).includes('discard-private'))
  assert.deepEqual(last(), {
    url: '/api/managed/groups',
    key: 'synthetic-request-identifier',
    body: groupDraft,
  })
  await api.saveGroupDraft(
    groupId,
    { ...groupDraft, expectedVersion: 2 },
    'synthetic-draft-identifier'
  )
  assert.equal(last()?.url, `/api/managed/groups/${groupId}/draft`)
  assert.equal((last()?.body as { expectedVersion: number }).expectedVersion, 2)
  data = publicGroup
  await api.group(groupId)
  assert.equal(last()?.url, `/api/managed/groups/${groupId}`)
  data = { groups: [publicGroup], nextCursor: groupId }
  const listed = await api.groups(groupId)
  assert.equal(last()?.url, `/api/managed/groups?limit=100&after=${groupId}`)
  assert.ok(!('draft' in listed.groups[0]))
  data = { account: publicAccount, addons: groupDraft.addons, jobId: null, replayed: false }
  await api.personalAddons(publicAccount.id)
  await api.setPersonalAddons(
    publicAccount.id,
    { addons: groupDraft.addons, expectedVersion: 2 },
    'synthetic-personal-identifier'
  )
  assert.equal(last()?.url, `/api/managed/accounts/${publicAccount.id}/personal-addons`)
  data = { accounts: [{ account: publicAccount, jobId: null }], replayed: false }
  const assignment = { groupId, accounts: [{ id: publicAccount.id, expectedVersion: 2 }] }
  await api.assignGroup(assignment, 'synthetic-assignment-identifier')
  assert.deepEqual(last()?.body, assignment)
  data = { manifest: groupDraft.addons[0].manifest }
  assert.deepEqual(
    (await api.resolveManifest(groupDraft.addons[0].transportUrl)).manifest,
    groupDraft.addons[0].manifest
  )
  assert.equal(last()?.url, '/api/managed/manifests/resolve')
  assert.deepEqual(last()?.body, { url: groupDraft.addons[0].transportUrl })
  data = {
    groupId,
    version: 2,
    publishedRevision: 1,
    counts: { active: 1, suspended: 0, staged: 0, offboarding: 0 },
    changes: { added: 1, removed: 0, changed: 0, reordered: false },
    empty: false,
    unchanged: false,
    expiresAt: 1_790_000_300_000,
    receipt: 'opaque-preview-receipt',
  }
  await api.previewGroupPublication(groupId, 2)
  assert.equal(last()?.url, `/api/managed/groups/${groupId}/preview`)
  assert.deepEqual(last()?.body, { expectedVersion: 2 })
  data = publicDeployment
  assert.deepEqual(await api.deployment(deploymentId), publicDeployment)
  assert.equal(last()?.url, `/api/managed/deployments/${deploymentId}`)
})

test('ambiguous publication delivery does not retry automatically and exact retry keeps the receipt and key', async () => {
  const calls: { key: string | null; body: unknown }[] = []
  const api = createManagedApi({
    ...auth,
    fetch: async (url, options) => {
      assert.equal(url, `/api/managed/groups/${groupId}/publish`)
      calls.push({
        key: new Headers(options?.headers).get('idempotency-key'),
        body: JSON.parse(String(options?.body)),
      })
      if (calls.length === 1) throw new Error('Synthetic response lost after commit')
      return reply({ ...groupPublication, replayed: true })
    },
  })
  const payload = { expectedVersion: 1, receipt: 'opaque-original-preview', allowEmpty: false }
  await assert.rejects(api.publishGroup(groupId, payload, 'synthetic-publication-identifier'), {
    code: 'NETWORK_ERROR',
  })
  assert.equal(calls.length, 1)
  const replay = await api.publishGroup(groupId, payload, 'synthetic-publication-identifier')
  assert.equal(replay.replayed, true)
  assert.deepEqual(calls[0], calls[1])
  assert.deepEqual(calls[0].body, payload)
})

test('group client rejects incomplete configurations and contradictory rollout progress', async () => {
  let data: unknown
  const api = createManagedApi({ ...auth, fetch: async () => reply(data) })
  for (const invalid of [
    { ...publicGroup, addonCount: 2 },
    { ...publicGroup, draft: [{}] },
    { ...publicGroup, draft: null },
  ]) {
    data = invalid
    await assert.rejects(api.group(groupId), { code: 'INVALID_RESPONSE' })
  }
  data = { ...groupPublication, revision: 2 }
  await assert.rejects(
    api.publishGroup(
      groupId,
      { expectedVersion: 1, receipt: 'synthetic', allowEmpty: false },
      'synthetic-publication-key'
    ),
    { code: 'INVALID_RESPONSE' }
  )
  for (const invalid of [
    { ...publicDeployment, counts: { ...publicDeployment.counts, verified: 1 } },
    {
      ...publicDeployment,
      members: [...publicDeployment.members, ...publicDeployment.members],
      counts: { ...publicDeployment.counts, pending: 2 },
    },
    {
      ...publicDeployment,
      members: [{ ...publicDeployment.members[0], errorCode: 'SECRET-server-trace' }],
    },
  ]) {
    data = invalid
    await assert.rejects(api.deployment(deploymentId), { code: 'INVALID_RESPONSE' })
  }
  data = { manifest: { id: 'partial', name: 'SECRET' } }
  await assert.rejects(api.resolveManifest('https://synthetic.invalid/manifest.json'), {
    code: 'INVALID_RESPONSE',
  })
})

test('manifest and publication client errors use fixed messages, not raw provider URLs or traces', async () => {
  for (const code of [
    'MANIFEST_INVALID',
    'MANIFEST_UNSAFE_URL',
    'MANIFEST_ID_MISMATCH',
    'MANIFEST_CONFIGURATION_REQUIRED',
    'MANIFEST_TIMEOUT',
    'MANIFEST_BUSY',
    'PREVIEW_STALE',
    'ADDON_LAYER_CONFLICT',
  ]) {
    const api = createManagedApi({
      ...auth,
      fetch: async () => reply({ error: { code, message: 'https://private.invalid/SECRET' } }, 422),
    })
    await assert.rejects(
      api.previewGroupPublication(groupId, 2),
      (error: unknown) =>
        error instanceof ManagedApiError && error.code === code && !error.message.includes('SECRET')
    )
  }
})

test('membership client preserves the exact retry key and selected New York occurrence', async () => {
  const change = {
    mode: 'term' as const,
    expectedVersion: 2,
    local: '2026-11-01T01:30',
    offset: -300,
  }
  const key = 'synthetic-membership-retry-key'
  let calls = 0
  const api = createManagedApi({
    ...auth,
    fetch: async (url, options) => {
      calls++
      assert.equal(url, `/api/managed/accounts/${publicAccount.id}/membership`)
      assert.equal(options?.method, 'POST')
      assert.equal(new Headers(options?.headers).get('idempotency-key'), key)
      assert.deepEqual(JSON.parse(String(options?.body)), change)
      if (calls === 1) throw new Error('synthetic lost response')
      return reply({
        account: {
          ...publicAccount,
          membershipType: 'term',
          expiry: {
            at: Date.parse('2026-11-01T06:30:00Z'),
            local: change.local,
            offset: -300,
            timezone: 'America/New_York',
          },
          password: 'private-secret',
        },
        jobId: null,
        replayed: true,
      })
    },
  })
  await assert.rejects(api.setMembership(publicAccount.id, change, key), { code: 'NETWORK_ERROR' })
  assert.equal(calls, 1)
  const result = await api.setMembership(publicAccount.id, change, key)
  assert.equal(result.account.membershipType, 'term')
  assert.equal(result.account.expiry?.offset, -300)
  assert.equal(result.replayed, true)
  assert.ok(!JSON.stringify(result).includes('private-secret'))
})

test('membership client rejects contradictory lifetime/date responses', async () => {
  for (const account of [
    { ...publicAccount, membershipType: 'term', expiry: null },
    {
      ...publicAccount,
      membershipType: 'lifetime',
      expiry: { at: 0, local: '1970-01-01T00:00', offset: -300, timezone: 'America/New_York' },
    },
    { ...publicAccount, membershipType: 'unknown' },
  ]) {
    const api = createManagedApi({ ...auth, fetch: async () => reply(account) })
    await assert.rejects(api.account(publicAccount.id), { code: 'INVALID_RESPONSE' })
  }
})

test('managed requests follow the existing absolute sync-server root convention', async () => {
  for (const [serverUrl, endpoint] of [
    ['', '/api/managed/accounts'],
    ['/custom-api/', '/custom-api/managed/accounts'],
    ['https://synthetic.invalid', 'https://synthetic.invalid/api/managed/accounts'],
    ['https://synthetic.invalid/', 'https://synthetic.invalid/api/managed/accounts'],
    [
      'https://synthetic.invalid/subpath/',
      'https://synthetic.invalid/subpath/api/managed/accounts',
    ],
    [
      'https://synthetic.invalid/subpath/api/',
      'https://synthetic.invalid/subpath/api/managed/accounts',
    ],
  ]) {
    let requested: unknown
    const api = createManagedApi({
      ...auth,
      serverUrl,
      fetch: async (url) => {
        requested = url
        return reply({ accounts: [], nextCursor: null })
      },
    })
    await api.accounts()
    assert.equal(requested, `${endpoint}?limit=100`)
  }
})
