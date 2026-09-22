import { useState } from 'react'
import type { createManagedApi, ManagedAccount } from '@/api/managed'
import { Button } from '@/components/ui/button'
import { GroupMemberDialog } from './GroupMemberDialog'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

export function AccountNameEditor({
  api,
  account,
  onClose,
  onSaved,
  onReload,
}: {
  api: ReturnType<typeof createManagedApi>
  account: ManagedAccount
  onClose: () => void
  onSaved: (notice: string) => void
  onReload: () => void
}) {
  const [name, setName] = useState(account.name)
  const mutation = useManagedSubmission<Parameters<typeof api.updateAccountName>[1], unknown>(
    (body, key, signal) => api.updateAccountName(account.id, body, key, signal),
    () => onSaved('Account name updated.')
  )
  const blocked = mutation.busy || mutation.uncertain
  const locked = blocked || mutation.stale
  useUnsavedWarning(name !== account.name || blocked)
  return (
    <GroupMemberDialog
      title="Edit account name"
      description={account.email}
      blocked={blocked}
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (!locked && name.trim())
            void mutation.submit({ name: name.trim(), expectedVersion: account.version })
        }}
      >
        <label className="block space-y-2 text-sm" htmlFor="account-display-name">
          <span>Display name</span>
          <input
            id="account-display-name"
            className="w-full rounded-md border bg-background px-3 py-2"
            required
            maxLength={120}
            value={name}
            disabled={locked}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {mutation.message && (
          <p role="alert" className="text-sm text-destructive">
            {mutation.message}
          </p>
        )}
        {mutation.uncertain && (
          <p className="text-sm">
            The name may already be saved. Retry to confirm the same change.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={blocked} onClick={onClose}>
            Cancel
          </Button>
          {mutation.stale && (
            <Button type="button" variant="outline" onClick={onReload}>
              Reload account
            </Button>
          )}
          {mutation.uncertain ? (
            <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
              Retry name change
            </Button>
          ) : (
            <Button type="submit" disabled={locked || !name.trim() || name.trim() === account.name}>
              {mutation.busy ? 'Saving…' : 'Save name'}
            </Button>
          )}
        </div>
      </form>
    </GroupMemberDialog>
  )
}
