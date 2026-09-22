import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedGroup,
  type ManagedGroupSummary,
  type ManagedGroupChanges,
  type ManagedDeployment,
} from '@/api/managed'
import { AddonDraftError, checkedAddonDraft } from '@/lib/managed/addon-draft'
import { ManagedAddonCards } from './ManagedAddonCards'
import { DeleteGroupButton } from './DeleteGroupButton'
import { ManagedGroupMembers } from './ManagedGroupMembers'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

type Api = ReturnType<typeof createManagedApi>
const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm'
const describe = (error: unknown) =>
  error instanceof ManagedApiError || error instanceof AddonDraftError
    ? error.message
    : 'This operation could not be completed.'

type EditorResult = {
  group: ManagedGroup
  deploymentId?: string
  queued?: number
  unchanged?: boolean
}

function GroupEditor({
  group,
  api,
  onSaved,
  onClose,
  onLock,
  externalBusy,
  onDeleted,
}: {
  group: ManagedGroup
  api: Api
  onSaved: (result: EditorResult) => void
  onClose: () => void
  onLock: (locked: boolean) => void
  externalBusy: boolean
  onDeleted: (count: number) => void
}) {
  const [name, setName] = useState(group.name)
  const [addons, setAddons] = useState(group.draft)
  const [safeMode, setSafeMode] = useState<boolean | null>(group.safeMode)
  const [dirty, setDirty] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [pendingUrl, setPendingUrl] = useState(false)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [reading, setReading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')
  const [allowEmpty, setAllowEmpty] = useState(false)
  const alive = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const readInFlight = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const mutation = useManagedSubmission<ManagedGroupChanges, EditorResult>(
    async (changes, key, signal) => {
      const result = await api.publishGroupChanges(group.id, changes, key, signal)
      return {
        ...result,
        group: result.replayed ? await api.group(group.id, signal) : result.group,
      }
    },
    (result) => {
      setName(result.group.name)
      setAddons(result.group.draft)
      setSafeMode(result.group.safeMode)
      setDirty(false)
      setAllowEmpty(false)
      onSaved(result)
    }
  )
  const editorBusy =
    mutation.busy || mutation.uncertain || mutation.stale || resolving || reading || deleting
  const locked = externalBusy || editorBusy
  const empty = addons.every((addon) => addon.flags?.enabled === false)
  useUnsavedWarning(dirty || pendingUrl || resolving || mutation.busy || mutation.uncertain)
  useEffect(() => {
    alive.current = true
    heading.current?.focus()
    return () => {
      alive.current = false
      abort.current?.abort()
    }
  }, [])
  useEffect(() => {
    onLock(dirty || pendingUrl || editorBusy)
    return () => onLock(false)
  }, [dirty, pendingUrl, editorBusy, onLock])
  const changed = () => {
    setDirty(true)
    setAllowEmpty(false)
    setError('')
  }

  const reload = async () => {
    if (externalBusy || mutation.busy || mutation.uncertain || readInFlight.current || resolving)
      return
    readInFlight.current = true
    const controller = new AbortController()
    abort.current = controller
    setReading(true)
    setError('')
    try {
      const latest = await api.group(group.id, controller.signal)
      if (alive.current) {
        setName(latest.name)
        setAddons(latest.draft)
        setSafeMode(latest.safeMode)
        setDirty(false)
        setAllowEmpty(false)
        setEditorEpoch((value) => value + 1)
        mutation.reset()
        onSaved({ group: latest })
      }
    } catch (error) {
      if (alive.current) setError(describe(error))
    } finally {
      readInFlight.current = false
      if (alive.current) setReading(false)
    }
  }
  const publish = () => {
    if (locked || pendingUrl || !name.trim() || (empty && !allowEmpty)) return
    try {
      const changes = {
        name: name.trim(),
        addons: checkedAddonDraft(addons),
        safeMode,
        expectedVersion: group.version,
        allowEmpty,
      }
      setError('')
      void mutation.submit(changes)
    } catch (error) {
      setError(describe(error))
    }
  }

  return (
    <section
      className="min-w-0 space-y-4 rounded-lg border bg-muted/10 p-4"
      aria-labelledby="managed-group-editor-heading"
    >
      <h4
        ref={heading}
        tabIndex={-1}
        id="managed-group-editor-heading"
        className="break-words font-semibold"
      >
        Edit group: {group.name}
      </h4>
      <p className="text-sm text-muted-foreground">
        {group.publishedRevision === null
          ? 'Add your addons, then publish to make this group ready to use.'
          : 'Publish changes to save your edits and sync them to group members.'}
      </p>
      <fieldset disabled={locked} className="min-w-0 space-y-3">
        <label className="block space-y-1 text-sm" htmlFor="managed-group-name">
          <span>Group name</span>
          <input
            id="managed-group-name"
            className={field}
            maxLength={120}
            value={name}
            onChange={(event) => {
              setName(event.target.value)
              changed()
            }}
          />
        </label>
        <label className="block space-y-1 text-sm" htmlFor="managed-group-safety">
          <span>Safe mode</span>
          <select
            id="managed-group-safety"
            className={field}
            value={safeMode === null ? 'inherit' : safeMode ? 'on' : 'off'}
            onChange={(event) => {
              setSafeMode(event.target.value === 'inherit' ? null : event.target.value === 'on')
              changed()
            }}
          >
            <option value="inherit">Inherit manager default</option>
            <option value="on">Enabled</option>
            <option value="off">Disabled — allow replacement operations</option>
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          Publishing applies these settings to accounts with sync started. The expiry choices below
          also apply to protected addons.
        </p>
      </fieldset>
      <ManagedAddonCards
        key={editorEpoch}
        addons={addons}
        expiryControls
        api={api}
        disabled={
          externalBusy ||
          mutation.busy ||
          mutation.uncertain ||
          mutation.stale ||
          reading ||
          deleting
        }
        onBusyChange={setResolving}
        onPendingChange={setPendingUrl}
        onChange={(value) => {
          setAddons(value)
          changed()
        }}
      />
      {(error || mutation.message) && (
        <p role="alert" className="text-sm text-destructive">
          {error || mutation.message}
        </p>
      )}
      {mutation.uncertain && (
        <div className="space-y-2 rounded border border-amber-500/40 p-3 text-sm">
          <p>
            These changes may already be published. Retry to confirm the result without applying
            them twice.
          </p>
          <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
            Retry publication
          </Button>
        </div>
      )}
      {empty && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={allowEmpty}
            disabled={locked}
            onChange={(event) => setAllowEmpty(event.target.checked)}
          />
          <span>Publish this group with no enabled addons.</span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={locked || pendingUrl || !name.trim() || (empty && !allowEmpty)}
          onClick={publish}
        >
          {mutation.busy ? 'Publishing…' : 'Publish changes'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={
            externalBusy || mutation.busy || mutation.uncertain || reading || resolving || deleting
          }
          onClick={() => void reload()}
        >
          {dirty || pendingUrl ? 'Discard edits & reload saved group' : 'Reload saved group'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={dirty || pendingUrl || locked}
          onClick={onClose}
        >
          Close editor
        </Button>
      </div>
      {dirty && (
        <p role="status" className="text-sm">
          Unpublished changes.
        </p>
      )}
      <DeleteGroupButton
        api={api}
        group={group}
        disabled={locked || dirty || pendingUrl}
        onBusy={setDeleting}
        onDeleted={onDeleted}
      />
    </section>
  )
}

function NewGroup({
  api,
  onCreated,
  onLock,
}: {
  api: Api
  onCreated: (group: ManagedGroup) => void
  onLock: (locked: boolean) => void
}) {
  const [name, setName] = useState('')
  const mutation = useManagedSubmission<{ name: string }, ManagedGroup>(
    async ({ name }, key, signal) => {
      const result = await api.createGroup({ name, addons: [], safeMode: null }, key, signal)
      return result.replayed ? await api.group(result.group.id, signal) : result.group
    },
    (group) => {
      setName('')
      onCreated(group)
    }
  )
  useUnsavedWarning(Boolean(name) || mutation.uncertain || mutation.busy)
  useEffect(() => {
    onLock(Boolean(name) || mutation.uncertain || mutation.busy)
    return () => onLock(false)
  }, [name, mutation.uncertain, mutation.busy, onLock])
  return (
    <div className="space-y-2">
      <label className="block text-sm" htmlFor="managed-new-group">
        New group name
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id="managed-new-group"
          className={field}
          maxLength={120}
          value={name}
          disabled={mutation.busy || mutation.uncertain || mutation.stale}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="button"
          className="shrink-0"
          disabled={mutation.busy || mutation.uncertain || mutation.stale || !name.trim()}
          onClick={() => void mutation.submit({ name: name.trim() })}
        >
          Create group
        </Button>
      </div>
      {mutation.message && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.message}
        </p>
      )}
      {mutation.uncertain && (
        <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
          Retry same group creation
        </Button>
      )}
      {mutation.stale && (
        <Button
          type="button"
          onClick={() => {
            mutation.reset()
            setName('')
          }}
        >
          Clear stale creation
        </Button>
      )}
    </div>
  )
}

export function ManagedGroupsPanel({
  api,
  onAccountsChanged,
  onGroupsChanged,
}: {
  api: Api
  onAccountsChanged: () => void
  onGroupsChanged?: (groups: ManagedGroupSummary[]) => void
}) {
  const [groups, setGroups] = useState<ManagedGroupSummary[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [selected, setSelected] = useState<ManagedGroup | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(false)
  const [editorLocked, setEditorLocked] = useState(false)
  const [membersLocked, setMembersLocked] = useState(false)
  const selectionLocked = editorLocked || membersLocked
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [deployment, setDeployment] = useState<ManagedDeployment | null>(null)
  const [progressError, setProgressError] = useState('')
  const [progressLoading, setProgressLoading] = useState(false)
  const [progressGroupId, setProgressGroupId] = useState<string | null>(null)
  const shownDeployment = deployment?.groupId === selected?.id ? deployment : null
  const progressPending = progressGroupId !== selected?.id || progressLoading
  const sequence = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const progressAbort = useRef<AbortController | null>(null)
  const alive = useRef(false)
  const load = useCallback(
    async (after = '') => {
      const token = ++sequence.current
      abort.current?.abort()
      const controller = new AbortController()
      abort.current = controller
      setLoading(true)
      setError('')
      try {
        const page = await api.groups(after, controller.signal)
        if (!alive.current || token !== sequence.current) return
        setGroups((previous) => {
          const merged = page.groups.map((group) => {
            const saved = previous.find((item) => item.id === group.id)
            return saved && saved.version > group.version ? saved : group
          })
          return after
            ? [
                ...previous.filter((group) => !merged.some((item) => item.id === group.id)),
                ...merged,
              ]
            : merged
        })
        setNext(page.nextCursor)
      } catch (error) {
        if (alive.current && token === sequence.current) setError(describe(error))
      } finally {
        if (alive.current && token === sequence.current) setLoading(false)
      }
    },
    [api]
  )
  const cancelReads = useCallback(() => {
    sequence.current++
    abort.current?.abort()
    progressAbort.current?.abort()
  }, [])
  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
      cancelReads()
    }
  }, [load, cancelReads])
  useEffect(() => {
    onGroupsChanged?.(groups)
  }, [groups, onGroupsChanged])
  const open = async (id: string) => {
    if (selectionLocked || loading) return
    const token = ++sequence.current
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setLoading(true)
    setError('')
    setNotice('')
    try {
      const group = await api.group(id, controller.signal)
      if (alive.current && token === sequence.current) setSelected(group)
    } catch (error) {
      if (alive.current && token === sequence.current) setError(describe(error))
    } finally {
      if (alive.current && token === sequence.current) setLoading(false)
    }
  }
  const progress = useCallback(
    async (id: string) => {
      progressAbort.current?.abort()
      const controller = new AbortController()
      progressAbort.current = controller
      setProgressGroupId(id)
      setProgressLoading(true)
      setProgressError('')
      setDeployment(null)
      try {
        const state = await api.groupDeployment(id, controller.signal)
        if (alive.current && !controller.signal.aborted) setDeployment(state)
      } catch (error) {
        if (alive.current && !controller.signal.aborted) setProgressError(describe(error))
      } finally {
        if (alive.current && !controller.signal.aborted) setProgressLoading(false)
      }
    },
    [api]
  )
  const selectedId = selected?.id
  const selectedRevision = selected?.publishedRevision
  useEffect(() => {
    setDeployment(null)
    setProgressError('')
    setProgressLoading(false)
    if (selectedId) void progress(selectedId)
    return () => progressAbort.current?.abort()
  }, [selectedId, selectedRevision, progress])
  const saved = (result: EditorResult) => {
    sequence.current++
    abort.current?.abort()
    setLoading(false)
    setSelected(result.group)
    setCreating(false)
    const { draft, ...summary } = result.group
    void draft
    setGroups((previous) => {
      const exists = previous.some((item) => item.id === result.group.id)
      return exists
        ? previous.map((item) => (item.id === result.group.id ? summary : item))
        : [...previous, summary]
    })
    if (result.deploymentId) {
      setNotice(
        result.unchanged
          ? 'Group saved. Addons are already up to date.'
          : `Changes published. ${result.queued ?? 0} account${result.queued === 1 ? '' : 's'} queued for sync.`
      )
      onAccountsChanged()
    } else setNotice('Group ready. Edit addons and publish your changes.')
  }

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="managed-groups-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="managed-groups-heading" className="text-lg font-semibold">
          {selected ? selected.name : 'Your groups'}
        </h3>
        <Button
          type="button"
          variant="outline"
          disabled={loading || selectionLocked}
          onClick={() => void load()}
        >
          Refresh groups
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {!selected && !creating && <Button onClick={() => setCreating(true)}>New group</Button>}
      {!selected && creating && (
        <NewGroup api={api} onCreated={(group) => saved({ group })} onLock={setEditorLocked} />
      )}
      {!selected && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy={loading}>
          {groups.map((group) => (
            <Button
              type="button"
              variant="outline"
              key={group.id}
              disabled={loading || selectionLocked}
              onClick={() => void open(group.id)}
              className="h-auto min-h-28 max-w-full flex-col items-start gap-2 whitespace-normal break-words rounded-xl bg-card p-5 text-left"
            >
              <span className="text-base font-semibold">{group.name}</span>
              <span className="text-sm font-normal text-muted-foreground">
                {group.addonCount} addons ·{' '}
                {group.publishedRevision === null
                  ? 'not published'
                  : `published revision ${group.publishedRevision}`}
              </span>
            </Button>
          ))}
        </div>
      )}
      {next && !selected && (
        <Button
          type="button"
          variant="outline"
          disabled={loading || selectionLocked}
          onClick={() => void load(next)}
        >
          Load more groups
        </Button>
      )}
      {selected && (
        <ManagedGroupMembers
          key={selected.id}
          group={selected}
          groups={groups}
          api={api}
          disabled={loading || editorLocked}
          onLock={setMembersLocked}
          onChanged={onAccountsChanged}
        />
      )}
      {selected && (
        <GroupEditor
          key={`${selected.id}:${selected.version}`}
          group={selected}
          api={api}
          onSaved={saved}
          onClose={() => setSelected(null)}
          onLock={setEditorLocked}
          externalBusy={loading || membersLocked}
          onDeleted={(count) => {
            cancelReads()
            setGroups((previous) => previous.filter((group) => group.id !== selected.id))
            setSelected(null)
            setNotice(
              `Group deleted. ${count} account${count === 1 ? '' : 's'} kept with individual addon setups.`
            )
            onAccountsChanged()
            void load()
          }}
        />
      )}
      {selected && (
        <div
          className="space-y-3 rounded-lg border p-3 text-sm"
          aria-labelledby="managed-rollout-heading"
        >
          <h4 id="managed-rollout-heading" className="font-medium">
            Recorded rollout status — {selected.name}
            {shownDeployment ? ` · revision ${shownDeployment.revision}` : ''}
          </h4>
          <p>
            Pending jobs wait for managed sync to be enabled and resumed. Verified means the server
            read back the expected addon setup from Stremio.
          </p>
          {progressPending && <p role="status">Reading recorded rollout…</p>}
          {!progressPending && !progressError && !shownDeployment && (
            <p>No published rollout recorded.</p>
          )}
          {shownDeployment && (
            <>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Object.entries(shownDeployment.counts).map(([state, count]) => (
                  <div key={state}>
                    <dt className="capitalize text-muted-foreground">{state}</dt>
                    <dd className="text-lg font-medium">{count}</dd>
                  </div>
                ))}
              </dl>
              <p>
                {shownDeployment.skipped.staged} staged and {shownDeployment.skipped.offboarding}{' '}
                offboarding accounts skipped.
              </p>
            </>
          )}
          {!progressPending && progressError && (
            <p role="alert" className="text-destructive">
              {progressError}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={progressPending}
            onClick={() => void progress(selected.id)}
          >
            Refresh recorded status
          </Button>
        </div>
      )}
    </section>
  )
}
