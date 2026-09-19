import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalJson, createEnvelopeCrypto, equalSecret } from '../server/managed/crypto.js'

const context = { owner: 'synthetic-owner', id: 'synthetic-account', purpose: 'credentials' }
const crypto = createEnvelopeCrypto({ primary: 'synthetic-key' })

test('managed envelopes round-trip exact Unicode and whitespace without deterministic ciphertext', () => {
  const value = { email: 'Person@example.invalid', password: ' \tSécret\r\n🔑 ', ignored: null }
  const first = crypto.seal(value, context)
  const second = crypto.seal(value, context)
  assert.notEqual(first, second)
  assert.ok(!first.includes(value.password))
  assert.deepEqual(crypto.open(first, context), value)
})

test('managed decryption rejects plaintext, unknown versions, corruption, and extra fields', () => {
  const encrypted = crypto.seal({ password: 'private-synthetic' }, context)
  const envelope = JSON.parse(encrypted)
  for (const invalid of [
    'private-synthetic',
    'https://synthetic.invalid/manifest.json',
    null,
    'null',
    '{}',
    JSON.stringify({ ...envelope, v: 2 }),
    JSON.stringify({ ...envelope, tag: 'AAAAAAAAAAAAAAAAAAAAAA' }),
    JSON.stringify({ ...envelope, iv: `${envelope.iv}=` }),
    JSON.stringify({ ...envelope, ct: envelope.ct.slice(1) }),
    JSON.stringify({ ...envelope, additional: 'untrusted' }),
  ]) {
    assert.throws(() => crypto.open(invalid, context), { code: 'DATA_UNREADABLE' })
  }
})

test('managed ciphertext is bound to owner, record, and field purpose', () => {
  const encrypted = crypto.seal({ password: 'synthetic' }, context)
  for (const field of ['owner', 'id', 'purpose']) {
    assert.throws(() => crypto.open(encrypted, { ...context, [field]: 'another' }), {
      code: 'DATA_UNREADABLE',
    })
  }
})

test('managed key ring reads old records without treating a wrong key as plaintext', () => {
  const encrypted = crypto.seal({ value: 7 }, context)
  const rotated = createEnvelopeCrypto({
    primary: 'synthetic-new-key',
    candidates: ['synthetic-key'],
  })
  assert.deepEqual(rotated.open(encrypted, context), { value: 7 })
  const newer = rotated.seal({ value: 8 }, context)
  assert.deepEqual(createEnvelopeCrypto({ primary: 'synthetic-new-key' }).open(newer, context), {
    value: 8,
  })
  assert.throws(() => crypto.open(newer, context), { code: 'DATA_UNREADABLE' })
  assert.throws(() => createEnvelopeCrypto({ primary: '' }), { code: 'DATA_UNREADABLE' })
})

test('canonical fingerprints preserve ordered arrays, case and secret bytes but not object key order', () => {
  assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }))
  assert.notEqual(canonicalJson(['one', 'two']), canonicalJson(['two', 'one']))
  assert.notEqual(canonicalJson(' /Config/ABC '), canonicalJson('/config/abc'))
  for (const value of [
    undefined,
    NaN,
    Infinity,
    new Date(),
    { value: undefined },
    new Array(2),
    1n,
  ]) {
    assert.throws(() => canonicalJson(value), { code: 'INVALID_INPUT' })
  }
  assert.equal(equalSecret(' ', ''), false)
  assert.equal(equalSecret('equal', 'equal'), true)
  assert.equal(equalSecret(null, ''), false)
})
