import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { ManagedAccount, ManagedGroupSummary } from '@/api/managed'
import { accountStatus, membershipLabel } from './account-labels'

const PAGE_SIZE = 10
const MAX_SELECTION = 200

export function GroupMemberList({
  accounts,
  selected,
  onSelected,
  disabled,
  mode = 'members',
  groups = [],
  isSelectable,
}: {
  accounts: ManagedAccount[]
  selected: Set<string>
  onSelected: (selected: Set<string>) => void
  disabled: boolean
  mode?: 'members' | 'add'
  groups?: ManagedGroupSummary[]
  isSelectable: (account: ManagedAccount) => boolean
}) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [page, setPage] = useState(0)
  const pageCheckbox = useRef<HTMLInputElement>(null)
  const query = search.trim().toLocaleLowerCase()
  const filtered = accounts.filter(
    (account) =>
      `${account.name} ${account.email}`.toLocaleLowerCase().includes(query) &&
      (filter === 'all' ||
        (filter === 'expired'
          ? account.expired || account.suspendedAt !== null
          : filter === 'staged'
            ? account.state === 'staged'
            : account.state === 'active' && !account.expired && account.suspendedAt === null))
  )
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const selectablePage = visible.filter(isSelectable)
  const checked =
    selectablePage.length > 0 && selectablePage.every((account) => selected.has(account.id))
  const partiallyChecked = !checked && selectablePage.some((account) => selected.has(account.id))
  useEffect(() => {
    if (pageCheckbox.current) pageCheckbox.current.indeterminate = partiallyChecked
  }, [partiallyChecked])
  const selectRows = (rows: ManagedAccount[], add: boolean) => {
    const next = new Set(selected)
    for (const account of rows) {
      if (!add) next.delete(account.id)
      else if (next.size < MAX_SELECTION && isSelectable(account)) next.add(account.id)
    }
    onSelected(next)
  }
  const selectableMatches = filtered.filter(isSelectable)
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap gap-2">
        <input
          className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm"
          aria-label={mode === 'add' ? 'Search accounts to add' : 'Search group members'}
          placeholder="Search name or email…"
          value={search}
          disabled={disabled}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(0)
          }}
        />
        {mode === 'members' && (
          <select
            className="h-10 max-w-full rounded-md border bg-background px-2 text-sm"
            aria-label="Filter group members"
            value={filter}
            disabled={disabled}
            onChange={(event) => {
              setFilter(event.target.value)
              setPage(0)
            }}
          >
            <option value="all">All members</option>
            <option value="active">Active</option>
            <option value="expired">Expired</option>
            <option value="staged">Sync not started</option>
          </select>
        )}
      </div>
      <div className="overflow-hidden rounded-lg border">
        <table
          className="w-full table-fixed text-left text-sm"
          aria-label={mode === 'add' ? 'Accounts to add' : 'Group members'}
        >
          <thead className="bg-muted/40 text-xs text-muted-foreground">
            <tr>
              <th className="w-10 p-3">
                <input
                  ref={pageCheckbox}
                  type="checkbox"
                  checked={checked}
                  aria-label="Select this page"
                  disabled={
                    disabled ||
                    !selectablePage.length ||
                    (!checked && selected.size >= MAX_SELECTION)
                  }
                  onChange={(event) => selectRows(selectablePage, event.target.checked)}
                />
              </th>
              <th className="py-3 pr-3 font-medium">Account</th>
              <th className="hidden w-2/5 py-3 pr-3 font-medium md:table-cell">
                {mode === 'add' ? 'Current group' : 'Membership'}
              </th>
              {mode === 'members' && (
                <th className="w-10">
                  <span className="sr-only">Open account</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {visible.map((account) => {
              const context =
                mode === 'members'
                  ? membershipLabel(account)
                  : account.groupId
                    ? `Move from ${groups.find((group) => group.id === account.groupId)?.name ?? 'another group'}`
                    : 'Individual account'
              return (
                <tr
                  key={account.id}
                  className={selected.has(account.id) ? 'bg-primary/5' : undefined}
                >
                  <td className="p-3 align-top">
                    <input
                      type="checkbox"
                      checked={selected.has(account.id)}
                      aria-label={`Select ${account.email}`}
                      disabled={
                        disabled ||
                        !isSelectable(account) ||
                        (selected.size >= MAX_SELECTION && !selected.has(account.id))
                      }
                      onChange={(event) => selectRows([account], event.target.checked)}
                    />
                  </td>
                  <td className="min-w-0 py-3 pr-3">
                    <p className="truncate font-medium" title={account.name || account.email}>
                      {account.name || account.email}
                    </p>
                    {account.name && account.name !== account.email && (
                      <p className="truncate text-xs text-muted-foreground" title={account.email}>
                        {account.email}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {accountStatus(account)}
                      {mode === 'add' && !isSelectable(account) ? ' · Publish group first' : ''}
                    </p>
                    <p className="mt-1 break-words text-xs text-muted-foreground md:hidden">
                      {context}
                    </p>
                  </td>
                  <td className="hidden break-words py-3 pr-3 text-xs text-muted-foreground md:table-cell">
                    {context}
                  </td>
                  {mode === 'members' && (
                    <td className="pr-3">
                      <Link
                        to={`/account/${account.id}`}
                        aria-label={`Open ${account.email}`}
                        aria-disabled={disabled}
                        tabIndex={disabled ? -1 : undefined}
                        onClick={(event) => {
                          if (disabled) event.preventDefault()
                        }}
                        className="inline-flex rounded p-1 hover:bg-muted"
                      >
                        <ArrowUpRight className="h-4 w-4" />
                      </Link>
                    </td>
                  )}
                </tr>
              )
            })}
            {!visible.length && (
              <tr>
                <td
                  colSpan={mode === 'members' ? 4 : 3}
                  className="p-6 text-center text-muted-foreground"
                >
                  {accounts.length
                    ? 'No accounts match your search or filter.'
                    : mode === 'add'
                      ? 'All available accounts are already in this group.'
                      : 'No members yet. Add an account to get started.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {filtered.length ? currentPage * PAGE_SIZE + 1 : 0}–
          {Math.min((currentPage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous
          </Button>
          <span>
            {currentPage + 1} / {pages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || currentPage + 1 >= pages}
            onClick={() => setPage(currentPage + 1)}
          >
            Next
          </Button>
        </div>
      </div>
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span role="status">{selected.size} selected across all pages</span>
          {selectableMatches.some((account) => !selected.has(account.id)) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled || selected.size >= MAX_SELECTION}
              onClick={() => selectRows(selectableMatches, true)}
            >
              Select all matching (up to 200)
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => onSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}
    </div>
  )
}
