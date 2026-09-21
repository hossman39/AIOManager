import type { ManagedAccount } from '@/api/managed'

export function accountStatus(account: ManagedAccount) {
  if (account.state === 'offboarding') return 'Removing'
  if (account.expired || account.suspendedAt !== null) return 'Expired'
  if (account.state === 'staged') return 'Sync not started'
  if (account.appliedVersion !== account.policyVersion) return 'Sync pending'
  return 'Synced'
}
export function membershipLabel(account: ManagedAccount) {
  if (account.membershipType === 'lifetime') return 'Lifetime'
  if (!account.expiry) return 'Membership not set'
  return (
    new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: account.expiry.timezone,
    }).format(account.expiry.at) + ` (${account.expiry.timezone})`
  )
}
