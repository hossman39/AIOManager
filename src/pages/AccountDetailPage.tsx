import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, RefreshCw, Save } from 'lucide-react'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type ManagedAccountAddons,
  type ManagedGroupSummary,
  type ManagedStatus,
} from '@/api/managed'
import { Button } from '@/components/ui/button'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AddonList } from '@/components/addons/AddonList'
import { ManagedAddonCards } from '@/components/managed/ManagedAddonCards'
import { MembershipEditor } from '@/components/managed/MembershipEditor'
import { ManagedAccountOperations } from '@/components/managed/ManagedAccountOperations'
import { useManagedApi } from '@/components/managed/useManagedApi'
import { useAccountConnections } from '@/components/managed/useAccountConnections'
import { useManagedSubmission, useUnsavedWarning } from '@/components/managed/useManagedSubmission'
import { useGuardedLeave } from '@/components/common/UnsavedWorkGuard'
import { accountStatus, membershipLabel } from '@/components/managed/account-labels'
import { useUIStore } from '@/store/uiStore'
import { sameAddonSetup } from '../../shared/account-addons.js'
import type { ManagedAddon } from '../../shared/addon-config.js'

type Api = ReturnType<typeof createManagedApi>
const describe = (error: unknown) =>
  error instanceof ManagedApiError
    ? error.message
    : 'This account could not be loaded. Please try again.'
export function AccountDetailPage() {
  const { accountId = '' } = useParams<{ accountId: string }>()
  const { api, ownerKey } = useManagedApi()
  return <AccountRoute key={`${ownerKey}:${accountId}`} api={api} accountId={accountId} />
}
function AccountRoute({ api, accountId }: { api: Api; accountId: string }) {
  const connected = useAccountConnections(api, () => {})
  const local = connected.localAccounts.find((account) => account.id === accountId)
  const connection = connected.connections.find((link) => link.localId === accountId)
  const editAccount = useUIStore((state) => state.openAddAccountDialog)
  if (connection?.status === 'removed')
    return (
      <p>
        This account has been removed.{' '}
        <Link to="/" className="underline">
          Back to accounts
        </Link>
      </p>
    )
  if (local && !connection?.account) {
    if (connected.error)
      return (
        <div className="space-y-3">
          <p role="alert">{connected.error}</p>
          <Button onClick={connected.refresh}>Retry account setup</Button>
        </div>
      )
    if (!connection || connected.busy || connected.waiting)
      return <p role="status">Opening account…</p>
    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4">
          <p className="text-sm">
            Manage this account individually. Save its Stremio login to enable groups, expiry, and
            unattended sync.
          </p>
          <Button variant="outline" onClick={() => editAccount(local)}>
            Save Stremio login
          </Button>
        </div>
        <AddonList accountId={local.id} />
      </div>
    )
  }
  return <AccountWorkspace api={api} id={connection?.account?.id ?? accountId} />
}
function AccountWorkspace({ api, id }: { api: Api; id: string }) {
  const [account, setAccount] = useState<ManagedAccount | null>(null)
  const [status, setStatus] = useState<ManagedStatus | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'addons' | 'membership' | 'group' | 'sync'>('addons')
  const navigate = useNavigate()
  const leave = useGuardedLeave()
  const [revision, setRevision] = useState(0)
  const updated = useCallback(
    (next: ManagedAccount) =>
      setAccount((previous) => (!previous || next.version >= previous.version ? next : previous)),
    []
  )
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void Promise.all([api.account(id, controller.signal), api.status(controller.signal)])
      .then(([row, summary]) => {
        if (!controller.signal.aborted) {
          updated(row)
          setStatus(summary)
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(describe(failure))
      })
    return () => controller.abort()
  }, [api, id, updated, revision])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const execution = await api.execution(id, controller.signal)
        if (!controller.signal.aborted && execution.account) updated(execution.account)
      } catch {
        /* The Sync tab exposes detailed failures and retry controls. */
      }
      if (!controller.signal.aborted) timer = setTimeout(poll, 5000)
    }
    timer = setTimeout(poll, 5000)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [api, id, updated])
  if (!account)
    return (
      <div className="space-y-3">
        <Link to="/" className="text-sm text-muted-foreground">
          ← Accounts
        </Link>
        <p role={error ? 'alert' : 'status'}>{error || 'Opening account…'}</p>
        {error && (
          <Button variant="outline" onClick={() => setRevision((value) => value + 1)}>
            Retry
          </Button>
        )}
      </div>
    )
  return (
    <div className="min-w-0 space-y-6 pb-6">
      <Link
        to="/"
        className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Accounts
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="break-words text-2xl font-semibold">{account.name || account.email}</h2>
          {account.name && account.name !== account.email && (
            <p className="mt-1 break-all text-sm text-muted-foreground">{account.email}</p>
          )}
          <p className="mt-2 break-words text-sm text-muted-foreground">
            {membershipLabel(account)}
          </p>
        </div>
        <span className="rounded-full border px-3 py-1 text-xs">{accountStatus(account)}</span>
      </div>
      {status?.writePaused && (
        <p className="rounded-lg border border-amber-500/30 p-3 text-sm">
          Sync is paused.{' '}
          <Link to="/accounts/sync-settings" className="underline">
            Open sync settings
          </Link>
          .
        </p>
      )}
      <nav className="flex gap-1 overflow-x-auto border-b" aria-label="Account sections">
        {(['addons', 'membership', 'group', 'sync'] as const).map((value) => (
          <button
            key={value}
            aria-current={tab === value ? 'page' : undefined}
            className={`shrink-0 border-b-2 px-4 py-3 text-sm ${tab === value ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground'}`}
            onClick={() => {
              if (value !== tab) leave(() => setTab(value))
            }}
          >
            {
              { addons: 'Addons', membership: 'Membership', group: 'Group', sync: 'Sync & access' }[
                value
              ]
            }
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {tab === 'addons' && (
        <AccountAddons
          api={api}
          account={account}
          onUpdated={updated}
          onSetup={() => setTab(account.membershipType === 'unset' ? 'membership' : 'sync')}
        />
      )}
      {tab === 'membership' && (
        <MembershipEditor
          api={api}
          account={account}
          onReloaded={updated}
          onSaved={(next) => {
            updated(next)
            setTab(next.state === 'staged' ? 'sync' : 'addons')
          }}
          onClose={() => setTab('addons')}
        />
      )}
      {tab === 'group' && (
        <AccountGroup
          api={api}
          account={account}
          onSaved={(next) => {
            updated(next)
            setTab('addons')
          }}
        />
      )}
      {tab === 'sync' && (
        <ManagedAccountOperations
          api={api}
          account={account}
          enabled={status?.capabilities.providerWrites ?? false}
          paused={status?.writePaused ?? true}
          onUpdated={updated}
          onRemoved={() => navigate('/')}
          onClose={() => setTab('addons')}
        />
      )}
    </div>
  )
}
function AccountAddons({
  api,
  account,
  onUpdated,
  onSetup,
}: {
  api: Api
  account: ManagedAccount
  onUpdated: (account: ManagedAccount) => void
  onSetup: () => void
}) {
  const [data, setData] = useState<ManagedAccountAddons | null>(null)
  const [addons, setAddons] = useState<ManagedAddon[]>([])
  const [reading, setReading] = useState(true)
  const [resolving, setResolving] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [emptyConfirmation, setEmptyConfirmation] = useState(false)
  const [epoch, setEpoch] = useState(0)
  const abort = useRef<AbortController | null>(null)
  const updated = useRef(onUpdated)
  updated.current = onUpdated
  const mutation = useManagedSubmission<
    Parameters<Api['setAccountAddons']>[1],
    ManagedAccountAddons
  >(
    async (body, key, signal) => {
      const result = await api.setAccountAddons(account.id, body, key, signal)
      return result.replayed ? await api.accountAddons(account.id, signal) : result
    },
    (result) => {
      setData(result)
      setAddons(result.addons)
      setEpoch((value) => value + 1)
      updated.current(result.account)
      setNotice(
        result.account.state === 'staged'
          ? 'Addon setup saved. Set a membership and start sync when ready.'
          : 'Changes saved. Open Sync & access to follow verification.'
      )
      setEmptyConfirmation(false)
    }
  )
  const load = useCallback(
    async (live = false) => {
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      setReading(true)
      setError('')
      try {
        const result = await api.accountAddons(account.id, controller.signal, live)
        if (!controller.signal.aborted) {
          setData(result)
          setAddons(result.addons)
          updated.current(result.account)
          setEpoch((value) => value + 1)
        }
      } catch (failure) {
        if (!controller.signal.aborted) setError(describe(failure))
      } finally {
        if (!controller.signal.aborted) setReading(false)
      }
    },
    [api, account.id]
  )
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])
  const dirty = data !== null && !sameAddonSetup(addons, data.addons)
  const locked =
    reading ||
    resolving ||
    mutation.busy ||
    mutation.uncertain ||
    mutation.stale ||
    account.state === 'offboarding'
  useUnsavedWarning(dirty || pending || mutation.busy || mutation.uncertain)
  const save = (allowEmpty = false) => {
    if (!data || locked || pending) return
    if (!allowEmpty && !addons.some((addon) => addon.flags?.enabled !== false)) {
      setEmptyConfirmation(true)
      return
    }
    void mutation.submit({
      expectedVersion: data.account.version,
      groupVersion: data.groupVersion,
      addons,
      allowEmpty,
    })
  }
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-semibold">
            {data?.source === 'stremio' ? 'Installed addons' : 'Account addons'}
            {data ? ` (${addons.length})` : ''}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {data?.groupName
              ? `Group: ${data.groupName}. Edits here apply only to this account.`
              : 'Manage this account individually. You can add a group at any time.'}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={
              reading || resolving || pending || dirty || mutation.busy || mutation.uncertain
            }
            onClick={() => {
              mutation.reset()
              void load(true)
            }}
          >
            <RefreshCw className={`h-4 w-4 ${reading ? 'animate-spin' : ''}`} /> Refresh
          </Button>
          <Button
            disabled={locked || pending || !data || (!dirty && !!data.account.setupSaved)}
            onClick={() => save()}
          >
            <Save className="h-4 w-4" />
            {mutation.busy ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
      {data?.source === 'stremio' && (
        <p className="rounded-lg border bg-muted/20 p-3 text-sm">
          These are the addons currently on Stremio. Save this setup to manage them here, then set a
          membership and start sync.
        </p>
      )}
      {account.state === 'staged' && data?.account.setupSaved && !dirty && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3 text-sm">
          <span>
            Setup saved.{' '}
            {account.membershipType === 'unset'
              ? 'Choose an expiry date or lifetime membership next.'
              : 'Review and start the first sync to apply your setup.'}
          </span>
          <Button size="sm" variant="outline" onClick={onSetup}>
            {account.membershipType === 'unset' ? 'Set membership' : 'Start sync'}
          </Button>
        </div>
      )}
      {(account.expired || account.suspendedAt !== null) && (
        <p className="rounded-lg border border-amber-500/30 p-3 text-sm">
          This membership is expired. The setup below is saved for renewal; addons stay disabled on
          Stremio.
        </p>
      )}
      {(error || mutation.message) && (
        <p role="alert" className="text-sm text-destructive">
          {error || mutation.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {mutation.uncertain && (
        <Button disabled={mutation.busy} onClick={() => void mutation.retry()}>
          Confirm the same save
        </Button>
      )}
      {(dirty || mutation.stale) && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>
            {mutation.stale
              ? 'This setup changed elsewhere. Reload it before editing again.'
              : 'Unsaved changes'}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={reading || resolving || pending || mutation.busy || mutation.uncertain}
            onClick={() => {
              mutation.reset()
              void load()
            }}
          >
            Discard edits & reload
          </Button>
        </div>
      )}
      {data?.installed &&
        data.source === 'saved' &&
        !sameAddonSetup(data.installed, data.addons) && (
          <details className="rounded-lg border p-3 text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Stremio currently differs from this saved setup
            </summary>
            <p className="my-3">
              This may be a pending sync or a change made directly in Stremio. Replacing the draft
              copies its current installed list, including an empty list if the membership is
              expired.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={locked || pending}
              onClick={() => {
                setAddons(data.installed!)
                setNotice('Stremio addons copied to the draft. Review before saving.')
              }}
            >
              Use Stremio list as draft
            </Button>
          </details>
        )}
      {reading && !data && (
        <p role="status" className="text-sm text-muted-foreground">
          Reading addons…
        </p>
      )}
      {data && (
        <ManagedAddonCards
          key={epoch}
          api={api}
          addons={addons}
          groupAddons={data.account.groupId ? data.groupAddons : undefined}
          onChange={setAddons}
          disabled={
            reading ||
            mutation.busy ||
            mutation.uncertain ||
            mutation.stale ||
            account.state === 'offboarding'
          }
          onBusyChange={setResolving}
          onPendingChange={setPending}
        />
      )}
      <ConfirmationDialog
        open={emptyConfirmation}
        onOpenChange={setEmptyConfirmation}
        title="Save with all addons disabled?"
        description="When this account is active, this setup clears its active addon list on Stremio. The saved setup is retained."
        confirmText="Save disabled setup"
        isDestructive
        onConfirm={() => {
          setEmptyConfirmation(false)
          save(true)
        }}
      />
    </div>
  )
}
function AccountGroup({
  api,
  account,
  onSaved,
}: {
  api: Api
  account: ManagedAccount
  onSaved: (account: ManagedAccount) => void
}) {
  const [groups, setGroups] = useState<ManagedGroupSummary[]>([])
  const [groupId, setGroupId] = useState(account.groupId ?? '')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const mutation = useManagedSubmission<Parameters<Api['assignGroup']>[0], ManagedAccount>(
    async (body, key, signal) => {
      await api.assignGroup(body, key, signal)
      return api.account(account.id, signal)
    },
    onSaved
  )
  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      const rows: ManagedGroupSummary[] = []
      let cursor = ''
      do {
        const page = await api.groups(cursor, controller.signal)
        rows.push(...page.groups)
        cursor = page.nextCursor ?? ''
      } while (cursor && !controller.signal.aborted)
      if (!controller.signal.aborted) setGroups(rows)
    })()
      .catch((failure) => {
        if (!controller.signal.aborted) setError(describe(failure))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [api])
  const locked =
    loading ||
    mutation.busy ||
    mutation.uncertain ||
    mutation.stale ||
    account.state === 'offboarding'
  useUnsavedWarning(groupId !== (account.groupId ?? '') || mutation.busy || mutation.uncertain)
  return (
    <section className="max-w-2xl space-y-4 rounded-xl border bg-card p-5">
      <h3 className="font-semibold">Group membership</h3>
      <p className="text-sm text-muted-foreground">
        A group provides a shared addon setup. You can still customize this account from its Addons
        tab.
      </p>
      <label className="block space-y-2 text-sm">
        <span>Manage with</span>
        <select
          className="w-full rounded-md border bg-background p-2"
          value={groupId}
          disabled={locked}
          onChange={(event) => setGroupId(event.target.value)}
        >
          <option value="">No group — individual setup</option>
          {groups
            .filter((group) => !group.archived)
            .map((group) => (
              <option
                key={group.id}
                value={group.id}
                disabled={account.state === 'active' && group.publishedRevision === null}
              >
                {group.name}
                {group.publishedRevision === null ? ' (draft)' : ''}
              </option>
            ))}
        </select>
      </label>
      <p className="text-sm text-muted-foreground">
        {groupId
          ? 'Switching groups uses that group’s addon settings. Account-only addons stay; matching addons and previous group customizations use the new group version.'
          : 'Leaving a group keeps the current saved addons and customizations as an individual setup.'}
      </p>
      {(error || mutation.message) && (
        <p role="alert" className="text-sm text-destructive">
          {error || mutation.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={locked || groupId === (account.groupId ?? '')}
          onClick={() =>
            void mutation.submit({
              groupId: groupId || null,
              useGroupAddons: true,
              accounts: [{ id: account.id, expectedVersion: account.version }],
            })
          }
        >
          Save group
        </Button>
        <Button asChild variant="outline">
          <Link to="/groups">Manage groups</Link>
        </Button>
        {mutation.uncertain && (
          <Button disabled={mutation.busy} onClick={() => void mutation.retry()}>
            Confirm same group change
          </Button>
        )}
        {mutation.stale && (
          <Button
            variant="outline"
            onClick={() => {
              void api
                .account(account.id)
                .then(onSaved)
                .catch((failure) => setError(describe(failure)))
            }}
          >
            Reload account
          </Button>
        )}
      </div>
    </section>
  )
}
