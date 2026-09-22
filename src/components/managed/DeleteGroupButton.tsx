import { useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import type { createManagedApi, ManagedGroup } from '@/api/managed'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

type Api = ReturnType<typeof createManagedApi>
export function DeleteGroupButton({
  api,
  group,
  disabled,
  onBusy,
  onDeleted,
}: {
  api: Api
  group: ManagedGroup
  disabled: boolean
  onBusy: (busy: boolean) => void
  onDeleted: (count: number) => void
}) {
  const [confirm, setConfirm] = useState(false)
  const mutation = useManagedSubmission<number, Awaited<ReturnType<Api['deleteGroup']>>>(
    (version, key, signal) => api.deleteGroup(group.id, version, key, signal),
    (result) => onDeleted(result.detachedAccounts)
  )
  const pending = mutation.busy || mutation.uncertain
  useUnsavedWarning(pending)
  useEffect(() => {
    onBusy(pending)
    return () => onBusy(false)
  }, [pending, onBusy])
  return (
    <div className="space-y-2 border-t pt-4">
      <Button
        variant="outline"
        className="text-destructive"
        disabled={disabled || pending || mutation.stale}
        onClick={() => setConfirm(true)}
      >
        <Trash2 className="h-4 w-4" /> Delete group
      </Button>
      {mutation.message && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.message}
        </p>
      )}
      {mutation.uncertain && (
        <Button disabled={mutation.busy} onClick={() => void mutation.retry()}>
          Confirm the same deletion
        </Button>
      )}
      {mutation.stale && <p className="text-sm">Reload the saved group before deleting it.</p>}
      <ConfirmationDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Delete ${group.name}?`}
        description="Member accounts will be kept and managed individually, with their current addon setups and memberships preserved. This group will disappear from your group list."
        confirmText="Delete group"
        isDestructive
        onConfirm={() => {
          setConfirm(false)
          void mutation.submit(group.version)
        }}
      />
    </div>
  )
}
