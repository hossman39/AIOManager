import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureManagedSubmission, managedFailure } from '../src/lib/managed/submission'
import { ManagedApiError } from '../src/api/managed'
import './helpers'

test('captured managed submissions isolate exact payload and key from later form changes', () => {
  const value = { receipt: 'opaque-receipt', expectedVersion: 2, nested: { addons: ['CaSeToken'] } }
  const ticket = captureManagedSubmission(value, 'synthetic-fixed-request-key')
  value.receipt = 'changed'
  value.expectedVersion = 9
  value.nested.addons[0] = 'different'
  assert.deepEqual(ticket, {
    key: 'synthetic-fixed-request-key',
    value: { receipt: 'opaque-receipt', expectedVersion: 2, nested: { addons: ['CaSeToken'] } },
  })
  assert.equal(Object.isFrozen(ticket), true)
})

test('uncertain writes retain their retry identity while explicit conflicts require fresh state', () => {
  for (const code of [
    'NETWORK_ERROR',
    'INVALID_RESPONSE',
    'REQUEST_FAILED',
    'CANCELLED',
  ] as const) {
    assert.equal(managedFailure(new ManagedApiError(code)).uncertain, true)
    assert.equal(managedFailure(new ManagedApiError(code)).stale, false)
  }
  for (const code of [
    'VERSION_CONFLICT',
    'IDEMPOTENCY_CONFLICT',
    'PREVIEW_STALE',
    'INVALID_STATE',
  ] as const) {
    assert.equal(managedFailure(new ManagedApiError(code)).uncertain, false)
    assert.equal(managedFailure(new ManagedApiError(code)).stale, true)
  }
  for (const code of [
    'INVALID_ADDON_CONFIG',
    'MANIFEST_INVALID',
    'EMPTY_PUBLICATION_CONFIRMATION',
  ] as const) {
    assert.equal(managedFailure(new ManagedApiError(code)).uncertain, false)
    assert.equal(managedFailure(new ManagedApiError(code)).stale, false)
  }
  assert.ok(!managedFailure(new Error('SECRET-private-URL')).message.includes('SECRET'))
  assert.equal(managedFailure(new Error('SECRET-private-URL')).uncertain, true)
})
