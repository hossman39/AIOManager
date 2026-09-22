import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type ManagedGroup,
  type ManagedGroupSummary,
} from '@/api/managed'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'
import { GroupMemberList } from './GroupMemberList'
import { GroupMemberDialog } from './GroupMemberDialog'
import { ManagedBulkUpdate } from './ManagedBulkUpdate'

type Api = ReturnType<typeof createManagedApi>

export function ManagedGroupMembers({
  group,
  groups,
  api,
  disabled,
  onLock,
  onChanged,
}: {
  group: ManagedGroup
  groups: ManagedGroupSummary[]
  api: Api
  disabled: boolean
  onLock: (locked: boolean) => void
  onChanged: () => void
}) {
  const [accounts, setAccounts] = useState<ManagedAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [picking, setPicking] = useState(false)
  const [bulk, setBulk] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [addSelected, setAddSelected] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const controller = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    controller.current?.abort()
    const abort = new AbortController()
    controller.current = abort
    setLoading(true)
    setError('')
    try {
      const inventory = new Map<string, ManagedAccount>()
      let after = ''
      do {
        const page = await api.accounts(after, abort.signal)
        page.accounts.forEach((account) => inventory.set(account.id, account))
        after = page.nextCursor ?? ''
      } while (after && !abort.signal.aborted)
      if (!abort.signal.aborted) {
        setAccounts(
          [...inventory.values()].sort(
            (a, b) =>
              (a.name || a.email).localeCompare(b.name || b.email, undefined, {
                sensitivity: 'base',
                numeric: true,
              }) || a.id.localeCompare(b.id)
          )
        )
        setSelected(new Set())
        setAddSelected(new Set())
      }
    } catch (error) {
      if (!abort.signal.aborted)
        setError(error instanceof ManagedApiError ? error.message : 'Could not load accounts.')
    } finally {
      if (!abort.signal.aborted) setLoading(false)
    }
  }, [api])
  useEffect(() => {
    void load()
    return () => controller.current?.abort()
  }, [load, group.version])
  const updated = (message: string) => {
    setNotice(message)
    setSelected(new Set())
    setAddSelected(new Set())
    setPicking(false)
    setBulk(false)
    onChanged()
    void load()
  }
  const mutation = useManagedSubmission<
    Parameters<Api['assignGroup']>[0],
    Awaited<ReturnType<Api['assignGroup']>>
  >(
    (body, key, signal) => api.assignGroup(body, key, signal),
    (result) =>
      updated(
        `${result.accounts.length} account${result.accounts.length === 1 ? '' : 's'} added to ${group.name}.`
      )
  )
  const submitting = mutation.busy || mutation.uncertain
  const locked = disabled || loading || submitting || mutation.stale
  useUnsavedWarning(selected.size > 0 || addSelected.size > 0 || submitting)
  useEffect(() => {
    onLock(picking || bulk || loading || submitting || selected.size > 0)
    return () => onLock(false)
  }, [picking, bulk, loading, submitting, selected.size, onLock])
  const members = accounts.filter((account) => account.groupId === group.id)
  const candidates = accounts.filter(
    (account) => account.groupId !== group.id && account.state !== 'offboarding'
  )
  const eligible = (account: ManagedAccount) =>
    account.state === 'staged' || group.publishedRevision !== null
  const toAdd = candidates.filter((account) => addSelected.has(account.id) && eligible(account))
  const closePicker = () => {
    if (submitting) return
    setPicking(false)
    setAddSelected(new Set())
    mutation.reset()
  }
  return (
    <section className="min-w-0 space-y-4" aria-labelledby="group-members-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="group-members-heading" className="font-semibold">
          Members{!loading && !error ? ` (${members.length})` : ''}
        </h4>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Refresh group members"
            disabled={locked || selected.size > 0 || picking || bulk}
            onClick={() => void load()}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            type="button"
            disabled={locked || Boolean(error) || selected.size > 0}
            onClick={() => {
              setPicking(true)
              setNotice('')
            }}
          >
            Add members
          </Button>
        </div>
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm">
          Loading members…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!loading && !error && (
        <>
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
              <span>
                {selected.size} member{selected.size === 1 ? '' : 's'} selected
              </span>
              <Button
                type="button"
                size="sm"
                disabled={locked || picking || bulk}
                onClick={() => setBulk(true)}
              >
                Bulk update
              </Button>
            </div>
          )}
          <GroupMemberList
            accounts={members}
            selected={selected}
            onSelected={setSelected}
            disabled={locked || picking || bulk}
            isSelectable={(account) => account.state !== 'offboarding'}
          />
        </>
      )}
      {picking && (
        <GroupMemberDialog
          title={`Add members to ${group.name}`}
          description="Select existing accounts. Accounts in another group will move here; account-only addons stay."
          blocked={submitting}
          onClose={closePicker}
        >
          {group.publishedRevision === null && (
            <p className="text-sm">
              Publish this group before adding accounts whose sync has started.
            </p>
          )}
          <GroupMemberList
            mode="add"
            groups={groups}
            accounts={candidates}
            selected={addSelected}
            onSelected={setAddSelected}
            disabled={locked}
            isSelectable={eligible}
          />
          {mutation.message && (
            <p role="alert" className="text-sm text-destructive">
              {mutation.message}
            </p>
          )}
          {mutation.uncertain && (
            <p className="text-sm">
              This request may already be saved. Retry to confirm the same selection.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" disabled={submitting} onClick={closePicker}>
              Cancel
            </Button>
            {mutation.stale && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  closePicker()
                  void load()
                }}
              >
                Reload accounts
              </Button>
            )}
            {mutation.uncertain ? (
              <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
                Retry adding members
              </Button>
            ) : (
              <Button
                type="button"
                disabled={locked || Boolean(error) || !toAdd.length}
                onClick={() =>
                  void mutation.submit({
                    groupId: group.id,
                    useGroupAddons: true,
                    accounts: toAdd.map((account) => ({
                      id: account.id,
                      expectedVersion: account.version,
                    })),
                  })
                }
              >
                {mutation.busy
                  ? 'Adding…'
                  : `Add selected members${toAdd.length ? ` (${toAdd.length})` : ''}`}
              </Button>
            )}
          </div>
        </GroupMemberDialog>
      )}
      {bulk && (
        <ManagedBulkUpdate
          api={api}
          group={group}
          accounts={members.filter((account) => selected.has(account.id))}
          onClose={() => setBulk(false)}
          onSaved={updated}
          onReload={() => {
            setBulk(false)
            setSelected(new Set())
            void load()
          }}
        />
      )}
    </section>
  )
}
