import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type ManagedGroup,
  type ManagedGroupSummary,
} from '@/api/managed'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'
import { accountStatus } from './account-labels'

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
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
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
        setAccounts([...inventory.values()])
        setSelected(new Set())
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
  const mutation = useManagedSubmission<
    Parameters<Api['assignGroup']>[0],
    Awaited<ReturnType<Api['assignGroup']>>
  >(
    (body, key, signal) => api.assignGroup(body, key, signal),
    (result) => {
      const count = result.accounts.length
      setNotice(`${count} account${count === 1 ? '' : 's'} added to ${group.name}.`)
      setSelected(new Set())
      setPicking(false)
      setSearch('')
      onChanged()
      // Refresh after retries too: an acknowledgement can describe an older operation.
      void load()
    }
  )
  const submitting = mutation.busy || mutation.uncertain
  const locked = disabled || loading || submitting || mutation.stale
  useUnsavedWarning(selected.size > 0 || submitting)
  useEffect(() => {
    onLock(picking || loading || submitting)
    return () => onLock(false)
  }, [picking, loading, submitting, onLock])

  const members = accounts.filter((account) => account.groupId === group.id)
  const candidates = accounts.filter(
    (account) => account.groupId !== group.id && account.state !== 'offboarding'
  )
  const query = search.trim().toLocaleLowerCase()
  const visible = candidates.filter((account) =>
    `${account.name} ${account.email}`.toLocaleLowerCase().includes(query)
  )
  const eligible = (account: ManagedAccount) =>
    account.state === 'staged' || group.publishedRevision !== null
  const selection = candidates.filter((account) => selected.has(account.id) && eligible(account))

  return (
    <section
      className="min-w-0 space-y-3 rounded-lg border p-4"
      aria-labelledby="group-members-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id="group-members-heading" className="font-semibold">
          Members{!loading && !error ? ` (${members.length})` : ''}
        </h4>
        {!picking && (
          <Button
            type="button"
            disabled={locked || Boolean(error)}
            onClick={() => {
              setPicking(true)
              setNotice('')
            }}
          >
            Add members
          </Button>
        )}
      </div>
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="text-sm">
          Loading accounts…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!loading &&
        !error &&
        !picking &&
        (members.length ? (
          <ul className="max-h-64 divide-y overflow-y-auto text-sm">
            {members.map((account) => (
              <li
                key={account.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <div className="min-w-0 flex-1 break-words">
                  <p className="font-medium">{account.name || account.email}</p>
                  {account.name && account.name !== account.email && (
                    <p className="text-muted-foreground">{account.email}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{accountStatus(account)}</p>
                </div>
                {!disabled && (
                  <Link
                    className="shrink-0 text-primary hover:underline"
                    to={`/account/${account.id}`}
                  >
                    Open account
                  </Link>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            No members yet. Add an existing account to use this group.
          </p>
        ))}
      {picking && (
        <div className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Select accounts to join this group. Accounts in another group will move here. Group
            settings apply to shared addons; account-only addons stay. Accounts whose sync has not
            started stay inactive.
          </p>
          {group.publishedRevision === null && (
            <p>Publish this group before adding accounts that already have sync started.</p>
          )}
          <label className="block space-y-1" htmlFor="group-member-search">
            <span>Search accounts</span>
            <input
              id="group-member-search"
              className="w-full min-w-0 rounded-md border bg-background px-3 py-2"
              placeholder="Name or email"
              value={search}
              disabled={locked}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {!loading && !error && (
            <div className="max-h-72 space-y-1 overflow-y-auto" aria-label="Accounts to add">
              {visible.map((account) => (
                <label key={account.id} className="flex items-start gap-3 rounded border p-3">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(account.id)}
                    disabled={
                      locked ||
                      !eligible(account) ||
                      (selected.size >= 200 && !selected.has(account.id))
                    }
                    onChange={(event) => {
                      setSelected((previous) => {
                        const next = new Set(previous)
                        if (event.target.checked) next.add(account.id)
                        else next.delete(account.id)
                        return next
                      })
                    }}
                  />
                  <span className="min-w-0 break-words">
                    <span className="block font-medium">{account.name || account.email}</span>
                    {account.name && account.name !== account.email && (
                      <span className="block">{account.email}</span>
                    )}
                    <span className="block text-xs text-muted-foreground">
                      {account.groupId
                        ? `Moving from ${groups.find((item) => item.id === account.groupId)?.name ?? 'another group'}`
                        : 'Individual account'}
                      {!eligible(account)
                        ? ' · Publish the group first'
                        : account.state === 'staged'
                          ? ' · Sync not started'
                          : ''}
                    </span>
                  </span>
                </label>
              ))}
              {!visible.length && (
                <p>
                  {candidates.length
                    ? 'No accounts match your search.'
                    : 'All available accounts are already in this group.'}
                </p>
              )}
            </div>
          )}
          {selected.size > 0 && (
            <p role="status">
              {selected.size} selected{selected.size === 200 ? ' (maximum per batch)' : ''}
            </p>
          )}
          {mutation.message && (
            <p role="alert" className="text-destructive">
              {mutation.message}
            </p>
          )}
          {mutation.uncertain && (
            <p>
              The selection is saved for retry. Confirm the same request without adding accounts
              twice.
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={locked || Boolean(error) || !selection.length}
              onClick={() =>
                void mutation.submit({
                  groupId: group.id,
                  useGroupAddons: true,
                  accounts: selection.map((account) => ({
                    id: account.id,
                    expectedVersion: account.version,
                  })),
                })
              }
            >
              {mutation.busy
                ? 'Adding members…'
                : `Add selected members${selection.length ? ` (${selection.length})` : ''}`}
            </Button>
            {mutation.uncertain && (
              <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
                Retry adding members
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={submitting}
              onClick={() => {
                setPicking(false)
                setSelected(new Set())
                setSearch('')
                mutation.reset()
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {(error || mutation.stale) && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || loading || submitting}
          onClick={() => {
            mutation.reset()
            void load()
          }}
        >
          Reload accounts
        </Button>
      )}
    </section>
  )
}
