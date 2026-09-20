import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useUnsavedWarning } from '@/components/common/UnsavedWorkGuard'
import { ManagedApiError, type createManagedApi } from '@/api/managed'
import {
  AddonDraftError,
  checkedAddonDraft,
  newDraftAddon,
  moveDraftItem,
  removeDraftAddon,
  editAddonMetadata,
  setCatalogHidden,
  renameDraftCatalog,
  editCinemetaOption,
  replaceDraftUrl,
  resetDraftCatalogs,
  isManagedCinemeta,
} from '@/lib/managed/addon-draft'
import type { ManagedAddon } from '../../../shared/addon-config.js'

type Props = {
  addons: ManagedAddon[]
  onChange: (addons: ManagedAddon[]) => void
  api: Pick<ReturnType<typeof createManagedApi>, 'resolveManifest'>
  disabled?: boolean
  onBusyChange?: (busy: boolean) => void
  onPendingChange?: (pending: boolean) => void
}
const inputClass = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm'
const displayName = (addon: ManagedAddon) => addon.metadata?.customName || addon.manifest.name
const hostLabel = (addon: ManagedAddon) => {
  try {
    return new URL(addon.transportUrl.replace(/^stremio:/i, 'https:')).host
  } catch {
    return 'Configured addon'
  }
}

/** Controlled local draft; the only IO is explicit read-only manifest resolution. */
export function ManagedAddonEditor({
  addons,
  onChange,
  api,
  disabled = false,
  onBusyChange,
  onPendingChange,
}: Props) {
  const prefix = useId()
  const [url, setUrl] = useState('')
  const [expanded, setExpanded] = useState<number | null>(null)
  const [replacement, setReplacement] = useState('')
  const [catalogLimit, setCatalogLimit] = useState(50)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState('')
  const active = useRef(false)
  const request = useRef<AbortController | null>(null)
  const latest = useRef(addons)
  const busyCallback = useRef(onBusyChange)
  const pendingCallback = useRef(onPendingChange)
  latest.current = addons
  busyCallback.current = onBusyChange
  pendingCallback.current = onPendingChange
  const locked = disabled || resolving
  const pendingReplacement = expanded !== null && replacement !== addons[expanded]?.transportUrl
  const pendingUrl = Boolean(url) || pendingReplacement
  useUnsavedWarning(pendingUrl || resolving)
  useEffect(() => {
    pendingCallback.current?.(pendingUrl)
  }, [pendingUrl])

  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      request.current?.abort()
      busyCallback.current?.(false)
      pendingCallback.current?.(false)
    }
  }, [])

  const edit = (index: number, addon: ManagedAddon) => {
    setError('')
    onChange(addons.map((existing, current) => (current === index ? addon : existing)))
  }
  const resolve = async (mode: 'add' | 'replace' | 'catalogs', index?: number) => {
    if (locked || request.current) return
    const snapshot = addons
    const target = index === undefined ? undefined : snapshot[index]
    const transportUrl =
      mode === 'add' ? url.trim() : mode === 'replace' ? replacement.trim() : target?.transportUrl
    if (!transportUrl || (mode !== 'add' && !target)) return
    const controller = new AbortController()
    request.current = controller
    setResolving(true)
    busyCallback.current?.(true)
    setError('')
    try {
      const { manifest } = await api.resolveManifest(transportUrl, controller.signal)
      if (!active.current || controller.signal.aborted || latest.current !== snapshot) return
      if (mode === 'add') {
        onChange(checkedAddonDraft([...snapshot, newDraftAddon(transportUrl, manifest)]))
        setUrl('')
      } else if (target) {
        const updated =
          mode === 'replace'
            ? replaceDraftUrl(target, transportUrl, manifest)
            : resetDraftCatalogs(target, manifest)
        onChange(
          checkedAddonDraft(snapshot.map((addon, current) => (current === index ? updated : addon)))
        )
        if (mode === 'replace') setReplacement(transportUrl)
      }
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof ManagedApiError || failure instanceof AddonDraftError
            ? failure.message
            : 'The manifest could not be read. The draft was not changed.'
        )
    } finally {
      request.current = null
      if (active.current) {
        setResolving(false)
        busyCallback.current?.(false)
      }
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <fieldset disabled={locked} className="min-w-0 space-y-2">
        <label htmlFor={`${prefix}-url`} className="block text-sm font-medium">
          Configured manifest URL
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`${prefix}-url`}
            className={inputClass}
            value={url}
            maxLength={65_536}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://addon.example/config/manifest.json"
          />
          <Button
            type="button"
            className="shrink-0"
            disabled={!url.trim() || addons.length >= 200}
            onClick={() => void resolve('add')}
          >
            Resolve &amp; add
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Configure addons in their own apps. This reads the manifest; it does not install anything
          on a user.
        </p>
      </fieldset>
      {resolving && (
        <p role="status" className="text-sm">
          Reading the manifest…{' '}
          <button type="button" className="underline" onClick={() => request.current?.abort()}>
            Cancel read
          </button>
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {pendingUrl && (
        <p className="text-sm">
          A URL has not been applied to this draft. Resolve it or{' '}
          <button
            type="button"
            className="underline"
            disabled={locked}
            onClick={() => {
              setUrl('')
              setReplacement(expanded === null ? '' : addons[expanded].transportUrl)
            }}
          >
            clear unapplied URLs
          </button>{' '}
          before saving or closing.
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {addons.length} saved addons. Disabled entries stay in this setup. Order is top to bottom.
      </p>
      {addons.length === 0 && (
        <p className="rounded border border-dashed p-4 text-sm">No addons in this draft.</p>
      )}
      <ol className="space-y-3">
        {addons.map((addon, index) => {
          const name = displayName(addon)
          const catalogs = addon.manifest.catalogs ?? []
          const hidden = new Set(addon.catalogOverrides?.removed ?? [])
          const open = expanded === index
          return (
            <li key={addon.transportUrl} className="min-w-0 rounded-lg border p-3">
              <fieldset disabled={locked} className="min-w-0 space-y-3">
                <legend className="sr-only">Settings for {name}</legend>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium">
                      {index + 1}. {name}
                    </p>
                    <p className="break-all text-xs text-muted-foreground">
                      {hostLabel(addon)} · {addon.manifest.id}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={index === 0 || pendingReplacement}
                      aria-label={`Move ${name} up`}
                      onClick={() => {
                        onChange(moveDraftItem(addons, index, index - 1))
                        setExpanded(null)
                      }}
                    >
                      ↑
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={index === addons.length - 1 || pendingReplacement}
                      aria-label={`Move ${name} down`}
                      onClick={() => {
                        onChange(moveDraftItem(addons, index, index + 1))
                        setExpanded(null)
                      }}
                    >
                      ↓
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={addon.flags?.enabled !== false}
                      onChange={(event) =>
                        edit(index, {
                          ...addon,
                          flags: { ...addon.flags, enabled: event.target.checked },
                        })
                      }
                    />
                    Enabled
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={addon.flags?.protected === true}
                      onChange={(event) =>
                        edit(index, {
                          ...addon,
                          flags: { ...addon.flags, protected: event.target.checked },
                        })
                      }
                    />
                    Protected
                  </label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-expanded={open}
                    disabled={pendingReplacement}
                    aria-controls={`${prefix}-details-${index}`}
                    onClick={() => {
                      setExpanded(open ? null : index)
                      setReplacement(addon.transportUrl)
                      setCatalogLimit(50)
                    }}
                  >
                    Customize
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={addon.flags?.protected === true || pendingReplacement}
                    aria-label={`Remove ${name} from draft`}
                    onClick={() => {
                      onChange(removeDraftAddon(addons, index))
                      setExpanded(null)
                    }}
                  >
                    Remove from draft
                  </Button>
                </div>
                {open && (
                  <div
                    id={`${prefix}-details-${index}`}
                    className="min-w-0 space-y-4 border-t pt-4"
                  >
                    <p className="text-xs text-muted-foreground">
                      Protection prevents accidental removal. Actual account changes still respect
                      effective safe mode; expiry overrides protection without deleting this setup.
                    </p>
                    {(['customName', 'customLogo', 'customDescription'] as const).map((key) => {
                      const label = {
                        customName: 'Display name',
                        customLogo: 'Logo URL',
                        customDescription: 'Description',
                      }[key]
                      return (
                        <label
                          key={key}
                          className="block space-y-1 text-sm"
                          htmlFor={`${prefix}-${key}`}
                        >
                          <span>{label} override (blank uses original)</span>
                          {key === 'customDescription' ? (
                            <textarea
                              id={`${prefix}-${key}`}
                              rows={3}
                              className={inputClass}
                              value={addon.metadata?.[key] ?? ''}
                              onChange={(event) =>
                                edit(index, editAddonMetadata(addon, key, event.target.value))
                              }
                            />
                          ) : (
                            <input
                              id={`${prefix}-${key}`}
                              className={inputClass}
                              autoComplete="off"
                              value={addon.metadata?.[key] ?? ''}
                              onChange={(event) =>
                                edit(index, editAddonMetadata(addon, key, event.target.value))
                              }
                            />
                          )}
                        </label>
                      )
                    })}
                    {isManagedCinemeta(addon) && (
                      <fieldset className="space-y-2 rounded border p-3">
                        <legend className="px-1 text-sm font-medium">Cinemeta options</legend>
                        {(
                          [
                            'removeSearchArtifacts',
                            'removeStandardCatalogs',
                            'removeMetaResource',
                          ] as const
                        ).map((key) => (
                          <label key={key} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={addon.metadata?.cinemetaConfig?.[key] ?? false}
                              onChange={(event) =>
                                edit(index, editCinemetaOption(addon, key, event.target.checked))
                              }
                            />
                            {
                              {
                                removeSearchArtifacts: 'Remove search artifacts',
                                removeStandardCatalogs:
                                  'Hide standard catalogs (preserve search unless disabled above)',
                                removeMetaResource: 'Remove metadata resource',
                              }[key]
                            }
                          </label>
                        ))}
                        <p className="text-xs text-muted-foreground">
                          The original manifest and all three choices are retained for managed sync.
                        </p>
                      </fieldset>
                    )}
                    <div className="space-y-2">
                      <h5 className="text-sm font-medium">Catalogs ({catalogs.length})</h5>
                      <p className="text-xs text-muted-foreground">
                        Visibility follows AIOManager’s catalog-ID rule: hiding an ID hides every
                        type with that ID. Hidden catalogs are retained.
                      </p>
                      {catalogs.slice(0, catalogLimit).map((catalog, position) => (
                        <div
                          key={`${catalog.type}:${catalog.id}:${position}`}
                          className="space-y-2 rounded border p-2"
                        >
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={!hidden.has(catalog.id)}
                              onChange={(event) =>
                                edit(
                                  index,
                                  setCatalogHidden(addon, catalog.id, !event.target.checked)
                                )
                              }
                            />
                            Visible · {catalog.type} / {catalog.id}
                          </label>
                          <label
                            className="block space-y-1 text-sm"
                            htmlFor={`${prefix}-catalog-${position}`}
                          >
                            <span>Catalog name</span>
                            <input
                              id={`${prefix}-catalog-${position}`}
                              className={inputClass}
                              value={catalog.name ?? ''}
                              onChange={(event) =>
                                edit(index, renameDraftCatalog(addon, position, event.target.value))
                              }
                            />
                          </label>
                          <div className="flex gap-2">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={position === 0}
                              aria-label={`Move catalog ${catalog.type} ${catalog.id} up`}
                              onClick={() =>
                                edit(index, {
                                  ...addon,
                                  manifest: {
                                    ...addon.manifest,
                                    catalogs: moveDraftItem(catalogs, position, position - 1),
                                  },
                                })
                              }
                            >
                              ↑
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={position === catalogs.length - 1}
                              aria-label={`Move catalog ${catalog.type} ${catalog.id} down`}
                              onClick={() =>
                                edit(index, {
                                  ...addon,
                                  manifest: {
                                    ...addon.manifest,
                                    catalogs: moveDraftItem(catalogs, position, position + 1),
                                  },
                                })
                              }
                            >
                              ↓
                            </Button>
                          </div>
                        </div>
                      ))}
                      {catalogs.length > catalogLimit && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setCatalogLimit((limit) => limit + 50)}
                        >
                          Show next 50 catalogs
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-auto max-w-full whitespace-normal py-2 text-left"
                        onClick={() => void resolve('catalogs', index)}
                      >
                        Read original catalogs &amp; reset this draft’s catalog edits
                      </Button>
                    </div>
                    <label className="block space-y-1 text-sm" htmlFor={`${prefix}-replacement`}>
                      <span>Replace configured URL (same addon only)</span>
                      <input
                        id={`${prefix}-replacement`}
                        className={inputClass}
                        value={replacement}
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={65_536}
                        onChange={(event) => setReplacement(event.target.value)}
                      />
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={!replacement.trim() || replacement.trim() === addon.transportUrl}
                      onClick={() => void resolve('replace', index)}
                    >
                      Validate replacement URL
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      Saved names, catalogs, order and enabled preferences are kept. Add a different
                      addon as a new entry.
                    </p>
                  </div>
                )}
              </fieldset>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
