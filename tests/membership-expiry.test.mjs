import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  expiryChoices,
  resolveExpiry,
  resolveExpiryDate,
  validMembershipTimezone,
} from '../shared/membership-expiry.js'

test('membership runs through the last local instant, including short, long and skipped days', () => {
  for (const [date, zone, end] of [
    ['2026-03-08', 'America/New_York', '2026-03-09T04:00:00Z'],
    ['2026-11-01', 'America/New_York', '2026-11-02T05:00:00Z'],
    ['2028-02-29', 'Asia/Kathmandu', '2028-02-29T18:15:00Z'],
    ['2018-11-03', 'America/Sao_Paulo', '2018-11-04T03:00:00Z'],
    ['2011-12-29', 'Pacific/Apia', '2011-12-30T10:00:00Z'],
    ['2027-12-31', 'UTC', '2028-01-01T00:00:00Z'],
  ]) {
    const { expiry } = resolveExpiryDate(date, zone)
    assert.equal(expiry.at, Date.parse(end))
    assert.equal(expiry.local, date)
  }
  assert.equal(resolveExpiryDate('2011-12-30', 'Pacific/Apia').code, 'NONEXISTENT_EXPIRY')
  assert.equal(resolveExpiryDate('2026-02-29').code, 'INVALID_EXPIRY')
})

test('selectable zones resolve fractional-hour offsets, UTC and the New York default', () => {
  for (const [zone, expected] of [
    ['Asia/Kathmandu', '2027-01-01T06:15:00Z'],
    ['Asia/Kolkata', '2027-01-01T06:30:00Z'],
    ['Pacific/Kiritimati', '2026-12-31T22:00:00Z'],
    ['UTC', '2027-01-01T12:00:00Z'],
    [undefined, '2027-01-01T17:00:00Z'],
  ]) {
    const result = resolveExpiry('2027-01-01T12:00', undefined, zone)
    assert.equal(result.ok, true)
    assert.equal(result.expiry.at, Date.parse(expected))
    assert.equal(result.expiry.timezone, zone ?? 'America/New_York')
  }
})
test('southern half-hour DST folds require a choice and gaps/skipped dates are rejected', () => {
  const result = expiryChoices('2026-04-05T01:45', 'Australia/Lord_Howe')
  assert.deepEqual(
    result.choices.map((choice) => choice.offset),
    [660, 630]
  )
  assert.equal(
    resolveExpiry('2026-04-05T01:45', undefined, 'Australia/Lord_Howe').code,
    'AMBIGUOUS_EXPIRY'
  )
  assert.equal(
    resolveExpiry('2026-10-04T02:15', undefined, 'Australia/Lord_Howe').code,
    'NONEXISTENT_EXPIRY'
  )
  assert.equal(
    resolveExpiry('2011-12-30T12:00', undefined, 'Pacific/Apia').code,
    'NONEXISTENT_EXPIRY'
  )
  assert.equal(
    resolveExpiry('2026-03-29T02:30', undefined, 'Europe/Berlin').code,
    'NONEXISTENT_EXPIRY'
  )
})
test('every supported named timezone resolves ordinary winter and summer cutoffs', () => {
  for (const zone of Intl.supportedValuesOf('timeZone'))
    for (const local of ['2026-01-15T12:34', '2026-07-15T12:34']) {
      const result = resolveExpiry(local, undefined, zone)
      assert.equal(result.ok, true, zone)
      assert.equal(
        result.expiry.at + Math.round(result.expiry.offset * 60_000),
        Date.parse(`${local}:00Z`)
      )
    }
  for (const zone of ['Bad/Timezone', '', '+05:00', null, {}, ' UTC'])
    assert.equal(validMembershipTimezone(zone), false)
})
