import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { createManagedApi, ManagedAccount, ManagedGroupSummary } from '@/api/managed'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

export function ManagedGroupAssignment({
  accounts,
  groups,
  api,
  onSaved,
  onLock,
  onClear,
}: {
  accounts: ManagedAccount[]
  groups: ManagedGroupSummary[]
  api: ReturnType<typeof createManagedApi>
  onSaved: (accounts: ManagedAccount[]) => void
  onLock: (locked: boolean) => void
  onClear: () => void
}) {
  const [groupId, setGroupId] = useState('')
  const mutation = useManagedSubmission<Parameters<typeof api.assignGroup>[0], ManagedAccount[]>(
    async (body, key, signal) => {
      const result = await api.assignGroup(body, key, signal)
      // A replay may be historical. The inventory refresh in onSaved fetches the
      // latest page; no provider-success claim is made from this acknowledgement.
      return result.accounts.map((entry) => entry.account)
    },
    onSaved
  )
  const locked = mutation.busy || mutation.uncertain || mutation.stale
  useUnsavedWarning(mutation.busy || mutation.uncertain)
  useEffect(() => {
    onLock(locked)
    return () => onLock(false)
  }, [locked, onLock])
  return (
    <div className="space-y-3 rounded border p-3 text-sm" aria-label="Bulk group assignment">
      <p>
        {accounts.length} loaded users selected. Assignment is all-or-nothing and does not activate
        staged users.
      </p>
      {accounts.length > 200 && <p role="alert">Select at most 200 users per assignment.</p>}
      <label className="block space-y-1" htmlFor="managed-assignment-group">
        <span>Destination group</span>
        <select
          id="managed-assignment-group"
          className="w-full rounded border bg-background p-2"
          value={groupId}
          disabled={locked}
          onChange={(event) => setGroupId(event.target.value)}
        >
          <option value="">Choose a group</option>
          {groups
            .filter((group) => !group.archived)
            .map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
                {group.publishedRevision === null ? ' (draft only)' : ''}
              </option>
            ))}
        </select>
      </label>
      {mutation.message && (
        <p role="alert" className="text-destructive">
          {mutation.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={locked || !groupId || accounts.length === 0 || accounts.length > 200}
          onClick={() =>
            void mutation.submit({
              groupId,
              accounts: accounts.map((account) => ({
                id: account.id,
                expectedVersion: account.version,
              })),
            })
          }
        >
          Assign selected users
        </Button>
        {mutation.uncertain && (
          <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
            Retry same assignment
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={mutation.busy || mutation.uncertain}
          onClick={onClear}
        >
          {mutation.stale ? 'Clear selection and refresh users' : 'Clear selection'}
        </Button>
      </div>
      {mutation.uncertain && (
        <p>
          The submitted selection is frozen. Retry to confirm the same assignment without repeating
          its changes.
        </p>
      )}
    </div>
  )
}
