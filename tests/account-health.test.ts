import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  accountAttention,
  backupAttention,
  compareAccounts,
  expiresWithin,
} from '../src/lib/managed/account-health'
import type { ManagedAccount, ManagedStatus } from '../src/api/managed'

const now = Date.UTC(2026, 8, 22)
const account: ManagedAccount = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'synthetic@example.invalid',
  name: 'Example',
  state: 'active',
  groupId: null,
  setupSaved: true,
  membershipType: 'term',
  version: 1,
  policyVersion: 1,
  expiry: { at: now + 7 * 86_400_000, local: '2026-09-29T00:00', offset: 0, timezone: 'Etc/UTC' },
  safeMode: null,
  suspendedAt: null,
  expired: false,
  appliedVersion: 1,
  appliedTarget: 'active',
  verifiedAt: now,
  createdAt: now,
  updatedAt: now,
}
test('expiry windows honor exact cutoffs, suspension, lifetime and stable ordering', () => {
  assert.equal(expiresWithin(account, 7, now), true)
  assert.equal(expiresWithin(account, 7, now - 1), false)
  assert.equal(expiresWithin(account, 30, account.expiry!.at), false)
  assert.equal(expiresWithin({ ...account, suspendedAt: now }, 30, now), false)
  assert.equal(expiresWithin({ ...account, state: 'offboarding' }, 30, now), false)
  const lifetime = { ...account, id: 'z', membershipType: 'lifetime' as const, expiry: null }
  assert.equal(expiresWithin(lifetime, 30, now), false)
  assert.ok(compareAccounts(account, lifetime, 'expiry') < 0)
  assert.ok(Number.isFinite(compareAccounts(lifetime, { ...lifetime, id: 'y' }, 'expiry')))
})
test('attention separates incomplete setup, failed work and ordinary short pending work', () => {
  assert.deepEqual(accountAttention(account, now), [])
  assert.equal(
    accountAttention(
      { ...account, state: 'staged', membershipType: 'unset', expiry: null, setupSaved: false },
      now
    ).length,
    3
  )
  const syncJob = { state: 'pending' as const, errorCode: null, dueAt: now, updatedAt: now }
  assert.deepEqual(accountAttention({ ...account, syncJob }, now), [])
  assert.equal(accountAttention({ ...account, syncJob }, now + 120_001).length, 1)
  assert.match(
    accountAttention({ ...account, syncJob: { ...syncJob, state: 'failed' } }, now)[0],
    /failed/
  )
  assert.match(
    accountAttention({ ...account, syncJob: { ...syncJob, state: 'retrying' } }, now)[0],
    /retrying/
  )
})
test('backup warnings distinguish disabled, never recorded and overdue backups', () => {
  const status = { capabilities: { backupsEnabled: true }, lastBackupAt: now } as ManagedStatus
  assert.equal(backupAttention(null, now), null)
  assert.equal(backupAttention(status, now + 25 * 3_600_000), null)
  assert.match(backupAttention(status, now + 27 * 3_600_000)!, /26 hours/)
  assert.match(backupAttention({ ...status, lastBackupAt: null }, now)!, /No successful/)
  assert.match(
    backupAttention(
      { ...status, capabilities: { ...status.capabilities, backupsEnabled: false } },
      now
    )!,
    /disabled/
  )
})
