import { ManagedError } from './errors.js'

export const awaitingGroupSync = (account) =>
  account.state === 'staged' &&
  account.group_sync_requested === 1 &&
  !!account.group_id &&
  (account.lifetime === 1 || account.expiry_at !== null)

export function currentAccountTarget(account, timestamp) {
  if (account.state === 'staged') return null
  if (account.state === 'offboarding') return 'offboard'
  if (account.state !== 'active') throw new ManagedError('INVALID_STATE')
  if (account.access_override === 'active' || account.access_override === 'suspended')
    return account.access_override
  if (account.suspended_at != null) return 'suspended'
  if (account.lifetime === 1) {
    if (account.expiry_at !== null) throw new ManagedError('INVALID_STATE')
    return 'active'
  }
  return account.expiry_at !== null && account.expiry_at <= timestamp ? 'suspended' : 'active'
}

export function membershipSyncCause(previous, updated, timestamp) {
  if (currentAccountTarget(updated, timestamp) === 'suspended') return 'expiry'
  return currentAccountTarget(previous, timestamp) === 'suspended' ? 'renewal' : 'manual'
}

// These columns only occur on managed_accounts in queries that use this predicate.
export const expiredMembershipSql = (at) =>
  `(access_override = 'suspended' OR (access_override = 'automatic'
    AND (suspended_at IS NOT NULL OR (lifetime = 0 AND expiry_at <= ${at}))))`

// Call with the account row locked. Observation is monotonic until an explicit
// membership edit; neither a backward clock nor a publication lifts suspension.
export async function observeSuspension(tx, account, timestamp) {
  if (
    (account.access_override ?? 'automatic') === 'automatic' &&
    account.suspended_at == null &&
    currentAccountTarget(account, timestamp) === 'suspended'
  ) {
    await tx.run(
      `UPDATE managed_accounts SET suspended_at = $1, record_version = record_version + 1,
      updated_at = $1 WHERE owner_id = $2 AND id = $3 AND suspended_at IS NULL`,
      [timestamp, account.owner_id, account.id]
    )
    Object.assign(account, {
      suspended_at: timestamp,
      record_version: account.record_version + 1,
      updated_at: timestamp,
    })
  }
  return account
}
