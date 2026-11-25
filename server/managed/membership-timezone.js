import { resolveExpiryDate } from '../../shared/membership-expiry.js'
import { awaitingGroupSync, currentAccountTarget } from './entitlement.js'
import { ManagedError } from './errors.js'
import { createManagedJobStore } from './jobs.js'

// Called under the settings or migration transaction. Keep the paid-through date
// and only queue provider work if the revised cutoff changes access now.
export async function rezoneMemberships(tx, owner, timezone, now) {
  const jobs = createManagedJobStore({ db: tx })
  let after = ''
  for (;;) {
    const rows = await tx.query(
      `SELECT id, owner_id, state, group_sync_requested, group_id, lifetime, access_override, expiry_local, expiry_at,
        suspended_at, policy_version FROM managed_accounts WHERE owner_id = $1
        AND expiry_at IS NOT NULL AND expiry_zone <> $2 AND id > $3
        ORDER BY id LIMIT 500${tx.type === 'postgres' ? ' FOR UPDATE' : ''}`,
      [owner, timezone, after]
    )
    if (!rows.length) return
    for (const row of rows) {
      const result = resolveExpiryDate(row.expiry_local.slice(0, 10), timezone)
      if (!result.ok) throw new ManagedError(result.code)
      const { at, offset } = result.expiry
      const updated = { ...row, expiry_at: at, suspended_at: at > now ? null : row.suspended_at }
      const effectiveState = awaitingGroupSync(row) ? 'active' : row.state
      const target = currentAccountTarget({ ...updated, state: effectiveState }, now)
      const changed = currentAccountTarget({ ...row, state: effectiveState }, now) !== target
      if (changed) updated.policy_version++
      await tx.run(
        `UPDATE managed_accounts SET expiry_at = $1, expiry_zone = $2, expiry_offset = $3,
         expiry_zone_offset = $4, suspended_at = $5, policy_version = $6,
         record_version = record_version + 1, updated_at = $7 WHERE id = $8`,
        [
          at,
          timezone,
          Math.trunc(offset),
          Math.round(offset * 60),
          updated.suspended_at,
          updated.policy_version,
          now,
          row.id,
        ]
      )
      if (changed)
        await jobs.enqueuePolicyChange(tx, updated, target === 'active' ? 'renewal' : 'expiry', now)
    }
    after = rows.at(-1).id
  }
}
