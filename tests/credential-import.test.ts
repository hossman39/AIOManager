import assert from 'node:assert/strict'
import { test } from 'node:test'
import './helpers'
import {
  MAX_CREDENTIAL_IMPORT_BYTES,
  MAX_CREDENTIAL_IMPORT_ROWS,
  parseCredentialImport,
} from '../src/lib/managed/credential-import'

const credential = { email: 'client@example.invalid', password: ' Synthetic pAssword \t' }
function parseRows(accounts: unknown[]) {
  const result = parseCredentialImport(JSON.stringify({ version: '2.0.0', accounts }))
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error('Expected valid envelope')
  return result
}

test('current export imports only email/password; email becomes the display name', () => {
  const result = parseRows([
    {
      ...credential,
      id: 'old-id',
      name: 'Ignored name',
      authKey: 'ignored-token',
      addons: 'invalid but irrelevant',
      expiry: '2001-01-01',
      history: ['ignored'],
    },
  ])
  assert.equal(result.sourceFormat, 'aiomanager-2.0.0')
  assert.deepEqual(result.accounts, [{ ...credential, name: credential.email, sourceRows: [1] }])
  assert.deepEqual(result.issues, [])
})

test('password bytes, whitespace and Unicode are preserved without normalization', () => {
  for (const password of ['  ', '\t\n secret \u0000', 'é e\u0301 🔑', 'UPPERlower+/=']) {
    assert.equal(parseRows([{ ...credential, password }]).accounts[0].password, password)
  }
})

test('email whitespace is trimmed; login case is retained', () => {
  const result = parseRows([{ ...credential, email: '  Client@Example.invalid  ' }])
  assert.equal(result.accounts[0].email, 'Client@Example.invalid')
  assert.equal(result.accounts[0].name, 'Client@Example.invalid')
})

for (const data of [[credential], { accounts: [credential] }]) {
  test(`supports legacy ${Array.isArray(data) ? 'array' : 'account envelope'} without addon data`, () => {
    const result = parseCredentialImport(JSON.stringify(data))
    assert.ok(result.ok)
    assert.equal(result.sourceFormat, 'legacy-account-list')
    assert.equal(result.accounts.length, 1)
  })
}

test('optional UTF-8 BOM is accepted', () => {
  assert.ok(parseCredentialImport('\uFEFF' + JSON.stringify([credential])).ok)
})

test('empty account export is valid and does not manufacture users', () => {
  assert.deepEqual(parseRows([]), {
    ok: true,
    sourceFormat: 'aiomanager-2.0.0',
    totalRows: 0,
    accounts: [],
    issues: [],
  })
})

test('malformed unrelated export sections are ignored', () => {
  const result = parseCredentialImport(
    JSON.stringify({
      version: '2.0.0',
      accounts: [credential],
      manifests: null,
      addons: 1,
      profiles: false,
      failover: 'ignored',
      identity: { password: 'ignored' },
      accountStates: { credentials: 'ignored' },
    })
  )
  assert.ok(result.ok)
  assert.deepEqual(result.accounts, parseRows([credential]).accounts)
})

for (const [label, data, code] of [
  ['malformed JSON', '{"password":"never-echo-this', 'INVALID_JSON'],
  ['scalar', '"never-echo-this"', 'UNSUPPORTED_FORMAT'],
  ['null', 'null', 'UNSUPPORTED_FORMAT'],
  ['missing accounts', '{}', 'UNSUPPORTED_FORMAT'],
  ['invalid accounts', '{"accounts":{}}', 'UNSUPPORTED_FORMAT'],
  ['unknown version', '{"version":"never-echo-this","accounts":[]}', 'UNSUPPORTED_VERSION'],
  ['null version', '{"version":null,"accounts":[]}', 'UNSUPPORTED_VERSION'],
] as const) {
  test(`rejects ${label} without echoing input`, () => {
    const result = parseCredentialImport(data)
    assert.equal(result.ok, false)
    if (result.ok) throw new Error('Expected envelope error')
    assert.equal(result.error.code, code)
    assert.ok(!JSON.stringify(result).includes('never-echo-this'))
  })
}

test('enforces size limit before parsing and counts UTF-8 bytes', () => {
  for (const data of [
    'x'.repeat(MAX_CREDENTIAL_IMPORT_BYTES + 1),
    'é'.repeat(MAX_CREDENTIAL_IMPORT_BYTES / 2 + 1),
  ]) {
    const result = parseCredentialImport(data)
    assert.ok(!result.ok)
    assert.equal(result.error.code, 'FILE_TOO_LARGE')
  }
})

test('enforces record limit', () => {
  const result = parseCredentialImport(
    JSON.stringify(Array(MAX_CREDENTIAL_IMPORT_ROWS + 1).fill(null))
  )
  assert.ok(!result.ok)
  assert.equal(result.error.code, 'TOO_MANY_ACCOUNTS')
})

test('invalid rows report fixed messages and retain row numbers', () => {
  const result = parseRows([
    null,
    [],
    42,
    { ...credential, email: 'not-an-email' },
    { email: credential.email },
    { ...credential, password: '' },
    { ...credential, password: null },
    { ...credential, password: 42 },
    credential,
  ])
  assert.deepEqual(
    result.issues.map((issue) => [issue.row, issue.code]),
    [
      [1, 'INVALID_RECORD'],
      [2, 'INVALID_RECORD'],
      [3, 'INVALID_RECORD'],
      [4, 'INVALID_EMAIL'],
      [5, 'MISSING_PASSWORD'],
      [6, 'MISSING_PASSWORD'],
      [7, 'MISSING_PASSWORD'],
      [8, 'INVALID_PASSWORD'],
    ]
  )
  assert.equal(result.accounts.length, 1)
  assert.deepEqual(result.accounts[0].sourceRows, [9])
  assert.ok(!JSON.stringify(result.issues).includes(credential.email))
  assert.ok(!JSON.stringify(result.issues).includes(credential.password))
})

test('identical credentials deduplicate conservatively without losing source row mapping', () => {
  const result = parseRows([
    credential,
    { ...credential, email: 'CLIENT@example.invalid' },
    credential,
  ])
  assert.equal(result.accounts.length, 1)
  assert.deepEqual(result.accounts[0].sourceRows, [1, 2, 3])
  assert.deepEqual(
    result.issues.map((issue) => issue.code),
    ['DUPLICATE_ROW', 'DUPLICATE_ROW']
  )
})

test('conflicting passwords block all rows for that email, not just the later row', () => {
  const result = parseRows([
    credential,
    { ...credential, password: credential.password.trim() },
    credential,
    { email: 'other@example.invalid', password: 'Synthetic only' },
  ])
  assert.deepEqual(
    result.accounts.map((account) => account.email),
    ['other@example.invalid']
  )
  assert.deepEqual(
    result.issues.map((issue) => [issue.row, issue.code]),
    [
      [1, 'CONFLICTING_PASSWORD'],
      [2, 'CONFLICTING_PASSWORD'],
      [3, 'CONFLICTING_PASSWORD'],
    ]
  )
})

test('repeated parsing is deterministic and never activates source automation', () => {
  const data = JSON.stringify({
    version: '2.0.0',
    accounts: [credential],
    failover: { enabled: true },
    autopilot: { enabled: true },
    expiry: '2000-01-01',
  })
  // helpers disables fetch/http/https; the parser imports no store/provider modules.
  assert.deepEqual(parseCredentialImport(data), parseCredentialImport(data))
})
