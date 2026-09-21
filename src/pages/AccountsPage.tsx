import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, MoreHorizontal, Plus, RefreshCw, UsersRound } from 'lucide-react'
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
import { ManagedGroupAssignment } from '@/components/managed/ManagedGroupAssignment'
import { accountStatus, membershipLabel } from '@/components/managed/account-labels'
import type { createManagedApi } from '@/api/managed'

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
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [assignmentLocked, setAssignmentLocked] = useState(false)
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
  const shown = accounts.filter(
    (account) =>
      matches(`${account.name} ${account.email}`) &&
      (filter === 'all' ||
        (filter === 'individual'
          ? !account.groupId
          : filter === 'expired'
            ? account.expired || account.suspendedAt !== null
            : account.groupId === filter))
  )
  const total = accounts.length + pending.length
  return (
    <div className="space-y-6 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold">Accounts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Open an account to manage its addons, group, and membership.
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
              <DropdownMenuItem onClick={() => navigate('/accounts/sync-settings')}>
                Sync settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[
          ['Accounts', total],
          ['In groups', accounts.filter((account) => account.groupId).length],
          [
            'Expired',
            accounts.filter((account) => account.expired || account.suspendedAt !== null).length,
          ],
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
          <Link className="underline" to="/accounts/sync-settings">
            Open sync settings
          </Link>{' '}
          to resume.
        </p>
      )}
      {(inventory.error || connected.error) && (
        <p role="alert" className="text-sm text-destructive">
          {inventory.error || connected.error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="mr-auto w-full sm:max-w-sm"
          aria-label="Search accounts"
          placeholder="Search accounts…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          className="h-10 max-w-full rounded-md border bg-background px-3 text-sm"
          aria-label="Filter accounts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">All accounts</option>
          <option value="individual">Individual accounts</option>
          <option value="expired">Expired accounts</option>
          {inventory.groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </select>
        <Button
          variant={selecting ? 'secondary' : 'outline'}
          disabled={assignmentLocked}
          onClick={() => {
            setSelecting(!selecting)
            setSelected([])
          }}
        >
          {selecting ? 'Done selecting' : 'Assign group'}
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh accounts"
          disabled={inventory.loading || connected.busy || assignmentLocked}
          onClick={() => {
            connected.refresh()
            void inventory.refresh()
          }}
        >
          <RefreshCw className={`h-4 w-4 ${inventory.loading ? 'animate-spin' : ''}`} />
        </Button>
      </div>
      {selecting &&
        (selected.length ? (
          <ManagedGroupAssignment
            api={api}
            accounts={accounts.filter((account) => selected.includes(account.id))}
            groups={inventory.groups}
            onLock={setAssignmentLocked}
            onSaved={() => {
              setSelected([])
              setSelecting(false)
              void inventory.refresh()
            }}
            onClear={() => {
              setSelected([])
              void inventory.refresh()
            }}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Select the accounts that should share a group.
          </p>
        ))}
      {(inventory.loading || connected.busy || connected.waiting) && (
        <p role="status" className="text-sm text-muted-foreground">
          Updating accounts…
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((account) => (
          <article key={account.id} className="flex min-w-0 flex-col rounded-xl border bg-card p-5">
            <div className="flex items-start gap-3">
              {selecting ? (
                <input
                  type="checkbox"
                  className="mt-1 h-5 w-5"
                  aria-label={`Select ${account.email}`}
                  checked={selected.includes(account.id)}
                  disabled={assignmentLocked || account.state === 'offboarding'}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, account.id]
                        : previous.filter((id) => id !== account.id)
                    )
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
            </div>
            <dl className="my-5 space-y-3 text-sm">
              <div className="flex justify-between gap-3">
                <dt className="text-muted-foreground">Management</dt>
                <dd className="text-right">
                  {account.groupId
                    ? (inventory.groups.find((group) => group.id === account.groupId)?.name ??
                      'Group')
                    : 'Individual'}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Membership</dt>
                <dd className="mt-1 break-words">{membershipLabel(account)}</dd>
              </div>
            </dl>
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
        {filter === 'all' &&
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
      {!inventory.loading &&
        !connected.busy &&
        !connected.waiting &&
        shown.length === 0 &&
        (filter !== 'all' || pending.length === 0) && (
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
