import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Copy,
  ExternalLink,
  GripVertical,
  Library,
  List,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Settings,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { AddonMetadataDialog } from '@/components/addons/AddonMetadataDialog'
import { AddonReorderDialog } from '@/components/addons/AddonReorderDialog'
import { CatalogEditorDialog } from '@/components/addons/CatalogEditorDialog'
import { useAddonStore } from '@/store/addonStore'
import { ManagedApiError, type createManagedApi } from '@/api/managed'
import type { AddonDescriptor } from '@/types/addon'
import {
  AddonDraftError,
  checkedAddonDraft,
  editAddonMetadata,
  editCinemetaOption,
  isManagedCinemeta,
  newDraftAddon,
  replaceDraftUrl,
} from '@/lib/managed/addon-draft'
import { addonUrlIdentity, type ManagedAddon } from '../../../shared/addon-config.js'
import { sameAddonSetup } from '../../../shared/account-addons.js'

type Props = {
  addons: ManagedAddon[]
  onChange: (addons: ManagedAddon[]) => void
  api: Pick<ReturnType<typeof createManagedApi>, 'resolveManifest'>
  disabled?: boolean
  renewalOnly?: boolean
  groupAddons?: ManagedAddon[]
  onBusyChange?: (busy: boolean) => void
  onPendingChange?: (pending: boolean) => void
}
const nameOf = (addon: ManagedAddon) => addon.metadata?.customName || addon.manifest.name
const descriptor = (addon: ManagedAddon) =>
  ({
    ...addon,
    manifest: { ...addon.manifest, description: addon.manifest.description ?? '' },
  }) as AddonDescriptor
const describe = (error: unknown) =>
  error instanceof ManagedApiError || error instanceof AddonDraftError
    ? error.message
    : 'The addon could not be updated. Try again.'
function configureLink(url: string) {
  try {
    const parsed = new URL(url.replace(/^stremio:/i, 'https:'))
    if (!['http:', 'https:'].includes(parsed.protocol)) return null
    parsed.pathname = parsed.pathname.replace(/\/manifest\.json\/?$/, '/configure')
    return parsed.href
  } catch {
    return null
  }
}

/** Edits a draft only. The parent owns the versioned save and verified sync. */
export function ManagedAddonCards({
  addons,
  onChange,
  api,
  disabled = false,
  renewalOnly = false,
  groupAddons,
  onBusyChange,
  onPendingChange,
}: Props) {
  const [search, setSearch] = useState('')
  const [dialog, setDialog] = useState<
    'install' | 'library' | 'reorder' | 'configure' | 'metadata' | 'catalogs' | 'remove' | null
  >(null)
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const library = useAddonStore((state) => state.library)
  const controller = useRef<AbortController | null>(null)
  const callbacks = useRef({ onBusyChange, onPendingChange })
  callbacks.current = { onBusyChange, onPendingChange }
  useEffect(() => {
    callbacks.current.onBusyChange?.(busy)
    return () => callbacks.current.onBusyChange?.(false)
  }, [busy])
  useEffect(() => {
    callbacks.current.onPendingChange?.(dialog !== null)
    return () => callbacks.current.onPendingChange?.(false)
  }, [dialog])
  useEffect(() => () => controller.current?.abort(), [])
  const selected = addons.find((addon) => addon.transportUrl === selectedUrl)
  const selectedDescriptor = useMemo(() => (selected ? descriptor(selected) : null), [selected])
  const legacyAddons = useMemo(() => addons.map(descriptor), [addons])
  const locked = disabled || busy
  const commit = (next: ManagedAddon[]) => {
    onChange(checkedAddonDraft(next))
    setError('')
    setNotice('Draft updated. Save changes to apply this setup.')
  }
  const edit = (oldUrl: string, next: ManagedAddon) =>
    commit(addons.map((addon) => (addon.transportUrl === oldUrl ? next : addon)))
  const open = (kind: typeof dialog, addon?: ManagedAddon) => {
    setError('')
    setNotice('')
    setSelectedUrl(addon?.transportUrl ?? null)
    setUrl(addon?.transportUrl ?? '')
    setDialog(kind)
  }
  const close = () => {
    if (!busy) {
      setDialog(null)
      setUrl('')
      setSelectedUrl(null)
    }
  }
  const resolve = async (mode: 'install' | 'replace' | 'reinstall', addon?: ManagedAddon) => {
    if (locked || controller.current) return
    const abort = new AbortController()
    controller.current = abort
    setBusy(true)
    setError('')
    try {
      const transportUrl = mode === 'reinstall' ? addon!.transportUrl : url.trim()
      const result = await api.resolveManifest(transportUrl, abort.signal)
      if (abort.signal.aborted) return
      if (mode === 'install') commit([...addons, newDraftAddon(transportUrl, result.manifest)])
      else {
        const replacement = replaceDraftUrl(addon!, transportUrl, result.manifest)
        // Refresh the provider manifest while retaining this setup's catalog edits and preferences.
        edit(
          addon!.transportUrl,
          mode === 'reinstall'
            ? {
                ...replacement,
                manifest: {
                  ...result.manifest,
                  catalogs: addon!.manifest.catalogs ?? result.manifest.catalogs,
                },
              }
            : replacement
        )
      }
      setDialog(null)
      setUrl('')
      setSelectedUrl(null)
    } catch (failure) {
      if (!abort.signal.aborted) setError(describe(failure))
    } finally {
      controller.current = null
      if (!abort.signal.aborted) setBusy(false)
    }
  }
  const visible = addons.filter((addon) =>
    `${nameOf(addon)} ${addon.manifest.id}`.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="mr-auto w-full sm:max-w-xs"
          placeholder="Search addons…"
          aria-label="Search addons"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          variant="outline"
          disabled={locked || addons.length < 2}
          onClick={() => open('reorder')}
        >
          <GripVertical className="h-4 w-4" /> Reorder
        </Button>
        <Button variant="outline" disabled={locked} onClick={() => open('library')}>
          <Library className="h-4 w-4" /> Library
        </Button>
        <Button disabled={locked} onClick={() => open('install')}>
          <Plus className="h-4 w-4" /> Install addon
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {visible.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center text-muted-foreground">
          {addons.length
            ? 'No matching addons.'
            : 'No addons yet. Install an addon or choose one from your library.'}
        </div>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((addon) => {
          const base = groupAddons?.find(
            (item) => addonUrlIdentity(item.transportUrl) === addonUrlIdentity(addon.transportUrl)
          )
          const custom = base && !sameAddonSetup([base], [addon])
          const logo = addon.metadata?.customLogo || addon.manifest.logo
          return (
            <article
              key={addon.transportUrl}
              aria-label={nameOf(addon)}
              className="flex min-w-0 flex-col rounded-xl border bg-card p-5"
            >
              <div className="mb-4 flex items-start gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {logo ? (
                    <img
                      src={logo}
                      alt=""
                      className="h-full w-full object-contain"
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.style.display = 'none'
                      }}
                    />
                  ) : (
                    <Package className="h-6 w-6 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="break-words font-semibold">{nameOf(addon)}</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    v{addon.manifest.version}
                    {addon.flags?.protected ? ' · Protected' : ''}
                  </p>
                  {groupAddons && (
                    <span className="mt-1 inline-block text-xs text-muted-foreground">
                      {base
                        ? custom
                          ? 'Customized for this account'
                          : 'From group'
                        : 'This account only'}
                    </span>
                  )}
                </div>
                <Switch
                  checked={addon.flags?.enabled !== false}
                  disabled={locked}
                  aria-label={`${renewalOnly ? 'Enable on renewal' : 'Enable'} ${nameOf(addon)}`}
                  className={renewalOnly ? 'data-[state=checked]:bg-muted-foreground' : undefined}
                  onCheckedChange={(enabled) =>
                    edit(addon.transportUrl, { ...addon, flags: { ...addon.flags, enabled } })
                  }
                />
              </div>
              {renewalOnly && (
                <p className="mb-3 text-xs text-muted-foreground">
                  On renewal: {addon.flags?.enabled !== false ? 'enabled' : 'disabled'}
                </p>
              )}
              <p className="mb-4 line-clamp-2 min-h-10 text-sm text-muted-foreground">
                {addon.metadata?.customDescription ||
                  addon.manifest.description ||
                  'No description available.'}
              </p>
              <div className="mb-4 mt-auto flex min-w-0 items-center gap-2 rounded border px-2 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                  {addon.transportUrl}
                </span>
                <button
                  className="shrink-0 p-1 text-muted-foreground hover:text-foreground"
                  aria-label={`Copy ${nameOf(addon)} URL`}
                  onClick={() => {
                    void navigator.clipboard.writeText(addon.transportUrl).then(
                      () => setNotice('Addon URL copied.'),
                      () => setError('The URL could not be copied.')
                    )
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => open('configure', addon)}
                >
                  <Settings className="h-3.5 w-3.5" /> Configure
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={locked || !addon.manifest.catalogs?.length}
                  onClick={() => open('catalogs', addon)}
                >
                  <List className="h-3.5 w-3.5" /> Catalogs
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => open('metadata', addon)}
                >
                  <Pencil className="h-3.5 w-3.5" /> Customize
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={locked}
                  onClick={() => void resolve('reinstall', addon)}
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Reinstall
                </Button>
              </div>
              <div className="mt-3 flex items-center justify-between gap-2">
                {custom ? (
                  <button
                    className="text-xs text-muted-foreground hover:text-foreground"
                    disabled={locked}
                    onClick={() => edit(addon.transportUrl, structuredClone(base))}
                  >
                    Use group version
                  </button>
                ) : (
                  <span />
                )}
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                  disabled={locked}
                  onClick={() => open('remove', addon)}
                >
                  <Trash2 className="h-3 w-3" /> Remove
                </button>
              </div>
            </article>
          )
        })}
      </div>
      <Dialog
        open={dialog === 'install' || dialog === 'configure' || dialog === 'library'}
        onOpenChange={(value) => {
          if (!value) close()
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {dialog === 'library'
                ? 'Add from library'
                : dialog === 'configure'
                  ? `Configure ${selected ? nameOf(selected) : 'addon'}`
                  : 'Install addon'}
            </DialogTitle>
            <DialogDescription>
              Changes stay in this draft until you save the setup.
            </DialogDescription>
          </DialogHeader>
          {dialog === 'library' ? (
            <div className="space-y-2">
              {Object.values(library).length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Your library is empty. Use Install addon to add a manifest URL.
                </p>
              )}
              {Object.values(library).map((saved) => (
                <Button
                  className="h-auto w-full justify-start whitespace-normal text-left"
                  variant="outline"
                  key={saved.id}
                  disabled={
                    locked ||
                    addons.some(
                      (addon) =>
                        addonUrlIdentity(addon.transportUrl) === addonUrlIdentity(saved.installUrl)
                    )
                  }
                  onClick={() => {
                    try {
                      commit([
                        ...addons,
                        {
                          ...newDraftAddon(
                            saved.installUrl,
                            checkedAddonDraft([
                              { transportUrl: saved.installUrl, manifest: saved.manifest },
                            ])[0].manifest
                          ),
                          ...(saved.metadata ? { metadata: saved.metadata } : {}),
                          ...(saved.catalogOverrides
                            ? { catalogOverrides: saved.catalogOverrides }
                            : {}),
                        },
                      ])
                      close()
                    } catch (failure) {
                      setError(describe(failure))
                    }
                  }}
                >
                  {saved.name}
                </Button>
              ))}
            </div>
          ) : (
            <div className="space-y-4">
              {selected && configureLink(selected.transportUrl) && (
                <Button asChild variant="outline">
                  <a
                    href={configureLink(selected.transportUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-4 w-4" /> Open addon configuration
                  </a>
                </Button>
              )}
              <label className="block space-y-2 text-sm">
                <span>Configured manifest URL</span>
                <Input
                  value={url}
                  disabled={locked}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://…/manifest.json"
                  autoComplete="off"
                />
              </label>
              <Button
                disabled={
                  locked ||
                  !url.trim() ||
                  (dialog === 'configure' && url === selected?.transportUrl)
                }
                onClick={() =>
                  void resolve(dialog === 'configure' ? 'replace' : 'install', selected)
                }
              >
                {busy
                  ? 'Checking addon…'
                  : dialog === 'configure'
                    ? 'Update URL in draft'
                    : 'Add to draft'}
              </Button>
              {selected && (
                <div className="space-y-3 border-t pt-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.flags?.protected === true}
                      disabled={locked}
                      onChange={(event) =>
                        edit(selected.transportUrl, {
                          ...selected,
                          flags: { ...selected.flags, protected: event.target.checked },
                        })
                      }
                    />{' '}
                    Protect from automatic replacement
                  </label>
                  {isManagedCinemeta(selected) &&
                    (
                      [
                        'removeSearchArtifacts',
                        'removeStandardCatalogs',
                        'removeMetaResource',
                      ] as const
                    ).map((key, index) => (
                      <label key={key} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={selected.metadata?.cinemetaConfig?.[key] === true}
                          disabled={locked}
                          onChange={(event) =>
                            edit(
                              selected.transportUrl,
                              editCinemetaOption(selected, key, event.target.checked)
                            )
                          }
                        />
                        {
                          [
                            'Hide Cinemeta search catalogs',
                            'Hide standard Cinemeta catalogs',
                            'Disable Cinemeta metadata',
                          ][index]
                        }
                      </label>
                    ))}
                  <p className="text-xs text-muted-foreground">
                    Expiry disables all addons, including protected ones.
                  </p>
                </div>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button variant="ghost" disabled={busy} onClick={close}>
            Done
          </Button>
        </DialogContent>
      </Dialog>
      {selected && dialog === 'metadata' && (
        <AddonMetadataDialog
          open
          onOpenChange={(value) => {
            if (!value) close()
          }}
          addon={selectedDescriptor!}
          draftOnly
          accountId="managed-draft"
          onSave={async (metadata) => {
            let next = selected
            for (const key of ['customName', 'customLogo', 'customDescription'] as const)
              next = editAddonMetadata(next, key, metadata[key] ?? '')
            edit(selected.transportUrl, next)
          }}
        />
      )}
      {selected && dialog === 'catalogs' && (
        <CatalogEditorDialog
          open
          onOpenChange={(value) => {
            if (!value) close()
          }}
          addon={selectedDescriptor!}
          onSave={async (next) => edit(selected.transportUrl, checkedAddonDraft([next])[0])}
          loadOriginal={async () =>
            descriptor(
              newDraftAddon(
                selected.transportUrl,
                (await api.resolveManifest(selected.transportUrl)).manifest
              )
            )
          }
          draftOnly
        />
      )}
      <AddonReorderDialog
        open={dialog === 'reorder'}
        onOpenChange={(value) => {
          if (!value) close()
        }}
        accountId="managed-draft"
        addons={legacyAddons}
        onSave={async (next) => commit(checkedAddonDraft(next))}
      />
      <ConfirmationDialog
        open={dialog === 'remove'}
        onOpenChange={(value) => {
          if (!value) close()
        }}
        title={`Remove ${selected ? nameOf(selected) : 'addon'}?`}
        description={
          selected?.flags?.protected
            ? 'This addon is protected. Removing it here explicitly removes it from this setup when you save.'
            : 'This removes the addon from this setup when you save.'
        }
        confirmText="Remove from draft"
        isDestructive
        onConfirm={() => {
          commit(addons.filter((addon) => addon.transportUrl !== selectedUrl))
          close()
        }}
      />
    </div>
  )
}
