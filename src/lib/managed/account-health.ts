import type { ManagedAccount, ManagedStatus } from '@/api/managed'

const DAY = 86_400_000

export function isExpired(account: ManagedAccount, now = Date.now()) {
  return (
    account.expired ||
    account.suspendedAt !== null ||
    (account.membershipType === 'term' && account.expiry !== null && account.expiry.at <= now)
  )
}

export function expiresWithin(account: ManagedAccount, days: number, now = Date.now()) {
  return (
    account.state !== 'offboarding' &&
    !isExpired(account, now) &&
    account.membershipType === 'term' &&
    account.expiry !== null &&
    account.expiry.at <= now + days * DAY
  )
}

export function accountAttention(account: ManagedAccount, now = Date.now()): string[] {
  const reasons: string[] = []
  if (account.state !== 'offboarding') {
    if (account.membershipType === 'unset') reasons.push('Set a membership')
    if (!account.setupSaved) reasons.push('Choose an addon setup')
    if (account.state === 'staged') reasons.push('Review and start first sync')
  }
  const job = account.syncJob
  if (job?.state === 'failed') reasons.push('Sync failed — open account to repair or retry')
  else if (job?.state === 'retrying') reasons.push('Sync is retrying')
  else if (job && ['pending', 'running'].includes(job.state) && now - job.dueAt > 120_000)
    reasons.push('Sync has been waiting more than 2 minutes')
  return reasons
}

export function compareAccounts(a: ManagedAccount, b: ManagedAccount, sort: string) {
  if (sort === 'expiry') {
    const first = a.expiry?.at ?? Infinity
    const second = b.expiry?.at ?? Infinity
    if (first !== second) return first < second ? -1 : 1
  }
  return (
    (a.name || a.email).localeCompare(b.name || b.email, undefined, {
      sensitivity: 'base',
      numeric: true,
    }) || a.id.localeCompare(b.id)
  )
}

export function backupAttention(status: ManagedStatus | null, now = Date.now()) {
  if (!status) return null
  if (!status.capabilities.backupsEnabled) return 'Automatic application backups are disabled.'
  if (status.lastBackupAt === null) return 'No successful application backup has been recorded.'
  if (now - status.lastBackupAt > 26 * 60 * 60 * 1000)
    return 'The last application backup is over 26 hours old. Check the server backup status.'
  return null
}
