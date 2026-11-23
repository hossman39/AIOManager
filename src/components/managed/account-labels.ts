import type { ManagedAccount } from '@/api/managed'

const membershipDate = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' })

export function accountStatus(account: ManagedAccount) {
  if (account.state === 'offboarding') return 'Removing'
  if (account.state === 'staged' && account.groupSyncRequested) {
    if (account.membershipType === 'unset') return 'Group saved · set membership'
    if (account.syncJob?.state === 'failed') return 'Group sync failed'
    return 'Group sync requested'
  }
  if (account.accessOverride === 'active' || account.accessOverride === 'suspended') {
    const label = account.accessOverride === 'active' ? 'Kept active' : 'Manually expired'
    if (account.state === 'staged') return `${label} · sync not started`
    const verified =
      account.appliedTarget === account.accessOverride &&
      account.appliedVersion === account.policyVersion
    return `${label} · sync ${verified ? 'verified' : 'pending'}`
  }
  if (account.expired || account.suspendedAt !== null) {
    if (account.state === 'staged') return 'Expired · sync not started'
    return account.appliedVersion === account.policyVersion && account.appliedTarget === 'suspended'
      ? 'Expired · sync verified'
      : 'Expired · sync pending'
  }
  if (account.state === 'staged') return 'Sync not started'
  if (account.appliedVersion !== account.policyVersion) return 'Sync pending'
  return 'Synced'
}
export function membershipLabel(account: ManagedAccount) {
  if (account.membershipType === 'lifetime') return 'Lifetime'
  if (!account.expiry) return 'Membership not set'
  return `${membershipDate.format(new Date(account.expiry.local.slice(0, 10)))} (${account.expiry.timezone})`
}
