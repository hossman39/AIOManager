import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Plus, RefreshCw, ShieldCheck, Upload, UsersRound } from 'lucide-react'
import {
  createManagedApi,
  ManagedApiError,
  type ManagedAccount,
  type ManagedImportBatch,
  type ManagedImportPreview,
  type ManagedStatus,
  type ManagedGroupSummary,
} from '@/api/managed'
import { MAX_CREDENTIAL_IMPORT_BYTES } from '@/lib/managed/credential-import'
import { prepareCredentialUpload, type CredentialUpload } from '@/lib/managed/prepare-import'
import { useSyncStore } from '@/store/syncStore'
import { Button } from '@/components/ui/button'
import { MembershipEditor } from '@/components/managed/MembershipEditor'
import { ManagedGroupsPanel } from '@/components/managed/ManagedGroupsPanel'
import { ManagedGroupAssignment } from '@/components/managed/ManagedGroupAssignment'
import { ManagedPersonalEditor } from '@/components/managed/ManagedPersonalEditor'
import { ManagedRuntimeControls } from '@/components/managed/ManagedRuntimeControls'
import { ManagedAccountOperations } from '@/components/managed/ManagedAccountOperations'
import { useUnsavedWarning } from '@/components/common/UnsavedWorkGuard'
import { useUIStore } from '@/store/uiStore'
import { useAccountConnections } from '@/components/managed/useAccountConnections'

type ManagedApi = ReturnType<typeof createManagedApi>
const describeError = (error: unknown) =>
  error instanceof ManagedApiError
    ? error.message
    : 'The operation could not be completed. Try again.'
const isCancelled = (error: unknown) =>
  error instanceof ManagedApiError && error.code === 'CANCELLED'

export function ManagedAccountsPage({ focusAccountId }: { focusAccountId?: string } = {}) {
  const auth = useSyncStore((state) => state.auth)
  const serverUrl = useSyncStore((state) => state.serverUrl)
  const api = useMemo(
    () => createManagedApi({ managerId: auth.id, password: auth.password, serverUrl }),
    [auth.id, auth.password, serverUrl]
  )
  return (
    <ManagedWorkspace key={`${auth.id}:${serverUrl}`} api={api} focusAccountId={focusAccountId} />
  )
}

function ManagedWorkspace({ api, focusAccountId }: { api: ManagedApi; focusAccountId?: string }) {
  const openAddAccount = useUIStore((state) => state.openAddAccountDialog)
  const [accounts, setAccounts] = useState<ManagedAccount[]>([])
  const [status, setStatus] = useState<ManagedStatus | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [inventoryError, setInventoryError] = useState('')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<ManagedImportPreview | null>(null)
  const [batch, setBatch] = useState<ManagedImportBatch | null>(null)
  const [importError, setImportError] = useState('')
  const [busy, setBusy] = useState<'preview' | 'stage' | null>(null)
  const [consent, setConsent] = useState(false)
  const [hasPending, setHasPending] = useState(false)
  const [editingAccount, setEditingAccount] = useState<ManagedAccount | null>(null)
  const [editorRevision, setEditorRevision] = useState(0)
  const [membershipNotice, setMembershipNotice] = useState('')
  const [groups, setGroups] = useState<ManagedGroupSummary[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [assignmentLocked, setAssignmentLocked] = useState(false)
  const [personalAccount, setPersonalAccount] = useState<ManagedAccount | null>(null)
  const [operationsAccount, setOperationsAccount] = useState<ManagedAccount | null>(null)
  const [view, setView] = useState<'all' | 'expired'>('all')
  const [showImport, setShowImport] = useState(false)
  const [removedIds, setRemovedIds] = useState<string[]>([])
  const returnFocus = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  // Passwords stay in this transient ref, never in legacy stores/localStorage or
  // public React view state. Clear references on success, cancel, and unmount.
  const pending = useRef<{ upload: CredentialUpload; key: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const inventoryAbort = useRef<AbortController | null>(null)
  const importAbort = useRef<AbortController | null>(null)
  const inventorySequence = useRef(0)
  const importSequence = useRef(0)
  useUnsavedWarning(hasPending || busy === 'stage')

  const loadInventory = useCallback(
    async (after = '') => {
      const sequence = ++inventorySequence.current
      inventoryAbort.current?.abort()
      const controller = new AbortController()
      inventoryAbort.current = controller
      setLoading(true)
      setInventoryError('')
      try {
        const [summary, page] = await Promise.all([
          api.status(controller.signal),
          api.accounts(after, controller.signal, view),
        ])
        if (sequence !== inventorySequence.current) return
        setStatus(summary)
        setAccounts((previous) => {
          // An inventory request started before a save must not replace a newer
          // membership already acknowledged in this browser.
          const refreshed = page.accounts.map((row) => {
            const saved = previous.find((item) => item.id === row.id)
            return saved && saved.version > row.version ? saved : row
          })
          return after
            ? [
                ...previous,
                ...refreshed.filter((row) => !previous.some((item) => item.id === row.id)),
              ]
            : refreshed
        })
        setNextCursor(page.nextCursor)
      } catch (error) {
        if (sequence === inventorySequence.current && !isCancelled(error))
          setInventoryError(describeError(error))
      } finally {
        if (sequence === inventorySequence.current) setLoading(false)
      }
    },
    [api, view]
  )

  const discardRequests = useCallback(() => {
    inventorySequence.current++
    importSequence.current++
    inventoryAbort.current?.abort()
    importAbort.current?.abort()
    pending.current = null
  }, [])

  const connected = useAccountConnections(api, () => {
    void loadInventory()
  })
  const inventory = [...accounts]
  if (view === 'all') {
    for (const connection of connected.connections) {
      if (connection.account && !inventory.some((row) => row.id === connection.account!.id))
        inventory.push(connection.account)
    }
  }
  const availableAccounts = inventory.filter((row) => !removedIds.includes(row.id))
  const pendingAccounts =
    view === 'all'
      ? connected.localAccounts.filter((local) => {
          const link = connected.connections.find((row) => row.localId === local.id)
          return (
            (!link || link.status === 'needs_credentials') &&
            !availableAccounts.some((row) => row.email.toLowerCase() === local.email?.toLowerCase())
          )
        })
      : []
  const focusedAccount = availableAccounts.find(
    (row) =>
      row.id === focusAccountId ||
      connected.connections.some(
        (link) => link.localId === focusAccountId && link.account?.id === row.id
      )
  )
  const focusedEmail = focusedAccount?.email
  useEffect(() => {
    if (focusedEmail) setSearch(focusedEmail)
  }, [focusAccountId, focusedEmail])

  useEffect(() => {
    setEditingAccount(null)
    setMembershipNotice('')
    setPreview(null)
    setBatch(null)
    setConsent(false)
    setHasPending(false)
    setBusy(null)
    setImportError('')
    void loadInventory()
    return discardRequests
  }, [loadInventory, discardRequests])

  useEffect(() => {
    if (
      !editingAccount &&
      !personalAccount &&
      !operationsAccount &&
      !loading &&
      restoreFocus.current
    ) {
      returnFocus.current?.focus()
      restoreFocus.current = false
    }
  }, [editingAccount, personalAccount, operationsAccount, loading])

  const replaceAccount = (updated: ManagedAccount) => {
    setAccounts((previous) =>
      !previous.some((row) => row.id === updated.id)
        ? [...previous, updated]
        : previous.map((row) =>
            row.id === updated.id && row.version <= updated.version ? updated : row
          )
    )
  }

  const clearImport = () => {
    importSequence.current++
    importAbort.current?.abort()
    pending.current = null
    setHasPending(false)
    setPreview(null)
    setImportError('')
    setConsent(false)
    setBusy(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const previewPending = async (sequence: number) => {
    const record = pending.current
    if (!record) return
    const controller = new AbortController()
    importAbort.current = controller
    try {
      const result = await api.previewImport(record.upload, controller.signal)
      if (sequence === importSequence.current) setPreview(result)
    } catch (error) {
      if (sequence === importSequence.current && !isCancelled(error))
        setImportError(describeError(error))
    } finally {
      if (sequence === importSequence.current) setBusy(null)
    }
  }

  const selectFile = async (file: File | undefined) => {
    if (!file) return
    clearImport()
    setBatch(null)
    const sequence = importSequence.current
    if (file.size > MAX_CREDENTIAL_IMPORT_BYTES) {
      setImportError('The selected file exceeds the 10 MiB limit.')
      return
    }
    setBusy('preview')
    try {
      const prepared = prepareCredentialUpload(await file.text())
      if (sequence !== importSequence.current) return
      if (!prepared.ok) {
        setImportError(prepared.error.message)
        setBusy(null)
        return
      }
      pending.current = { upload: prepared.upload, key: crypto.randomUUID() }
      setHasPending(true)
      await previewPending(sequence)
    } catch {
      if (sequence === importSequence.current) {
        setImportError('The file could not be read. Select a valid JSON export.')
        setBusy(null)
      }
    }
  }

  const stage = async () => {
    const record = pending.current
    if (!record || !preview || !consent || busy) return
    const sequence = ++importSequence.current
    const controller = new AbortController()
    importAbort.current = controller
    setBusy('stage')
    setImportError('')
    try {
      const result = await api.stageImport(record.upload, record.key, controller.signal)
      if (sequence !== importSequence.current) return
      pending.current = null
      setHasPending(false)
      setPreview(null)
      setConsent(false)
      setBatch(result)
      void loadInventory()
    } catch (error) {
      if (sequence === importSequence.current && !isCancelled(error))
        setImportError(describeError(error))
      // Retain the same key and payload so an ambiguous response can be retried.
    } finally {
      if (sequence === importSequence.current) setBusy(null)
    }
  }

  const shownAccounts = availableAccounts.filter((account) =>
    `${account.email} ${account.name}`.toLowerCase().includes(search.toLowerCase())
  )
  const readyCount = preview?.accounts.filter((account) => account.status === 'ready').length ?? 0
  const existingCount =
    preview?.accounts.filter((account) => account.status === 'existing').length ?? 0
  const report = preview ?? batch

  return (
    <div className="space-y-6 pb-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-semibold">
            <UsersRound aria-hidden="true" /> Accounts
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manage group addons, individual setups, memberships, and verified sync.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => openAddAccount()}>
            <Plus aria-hidden="true" /> Add Stremio Account
          </Button>
          <Button
            variant="outline"
            aria-expanded={showImport}
            onClick={() => setShowImport((value) => !value)}
          >
            Import from another installation
          </Button>
          <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            {status?.capabilities.providerWrites ? 'Managed sync available' : 'Staging available'}
          </span>
        </div>
      </div>
      {status && (
        <ManagedRuntimeControls
          api={api}
          status={status}
          onChanged={() => {
            void loadInventory()
          }}
        />
      )}

      <section
        hidden={!showImport}
        className="space-y-4 rounded-xl border bg-card p-5"
        aria-labelledby="managed-import-heading"
      >
        <div>
          <h3 id="managed-import-heading" className="text-lg font-semibold">
            Import accounts from another installation
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Select an export from your old AIOManager installation with saved credentials included.
            Only email and password are uploaded; addons, tokens, names, dates, and automation rules
            are discarded. Passwords are never shown here.
          </p>
        </div>
        <label className="block space-y-2 text-sm font-medium" htmlFor="managed-import-file">
          <span>AIOManager JSON export (up to 10 MiB)</span>
          <input
            id="managed-import-file"
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            disabled={busy !== null}
            className="block w-full rounded-md border p-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1"
            onChange={(event) => {
              void selectFile(event.target.files?.[0])
            }}
          />
        </label>
        {busy === 'preview' && (
          <p role="status" className="text-sm">
            Checking rows and existing users… No users are being saved yet.
          </p>
        )}
        {importError && (
          <p
            role="alert"
            className="rounded border border-destructive/30 p-3 text-sm text-destructive"
          >
            {importError}
          </p>
        )}
        {hasPending && !preview && !busy && (
          <Button
            variant="outline"
            onClick={() => {
              setImportError('')
              setBusy('preview')
              void previewPending(++importSequence.current)
            }}
          >
            Retry preview
          </Button>
        )}

        {report && (
          <div className="space-y-3">
            <p className="text-sm">
              {report.totalRows} source rows · {report.accounts.length} distinct credential
              candidates
            </p>
            {preview && (
              <p className="text-sm">
                {readyCount} new users ready to stage · {existingCount} already saved ·{' '}
                {preview.accounts.filter((account) => account.status === 'conflict').length}{' '}
                saved-password conflicts
              </p>
            )}
            <div className="max-h-72 overflow-auto rounded border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Credential import reconciliation</caption>
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th scope="col" className="p-3">
                      Source rows
                    </th>
                    <th scope="col" className="p-3">
                      Email
                    </th>
                    <th scope="col" className="p-3">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.accounts.map((account) => (
                    <tr key={account.sourceRows.join(',')} className="border-t">
                      <td className="p-3">{account.sourceRows.join(', ')}</td>
                      <td className="break-all p-3">{account.email}</td>
                      <td className="p-3">
                        {
                          {
                            ready: 'Ready to stage',
                            existing: 'Already saved',
                            conflict: 'Password conflict — unchanged',
                            staged: 'Saved, inactive',
                          }[account.status]
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.issues.length > 0 && (
              <details className="rounded border p-3" open>
                <summary className="cursor-pointer text-sm font-medium">
                  {report.issues.length} row notices — no silent credential replacement
                </summary>
                <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-sm text-muted-foreground">
                  {report.issues.map((issue) => (
                    <li key={`${issue.row}:${issue.code}`}>
                      Row {issue.row}: {issue.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {preview && (
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-semibold">2. Save inactive users</h3>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy !== null}
                onChange={(event) => setConsent(event.target.checked)}
                className="mt-1"
              />
              <span>
                I understand that account passwords will be stored encrypted on this server for
                future unattended management. Use a trusted server over HTTPS. Importing does not
                activate users.
              </span>
            </label>
            <Button
              onClick={() => {
                void stage()
              }}
              disabled={!consent || readyCount + existingCount === 0 || busy !== null}
            >
              <Upload aria-hidden="true" />
              {busy === 'stage' ? 'Saving inactive users…' : 'Save inactive users'}
            </Button>
          </div>
        )}
        {hasPending && (
          <Button variant="ghost" disabled={busy === 'stage'} onClick={clearImport}>
            Clear selected credentials
          </Button>
        )}
        {batch && (
          <p
            role="status"
            className="rounded border border-green-500/30 bg-green-500/5 p-3 text-sm"
          >
            {batch.replayed ? 'Import already saved. Original result: ' : 'Import saved: '}
            {batch.created} users staged, {batch.existing} existing matches, {batch.conflicts}{' '}
            saved-password conflicts.{' '}
            {batch.issues.length > 0 && `See the ${batch.issues.length} row notices above. `}
            No Stremio addons were changed.
          </p>
        )}
      </section>

      {status?.capabilities.groupPublication && (
        <ManagedGroupsPanel
          api={api}
          onGroupsChanged={setGroups}
          onAccountsChanged={() => {
            void loadInventory()
          }}
        />
      )}

      <section
        className="space-y-4 rounded-xl border bg-card p-5"
        aria-labelledby="managed-inventory-heading"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 id="managed-inventory-heading" className="text-lg font-semibold">
              Your accounts
            </h3>
            <p className="text-sm text-muted-foreground">
              {status
                ? `${status.accounts.staged} staged · ${status.accounts.active} active · ${status.accounts.offboarding} offboarding`
                : 'Reading server inventory…'}
            </p>
          </div>
          <Button
            variant="outline"
            disabled={loading || connected.busy || assignmentLocked || selectedIds.length > 0}
            onClick={() => {
              connected.refresh()
              void loadInventory()
            }}
          >
            <RefreshCw className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            Refresh
          </Button>
        </div>
        {inventoryError && (
          <p role="alert" className="text-sm text-destructive">
            {inventoryError}
          </p>
        )}
        {connected.busy && (
          <p role="status" className="text-sm text-muted-foreground">
            Finishing account setup…
          </p>
        )}
        {connected.error && (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>{connected.error}</p>
            <Button variant="outline" onClick={connected.refresh}>
              Retry account setup
            </Button>
          </div>
        )}
        <label htmlFor="managed-user-search" className="block text-sm">
          Search accounts
        </label>
        <input
          id="managed-user-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Email or display name"
          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
        />
        <label className="block space-y-1 text-sm">
          <span>System view</span>
          <select
            value={view}
            disabled={
              loading ||
              selectedIds.length > 0 ||
              !!editingAccount ||
              !!personalAccount ||
              !!operationsAccount
            }
            className="rounded-md border bg-background px-3 py-2"
            onChange={(event) => setView(event.target.value as 'all' | 'expired')}
          >
            <option value="all">All accounts</option>
            <option value="expired">Expired accounts</option>
          </select>
        </label>
        {view === 'expired' && (
          <p className="text-sm text-muted-foreground">
            Expired users keep their group and saved setup. Set a future expiry or choose lifetime
            to renew.
          </p>
        )}
        {membershipNotice && (
          <p role="status" className="text-sm">
            {membershipNotice}
          </p>
        )}
        {selectedIds.length > 0 && (
          <ManagedGroupAssignment
            accounts={availableAccounts.filter((account) => selectedIds.includes(account.id))}
            groups={groups}
            api={api}
            onLock={setAssignmentLocked}
            onClear={() => {
              setSelectedIds([])
              void loadInventory()
            }}
            onSaved={(updated) => {
              updated.forEach(replaceAccount)
              setSelectedIds([])
              setMembershipNotice('Group assignment saved. Staged users remain inactive.')
              void loadInventory()
            }}
          />
        )}
        {operationsAccount && (
          <ManagedAccountOperations
            key={operationsAccount.id}
            api={api}
            account={operationsAccount}
            enabled={status?.capabilities.providerWrites ?? false}
            paused={status?.writePaused ?? true}
            onUpdated={replaceAccount}
            onRemoved={() => {
              setRemovedIds((previous) => [...previous, operationsAccount.id])
              connected.refresh()
              setOperationsAccount(null)
              restoreFocus.current = true
              setMembershipNotice(
                `Stremio cleanup verified. ${operationsAccount.email} was removed.`
              )
              void loadInventory()
            }}
            onClose={() => {
              setOperationsAccount(null)
              restoreFocus.current = true
              void loadInventory()
            }}
          />
        )}
        {personalAccount && (
          <ManagedPersonalEditor
            key={personalAccount.id}
            api={api}
            account={personalAccount}
            onSaved={replaceAccount}
            onClose={() => {
              setPersonalAccount(null)
              restoreFocus.current = true
            }}
          />
        )}
        {editingAccount && (
          <MembershipEditor
            key={`${editingAccount.id}:${editorRevision}`}
            account={editingAccount}
            api={api}
            onClose={() => {
              restoreFocus.current = true
              setEditingAccount(null)
            }}
            onSaved={(updated) => {
              replaceAccount(updated)
              restoreFocus.current = true
              setEditingAccount(null)
              setMembershipNotice(
                `Membership saved for ${updated.email}. ${updated.state === 'staged' ? 'This user is still staged; no Stremio addons were changed.' : 'Provider sync status is tracked separately.'}`
              )
              void loadInventory()
            }}
            onReloaded={(updated) => {
              replaceAccount(updated)
              setEditingAccount(updated)
              setEditorRevision((revision) => revision + 1)
            }}
          />
        )}
        <div className="overflow-x-auto rounded border" aria-busy={loading}>
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Stremio accounts and their group, membership, and sync settings
            </caption>
            <thead className="bg-muted">
              <tr>
                <th scope="col" className="p-3">
                  <input
                    type="checkbox"
                    aria-label="Select all shown eligible users"
                    disabled={
                      loading ||
                      assignmentLocked ||
                      editingAccount !== null ||
                      personalAccount !== null ||
                      operationsAccount !== null
                    }
                    checked={
                      shownAccounts.some((account) => account.state !== 'offboarding') &&
                      shownAccounts
                        .filter((account) => account.state !== 'offboarding')
                        .every((account) => selectedIds.includes(account.id))
                    }
                    onChange={(event) =>
                      setSelectedIds(
                        event.target.checked
                          ? shownAccounts
                              .filter((account) => account.state !== 'offboarding')
                              .map((account) => account.id)
                          : []
                      )
                    }
                  />
                </th>
                <th scope="col" className="p-3">
                  Email / display name
                </th>
                <th scope="col" className="p-3">
                  Management
                </th>
                <th scope="col" className="p-3">
                  Group
                </th>
                <th scope="col" className="p-3">
                  Membership / expiry
                </th>
                <th scope="col" className="p-3">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {pendingAccounts
                .filter((account) =>
                  `${account.email ?? ''} ${account.name}`
                    .toLowerCase()
                    .includes(search.toLowerCase())
                )
                .map((account) => (
                  <tr key={`local:${account.id}`} className="border-t">
                    <td className="p-3" />
                    <td className="break-all p-3">{account.email || account.name}</td>
                    <td className="p-3">
                      {connected.busy || connected.waiting
                        ? 'Preparing account…'
                        : connected.connections.some(
                              (row) =>
                                row.localId === account.id && row.status === 'needs_credentials'
                            )
                          ? 'Saved login needed'
                          : 'Setup pending'}
                    </td>
                    <td className="p-3">Unassigned</td>
                    <td className="p-3">Not set</td>
                    <td className="p-3">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={connected.busy || connected.waiting}
                        onClick={() => openAddAccount(account)}
                      >
                        Save email and password
                      </Button>
                    </td>
                  </tr>
                ))}
              {shownAccounts.map((account) => (
                <tr key={account.id} className="border-t">
                  <td className="p-3">
                    <input
                      type="checkbox"
                      aria-label={`Select ${account.email}`}
                      checked={selectedIds.includes(account.id)}
                      disabled={
                        loading ||
                        assignmentLocked ||
                        account.state === 'offboarding' ||
                        editingAccount !== null ||
                        personalAccount !== null ||
                        operationsAccount !== null
                      }
                      onChange={(event) =>
                        setSelectedIds((previous) =>
                          event.target.checked
                            ? [...previous, account.id]
                            : previous.filter((id) => id !== account.id)
                        )
                      }
                    />
                  </td>
                  <td className="break-all p-3">
                    {account.email}
                    {account.name !== account.email && (
                      <p className="text-xs text-muted-foreground">{account.name}</p>
                    )}
                  </td>
                  <td className="p-3">
                    {account.state === 'staged'
                      ? 'Needs setup'
                      : account.state === 'offboarding'
                        ? 'Offboarding'
                        : account.expired
                          ? 'Expired'
                          : 'Active'}
                    {account.state === 'active' && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {account.appliedVersion === account.policyVersion &&
                        account.appliedTarget === (account.expired ? 'suspended' : 'active')
                          ? 'Last sync verified'
                          : 'Sync pending / attention required'}
                      </p>
                    )}
                  </td>
                  <td className="p-3">
                    {account.groupId
                      ? (groups.find((group) => group.id === account.groupId)?.name ??
                        'Assigned (group not loaded)')
                      : 'Unassigned'}
                  </td>
                  <td className="p-3">
                    {account.membershipType === 'lifetime'
                      ? 'Lifetime — no expiry'
                      : account.expiry
                        ? new Date(account.expiry.at).toLocaleString('en-US', {
                            timeZone: account.expiry.timezone,
                            timeZoneName: 'short',
                          })
                        : 'Not set'}
                  </td>
                  <td className="p-3">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        loading ||
                        editingAccount !== null ||
                        personalAccount !== null ||
                        operationsAccount !== null ||
                        selectedIds.length > 0 ||
                        account.state === 'offboarding'
                      }
                      aria-label={`Edit membership for ${account.email}`}
                      aria-controls="managed-membership-editor"
                      onClick={(event) => {
                        returnFocus.current = event.currentTarget
                        setMembershipNotice('')
                        setEditingAccount(account)
                        setEditorRevision((revision) => revision + 1)
                      }}
                    >
                      Membership
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={
                        loading ||
                        editingAccount !== null ||
                        personalAccount !== null ||
                        operationsAccount !== null ||
                        selectedIds.length > 0 ||
                        account.state === 'offboarding'
                      }
                      aria-label={`Edit personal addons for ${account.email}`}
                      onClick={(event) => {
                        returnFocus.current = event.currentTarget
                        setMembershipNotice('')
                        setPersonalAccount(account)
                      }}
                    >
                      Personal addons
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      disabled={
                        loading ||
                        !!editingAccount ||
                        !!personalAccount ||
                        !!operationsAccount ||
                        selectedIds.length > 0
                      }
                      aria-label={`Manage sync for ${account.email}`}
                      onClick={(event) => {
                        returnFocus.current = event.currentTarget
                        setMembershipNotice('')
                        setOperationsAccount(account)
                      }}
                    >
                      {account.state === 'staged' ? 'Activate / preview' : 'Sync / manage'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && shownAccounts.length === 0 && pendingAccounts.length === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              {view === 'expired'
                ? 'No expired users match this view.'
                : accounts.length
                  ? 'No loaded users match this search.'
                  : 'No accounts yet. Add a Stremio account to get started.'}
            </p>
          )}
          {loading && accounts.length === 0 && (
            <p role="status" className="p-4 text-sm">
              Loading accounts…
            </p>
          )}
        </div>
        {nextCursor && (
          <Button
            variant="outline"
            disabled={loading || assignmentLocked}
            onClick={() => {
              void loadInventory(nextCursor)
            }}
          >
            Load more users
          </Button>
        )}
      </section>
    </div>
  )
}
