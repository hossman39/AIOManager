import assert from 'node:assert/strict'
import { test } from 'node:test'
import { newYorkExpiryChoices, resolveNewYorkExpiry } from '../shared/new-york-expiry.js'

test('New York expiry converts exact winter, summer, and midnight wall times', () => {
  for (const [local, offset, expected] of [
    ['2027-01-15T10:45', -300, '2027-01-15T15:45:00.000Z'],
    ['2027-07-15T10:45', -240, '2027-07-15T14:45:00.000Z'],
    ['2027-01-01T00:00', -300, '2027-01-01T05:00:00.000Z'],
  ]) {
    const result = resolveNewYorkExpiry(local)
    assert.equal(result.ok, true)
    assert.equal(result.expiry.offset, offset)
    assert.equal(new Date(result.expiry.at).toISOString(), expected)
    assert.equal(result.expiry.timezone, 'America/New_York')
  }
})

test('spring-forward nonexistent times are rejected without rounding', () => {
  assert.deepEqual(resolveNewYorkExpiry('2026-03-08T02:30'), {
    ok: false,
    code: 'NONEXISTENT_EXPIRY',
  })
  assert.equal(resolveNewYorkExpiry('2026-03-08T01:59').expiry.offset, -300)
  assert.equal(resolveNewYorkExpiry('2026-03-08T03:00').expiry.offset, -240)
})

test('fall-back repeated times require explicit occurrence selection', () => {
  const choices = newYorkExpiryChoices('2026-11-01T01:30')
  assert.equal(choices.ok, true)
  assert.deepEqual(
    choices.choices.map((choice) => choice.offset),
    [-240, -300]
  )
  assert.deepEqual(resolveNewYorkExpiry('2026-11-01T01:30'), {
    ok: false,
    code: 'AMBIGUOUS_EXPIRY',
  })
  assert.equal(
    new Date(resolveNewYorkExpiry('2026-11-01T01:30', -240).expiry.at).toISOString(),
    '2026-11-01T05:30:00.000Z'
  )
  assert.equal(
    new Date(resolveNewYorkExpiry('2026-11-01T01:30', -300).expiry.at).toISOString(),
    '2026-11-01T06:30:00.000Z'
  )
})

test('invalid calendar dates, offsets, precision, and nonlocal input are rejected', () => {
  for (const local of [
    '2026-02-29T10:00',
    '2026-13-01T10:00',
    '2026-04-31T10:00',
    '2026-01-01T24:00',
    '2026-01-01T12:60',
    '2026-01-01',
    '2026-01-01T12:00Z',
    '2026-01-01T12:00:45',
    '1899-01-01T12:00',
    null,
    1,
  ]) {
    assert.deepEqual(resolveNewYorkExpiry(local), { ok: false, code: 'INVALID_EXPIRY' })
  }
  assert.equal(resolveNewYorkExpiry('2028-02-29T12:00').ok, true)
  assert.equal(resolveNewYorkExpiry('2027-07-15T12:00', -300).ok, false)
  assert.equal(resolveNewYorkExpiry('2027-07-15T12:00', '-240').ok, false)
})

test('expiry resolution is independent of the process timezone', () => {
  const original = process.env.TZ
  try {
    for (const zone of ['UTC', 'Asia/Tokyo', 'Pacific/Honolulu']) {
      process.env.TZ = zone
      assert.equal(
        new Date(resolveNewYorkExpiry('2026-11-01T01:30', -300).expiry.at).toISOString(),
        '2026-11-01T06:30:00.000Z'
      )
    }
  } finally {
    if (original === undefined) delete process.env.TZ
    else process.env.TZ = original
  }
})
