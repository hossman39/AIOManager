import { ManagedError } from './errors.js'

export function currentAccountTarget(account, timestamp) {
  if (account.state === 'staged') return null
  if (account.state === 'offboarding') return 'offboard'
  if (account.state !== 'active') throw new ManagedError('INVALID_STATE')
  if (account.suspended_at != null) return 'suspended'
  if (account.lifetime === 1) {
    if (account.expiry_at !== null) throw new ManagedError('INVALID_STATE')
    return 'active'
  }
  return account.expiry_at !== null && account.expiry_at <= timestamp ? 'suspended' : 'active'
}

// Call with the account row locked. Observation is monotonic until an explicit
// membership edit; neither a backward clock nor a publication lifts suspension.
export async function observeSuspension(tx, account, timestamp) {
  if (account.suspended_at == null && currentAccountTarget(account, timestamp) === 'suspended') {
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
