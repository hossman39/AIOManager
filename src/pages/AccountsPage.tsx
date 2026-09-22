import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  CheckSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  UsersRound,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useUIStore } from '@/store/uiStore'
import { useManagedApi } from '@/components/managed/useManagedApi'
import { useManagedInventory } from '@/components/managed/useManagedInventory'
import { useAccountConnections } from '@/components/managed/useAccountConnections'
import { ManagedBulkUpdate } from '@/components/managed/ManagedBulkUpdate'
import { AccountNameEditor } from '@/components/managed/AccountNameEditor'
import { useUnsavedWarning } from '@/components/managed/useManagedSubmission'
import { accountStatus, membershipLabel } from '@/components/managed/account-labels'
import type { createManagedApi, ManagedAccount } from '@/api/managed'
import {
  accountAttention,
  backupAttention,
  compareAccounts,
  expiresWithin,
  isExpired,
} from '@/lib/managed/account-health'

const PAGE_SIZE = 12
const MAX_SELECTION = 200

export function AccountsPage() {
  const { api, ownerKey } = useManagedApi()
  return <AccountsWorkspace key={ownerKey} api={api} />
}
function AccountsWorkspace({ api }: { api: ReturnType<typeof createManagedApi> }) {
  const inventory = useManagedInventory(api)
  const navigate = useNavigate()
  const connected = useAccountConnections(api, () => {
    void inventory.refresh()
  })
  const openAddAccount = useUIStore((state) => state.openAddAccountDialog)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('name')
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [page, setPage] = useState(0)
  const [bulk, setBulk] = useState<ManagedAccount[] | null>(null)
  const [editing, setEditing] = useState<{
    kind: 'name' | 'membership' | 'move'
    account: ManagedAccount
  } | null>(null)
  const [notice, setNotice] = useState('')
  const locked = inventory.loading || connected.busy || Boolean(editing) || Boolean(bulk)
  useUnsavedWarning(selected.size > 0)
  const refreshInventory = inventory.refresh
  useEffect(() => {
    if (editing || bulk || selected.size || connected.busy) return
    const timer = setInterval(() => void refreshInventory(true), 30_000)
    return () => clearInterval(timer)
  }, [editing, bulk, selected.size, connected.busy, refreshInventory])
  const accounts = [...inventory.accounts]
  for (const connection of connected.connections)
    if (connection.account && !accounts.some((row) => row.id === connection.account!.id))
      accounts.push(connection.account)
  const pending = connected.localAccounts.filter(
    (local) =>
      !accounts.some((account) => account.email.toLowerCase() === local.email?.toLowerCase()) &&
      !connected.connections.some((link) => link.localId === local.id && link.status === 'removed')
  )
  const matches = (text: string) => text.toLowerCase().includes(search.toLowerCase())
  accounts.sort((a, b) => compareAccounts(a, b, sort))
  const backupWarning = backupAttention(inventory.status, now)
  const needsAttention = accounts.filter((account) => accountAttention(account, now).length > 0)
  const shown = accounts.filter(
    (account) =>
      matches(`${account.name} ${account.email}`) &&
      (filter === 'all' ||
        (filter === 'individual'
          ? !account.groupId
          : filter === 'expired'
            ? isExpired(account, now)
            : filter === 'expiring-7'
              ? expiresWithin(account, 7, now)
              : filter === 'expiring-30'
                ? expiresWithin(account, 30, now)
                : filter === 'attention'
                  ? accountAttention(account, now).length > 0
                  : account.groupId === filter))
  )
  const pageCount = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const visible = shown.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const selectable = shown.filter((account) => account.state !== 'offboarding')
  const selectRows = (rows: ManagedAccount[]) =>
    setSelected((previous) => {
      const next = new Set(previous)
      for (const account of rows) {
        if (next.size < MAX_SELECTION && account.state !== 'offboarding') next.add(account.id)
      }
      return next
    })
  const reload = () => {
    setSelected(new Set())
    setBulk(null)
    setEditing(null)
    connected.refresh()
    void inventory.refresh()
  }
  const updated = (message: string) => {
    setNotice(message)
    setSelecting(false)
    reload()
  }
  const total = accounts.length + pending.length
  return (
    <div className="space-y-6 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Accounts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Edit account details here, or open an account to manage its addons.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => openAddAccount()}>
            <Plus className="h-4 w-4" /> Add account
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More account options">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => navigate('/accounts/import')}>
                Import accounts
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          ['Accounts', total],
          [
            'Expiring in 7 days',
            accounts.filter((account) => expiresWithin(account, 7, now)).length,
          ],
          ['Needs attention', needsAttention.length + pending.length],
          ['Expired', accounts.filter((account) => isExpired(account, now)).length],
        ].map(([label, count]) => (
          <div className="rounded-xl border bg-card px-4 py-3" key={label}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-semibold">
              {inventory.loading && total === 0 ? '—' : count}
            </p>
          </div>
        ))}
      </div>
      {inventory.status?.writePaused && (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
          Sync is paused.{' '}
          <Link className="underline" to="/settings#account-sync">
            Open sync settings
          </Link>{' '}
          to resume.
        </p>
      )}
      {backupWarning && (
        <p
          role="alert"
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
        >
          {backupWarning}{' '}
          <Link className="underline" to="/settings#account-sync">
            Open sync settings
          </Link>
        </p>
      )}
      {(inventory.error || connected.error) && (
        <p role="alert" className="text-sm text-destructive">
          {inventory.error || connected.error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="mr-auto w-full sm:max-w-sm"
          aria-label="Search accounts"
          placeholder="Search accounts…"
          value={search}
          disabled={Boolean(bulk) || Boolean(editing)}
          onChange={(event) => {
            setSearch(event.target.value)
            setPage(0)
          }}
        />
        <select
          className="h-10 max-w-full rounded-md border bg-background px-3 text-sm"
          aria-label="Filter accounts"
          value={filter}
          disabled={Boolean(bulk) || Boolean(editing)}
          onChange={(event) => {
            setFilter(event.target.value)
            setPage(0)
          }}
        >
          <option value="all">All accounts</option>
          <option value="individual">Individual accounts</option>
          <option value="expired">Expired accounts</option>
          <option value="expiring-7">Expiring in 7 days</option>
          <option value="expiring-30">Expiring in 30 days</option>
          <option value="attention">Needs attention</option>
          {inventory.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <select
          className="h-10 max-w-full rounded-md border bg-background px-3 text-sm"
          aria-label="Sort accounts"
          value={sort}
          disabled={Boolean(bulk) || Boolean(editing)}
          onChange={(event) => {
            setSort(event.target.value)
            setPage(0)
          }}
        >
          <option value="name">Name A–Z</option>
          <option value="expiry">Expiry — earliest first</option>
        </select>
        <Button
          variant={selecting ? 'secondary' : 'outline'}
          disabled={locked}
          onClick={() => {
            setSelecting(!selecting)
            setSelected(new Set())
            setNotice('')
          }}
        >
          <CheckSquare className="h-4 w-4" /> {selecting ? 'Done selecting' : 'Select'}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh accounts"
          disabled={
            inventory.loading ||
            connected.busy ||
            Boolean(editing) ||
            Boolean(bulk) ||
            selected.size > 0
          }
          onClick={reload}
        >
          <RefreshCw className={`h-4 w-4 ${inventory.loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {selecting && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm">
          <span className="mr-auto" role="status">
            {selected.size} selected across all pages
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={
              locked ||
              selected.size >= MAX_SELECTION ||
              !visible.some(
                (account) => account.state !== 'offboarding' && !selected.has(account.id)
              )
            }
            onClick={() => selectRows(visible)}
          >
            Select page
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={
              locked ||
              selected.size >= MAX_SELECTION ||
              !selectable.some((account) => !selected.has(account.id))
            }
            onClick={() => selectRows(selectable)}
          >
            Select all matching (up to 200)
          </Button>
          {selected.size > 0 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() => setSelected(new Set())}
              >
                Clear selection
              </Button>
              <Button
                size="sm"
                disabled={locked}
                onClick={() => setBulk(accounts.filter((account) => selected.has(account.id)))}
              >
                Bulk actions
              </Button>
            </>
          )}
        </div>
      )}
      {(inventory.loading || connected.busy || connected.waiting) && (
        <p role="status" className="text-sm text-muted-foreground">
          Updating accounts…
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((account) => (
          <article
            key={account.id}
            className={`flex min-w-0 flex-col rounded-xl border p-5 ${selected.has(account.id) ? 'border-primary/40 bg-primary/5' : 'bg-card'}`}
          >
            <div className="flex items-start gap-3">
              {selecting ? (
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  aria-label={`Select ${account.email}`}
                  checked={selected.has(account.id)}
                  disabled={
                    locked ||
                    account.state === 'offboarding' ||
                    (selected.size >= MAX_SELECTION && !selected.has(account.id))
                  }
                  onChange={(event) =>
                    setSelected((previous) => {
                      const next = new Set(previous)
                      if (event.target.checked) next.add(account.id)
                      else next.delete(account.id)
                      return next
                    })
                  }
                />
              ) : (
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 font-semibold text-primary">
                  {(account.name || account.email).slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <Link
                  to={`/account/${account.id}`}
                  className="break-words font-semibold hover:text-primary"
                >
                  {account.name || account.email}
                </Link>
                {account.name && account.name !== account.email && (
                  <p className="mt-1 break-all text-xs text-muted-foreground">{account.email}</p>
                )}
              </div>
              {!selecting && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  aria-label={`Edit name for ${account.email}`}
                  disabled={locked || account.state === 'offboarding'}
                  onClick={() => setEditing({ kind: 'name', account })}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <dl className="my-5 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Management</dt>
                <dd className="text-right">
                  <button
                    className="inline-flex items-center justify-end gap-2 text-right hover:text-primary disabled:cursor-default disabled:opacity-70"
                    aria-label={`Edit group for ${account.email}`}
                    disabled={locked || selecting || account.state === 'offboarding'}
                    onClick={() => setEditing({ kind: 'move', account })}
                  >
                    {account.groupId
                      ? (inventory.groups.find((group) => group.id === account.groupId)?.name ??
                        'Group')
                      : 'Individual'}
                    {!selecting && <Pencil className="h-3 w-3 shrink-0" />}
                  </button>
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Membership</dt>
                <dd className="mt-1 break-words">
                  <button
                    className="inline-flex items-start gap-2 text-left hover:text-primary disabled:cursor-default disabled:opacity-70"
                    aria-label={`Edit membership for ${account.email}`}
                    disabled={locked || selecting || account.state === 'offboarding'}
                    onClick={() => setEditing({ kind: 'membership', account })}
                  >
                    {membershipLabel(account)}
                    {!selecting && <Pencil className="mt-1 h-3 w-3 shrink-0" />}
                  </button>
                </dd>
              </div>
            </dl>
            {accountAttention(account, now).length > 0 && (
              <ul className="mb-4 space-y-1 text-xs text-amber-600 dark:text-amber-400">
                {accountAttention(account, now).map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <div className="mt-auto flex items-center justify-between gap-2 border-t pt-4">
              <span
                className={`text-xs ${account.expired ? 'text-amber-500' : 'text-muted-foreground'}`}
              >
                {accountStatus(account)}
              </span>
              <Button variant="secondary" size="sm" asChild>
                <Link to={`/account/${account.id}`}>
                  Open account <ArrowRight className="h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </article>
        ))}
        {(filter === 'all' || filter === 'attention') &&
          pending
            .filter((local) => matches(`${local.name} ${local.email}`))
            .map((local) => (
              <article key={local.id} className="space-y-4 rounded-xl border bg-card p-5">
                <h3 className="break-all font-semibold">{local.name || local.email}</h3>
                <p className="text-sm text-muted-foreground">
                  {connected.busy || connected.waiting
                    ? 'Preparing account…'
                    : 'Individual management · save a login to enable group sync.'}
                </p>
                <Button asChild variant="secondary">
                  <Link to={`/account/${local.id}`}>
                    Open account <ArrowRight className="h-4 w-4" />
                  </Link>
                </Button>
              </article>
            ))}
      </div>
      {shown.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>
            {currentPage * PAGE_SIZE + 1}–{Math.min((currentPage + 1) * PAGE_SIZE, shown.length)} of{' '}
            {shown.length}
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={locked || currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <span>
              {currentPage + 1} / {pageCount}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={locked || currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
      {editing?.kind === 'name' && (
        <AccountNameEditor
          api={api}
          account={editing.account}
          onClose={() => setEditing(null)}
          onSaved={updated}
          onReload={reload}
        />
      )}
      {editing && editing.kind !== 'name' && (
        <ManagedBulkUpdate
          api={api}
          accounts={[editing.account]}
          edit={editing.kind}
          onClose={() => setEditing(null)}
          onSaved={updated}
          onReload={reload}
        />
      )}
      {bulk && (
        <ManagedBulkUpdate
          api={api}
          accounts={bulk}
          onClose={() => setBulk(null)}
          onSaved={updated}
          onReload={reload}
        />
      )}
      {!inventory.loading &&
        !connected.busy &&
        !connected.waiting &&
        shown.length === 0 &&
        (!['all', 'attention'].includes(filter) || pending.length === 0) && (
          <div className="rounded-xl border border-dashed p-12 text-center">
            <UsersRound className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <h3 className="font-medium">
              {total ? 'No matching accounts' : 'Add your first Stremio account'}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {total
                ? 'Try a different search or filter.'
                : 'Manage it individually, or join a group whenever you need to.'}
            </p>
          </div>
        )}
    </div>
  )
}
