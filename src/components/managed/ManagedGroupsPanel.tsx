import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedGroup,
  type ManagedGroupSummary,
  type ManagedGroupDraft,
  type ManagedPublication,
  type ManagedPublicationPreview,
  type ManagedDeployment,
} from '@/api/managed'
import { AddonDraftError, checkedAddonDraft } from '@/lib/managed/addon-draft'
import { ManagedAddonEditor } from './ManagedAddonEditor'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

type Api = ReturnType<typeof createManagedApi>
const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm'
const describe = (error: unknown) =>
  error instanceof ManagedApiError || error instanceof AddonDraftError
    ? error.message
    : 'This operation could not be completed.'

type EditorAction =
  | { kind: 'save'; draft: ManagedGroupDraft & { expectedVersion: number } }
  | { kind: 'publish'; publication: ManagedPublication }
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
}: {
  group: ManagedGroup
  api: Api
  onSaved: (result: EditorResult) => void
  onClose: () => void
  onLock: (locked: boolean) => void
  externalBusy: boolean
}) {
  const [name, setName] = useState(group.name)
  const [addons, setAddons] = useState(group.draft)
  const [safeMode, setSafeMode] = useState<boolean | null>(group.safeMode)
  const [dirty, setDirty] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [pendingUrl, setPendingUrl] = useState(false)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [preview, setPreview] = useState<ManagedPublicationPreview | null>(null)
  const [allowEmpty, setAllowEmpty] = useState(false)
  const alive = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const readInFlight = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const mutation = useManagedSubmission<EditorAction, EditorResult>(
    async (action, key, signal) => {
      if (action.kind === 'save') {
        const result = await api.saveGroupDraft(group.id, action.draft, key, signal)
        return { group: result.replayed ? await api.group(group.id, signal) : result.group }
      }
      const result = await api.publishGroup(group.id, action.publication, key, signal)
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
      setPreview(null)
      setAllowEmpty(false)
      onSaved(result)
    }
  )
  const locked =
    externalBusy || mutation.busy || mutation.uncertain || mutation.stale || resolving || reading
  useUnsavedWarning(dirty || mutation.busy || mutation.uncertain)
  useEffect(() => {
    alive.current = true
    heading.current?.focus()
    return () => {
      alive.current = false
      abort.current?.abort()
    }
  }, [])
  useEffect(() => {
    onLock(dirty || pendingUrl || locked)
    return () => onLock(false)
  }, [dirty, pendingUrl, locked, onLock])
  const changed = () => {
    setDirty(true)
    setPreview(null)
    setAllowEmpty(false)
    setError('')
  }

  const prepare = async () => {
    if (locked || dirty || pendingUrl || readInFlight.current) return
    readInFlight.current = true
    const controller = new AbortController()
    abort.current = controller
    setReading(true)
    setError('')
    setPreview(null)
    setAllowEmpty(false)
    try {
      const result = await api.previewGroupPublication(group.id, group.version, controller.signal)
      if (alive.current) setPreview(result)
    } catch (error) {
      if (alive.current) setError(describe(error))
    } finally {
      readInFlight.current = false
      if (alive.current) setReading(false)
    }
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
        setPreview(null)
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
  const save = () => {
    if (locked || pendingUrl || !dirty || !name.trim()) return
    try {
      const draft = {
        name: name.trim(),
        addons: checkedAddonDraft(addons),
        safeMode,
        expectedVersion: group.version,
      }
      setError('')
      void mutation.submit({ kind: 'save', draft })
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
        Saved version {group.version} ·{' '}
        {group.publishedRevision === null
          ? 'Not published'
          : `Published revision ${group.publishedRevision}`}
        . Draft saves do not publish addon changes.
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
          Saved protection settings apply on the next sync. Expiry still disables every addon,
          including protected entries.
        </p>
      </fieldset>
      <ManagedAddonEditor
        key={editorEpoch}
        addons={addons}
        api={api}
        disabled={externalBusy || mutation.busy || mutation.uncertain || mutation.stale || reading}
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
            The submitted operation may already be saved. Its values are frozen; retry confirms that
            same operation without duplicating it.
          </p>
          <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
            Retry the same {mutation.pending?.kind === 'publish' ? 'publication' : 'draft save'}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={locked || pendingUrl || !dirty || !name.trim()}
          onClick={save}
        >
          Save draft
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={locked || dirty || pendingUrl}
          onClick={() => void prepare()}
        >
          {reading ? 'Preparing preview…' : 'Preview publication'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={mutation.busy || mutation.uncertain || reading || resolving}
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
          Unsaved changes. Save this draft before preparing a publication.
        </p>
      )}
      {preview && (
        <div
          className="space-y-3 rounded border p-3 text-sm"
          aria-labelledby="group-publication-preview"
        >
          <h5 id="group-publication-preview" className="font-medium">
            Publication preview
          </h5>
          <p>
            {preview.changes.added} added · {preview.changes.removed} removed ·{' '}
            {preview.changes.changed} changed{preview.changes.reordered ? ' · order changed' : ''}{' '}
            in the group template.
          </p>
          <p>
            {preview.counts.active} active targets · {preview.counts.suspended} expired/suspended
            targets · {preview.counts.staged} staged · {preview.counts.offboarding} offboarding.
          </p>
          <p>
            Active and expired users receive queued work. Expired targets stay disabled. Staged
            users are not activated; offboarding is not cancelled. Safe-mode effects require a fresh
            account read during execution.
          </p>
          <p className="text-muted-foreground">
            Preview expires {new Date(preview.expiresAt).toLocaleTimeString()}. This build does not
            execute provider writes.
          </p>
          {preview.unchanged ? (
            <p role="status">This addon setup is already published. No new rollout is needed.</p>
          ) : (
            <>
              {preview.empty && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={allowEmpty}
                    disabled={locked}
                    onChange={(event) => setAllowEmpty(event.target.checked)}
                  />
                  <span>I intend to publish an empty or entirely disabled group setup.</span>
                </label>
              )}
              <Button
                type="button"
                disabled={locked || pendingUrl || (preview.empty && !allowEmpty)}
                onClick={() =>
                  void mutation.submit({
                    kind: 'publish',
                    publication: {
                      expectedVersion: preview.version,
                      receipt: preview.receipt,
                      allowEmpty,
                    },
                  })
                }
              >
                Publish group revision
              </Button>
            </>
          )}
        </div>
      )}
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
          Create draft group
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
  const [loading, setLoading] = useState(false)
  const [selectionLocked, setSelectionLocked] = useState(false)
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
          ? 'This revision was already published. No new jobs were queued.'
          : `Group revision saved. ${result.queued ?? 0} jobs recorded; provider writes remain disabled.`
      )
      onAccountsChanged()
    } else setNotice('Saved group loaded. Addon changes remain a draft until published.')
  }

  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border bg-card p-5"
      aria-labelledby="managed-groups-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="managed-groups-heading" className="text-lg font-semibold">
          Addon groups
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
      <p className="text-sm text-muted-foreground">
        Create a reusable addon setup, save a draft, then publish one revision for its eligible
        members. This development build records work but does not execute it.
      </p>
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
      {!selected && (
        <NewGroup api={api} onCreated={(group) => saved({ group })} onLock={setSelectionLocked} />
      )}
      <div className="flex flex-wrap gap-2" aria-busy={loading}>
        {groups.map((group) => (
          <Button
            type="button"
            variant={selected?.id === group.id ? 'secondary' : 'outline'}
            key={group.id}
            disabled={loading || selectionLocked}
            onClick={() => void open(group.id)}
            className="h-auto max-w-full whitespace-normal break-words text-left"
          >
            {group.name} · {group.addonCount} addons ·{' '}
            {group.publishedRevision === null
              ? 'draft only'
              : `revision ${group.publishedRevision}`}
          </Button>
        ))}
      </div>
      {next && (
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
        <GroupEditor
          key={`${selected.id}:${selected.version}`}
          group={selected}
          api={api}
          onSaved={saved}
          onClose={() => setSelected(null)}
          onLock={setSelectionLocked}
          externalBusy={loading}
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
            Provider writes are disabled. Pending is not verified, and successful publication does
            not mean an account was changed.
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
