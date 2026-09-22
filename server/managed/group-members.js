import { z } from 'zod'
import { ManagedError } from './errors.js'

export const memberSelectionSchema = z
  .array(
    z.strictObject({
      id: z.uuid(),
      expectedVersion: z.number().int().positive(),
    })
  )
  .min(1)
  .max(200)
  .refine((accounts) => new Set(accounts.map((account) => account.id)).size === accounts.length)

/** Fence the selected members against moves, edits, removal, and another owner. */
export async function lockGroupMembers(tx, owner, groupId, selection) {
  const lock = tx.type === 'postgres' ? ' FOR UPDATE' : ''
  const group = await tx.get(
    `SELECT archived FROM managed_groups WHERE owner_id = $1 AND id = $2${lock}`,
    [owner, groupId]
  )
  if (!group || group.archived) throw new ManagedError('NOT_FOUND')
  return lockAccountSelection(tx, owner, selection, groupId)
}

/** Validate every version before changing any selected account. */
export async function lockAccountSelection(tx, owner, selection, groupId) {
  const lock = tx.type === 'postgres' ? ' FOR UPDATE' : ''
  const members = []
  for (const expected of [...selection].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const account = await tx.get(
      `SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2${lock}`,
      [owner, expected.id]
    )
    if (!account) throw new ManagedError('NOT_FOUND')
    if (
      account.record_version !== expected.expectedVersion ||
      (groupId !== undefined && account.group_id !== groupId)
    )
      throw new ManagedError('VERSION_CONFLICT')
    if (account.state === 'offboarding') throw new ManagedError('INVALID_STATE')
    members.push(account)
  }
  return members
}
