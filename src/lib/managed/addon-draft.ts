import {
  parseAddonConfiguration,
  type ManagedAddon,
  type ManagedManifest,
  type ManagedCinemetaConfig,
} from '../../../shared/addon-config.js'

const messages = {
  INVALID_ADDON_CONFIG: 'The addon setup is incomplete or invalid.',
  ADDON_CONFIG_TOO_LARGE: 'The addon setup exceeds 200 entries or 2 MiB.',
  DUPLICATE_ADDON_URL: 'That configured addon URL is already in this setup.',
  ADDON_LAYER_CONFLICT: 'That URL is present in both the group and personal setup.',
  PROTECTED_ADDON: 'Clear this addon’s protection before removing it.',
  MANIFEST_ID_MISMATCH: 'The replacement URL serves a different addon. Add it separately instead.',
} as const

export class AddonDraftError extends Error {
  constructor(public readonly code: keyof typeof messages) {
    super(messages[code])
    this.name = 'AddonDraftError'
  }
}

/** Validate/clone at persistence and network-result boundaries, not each keystroke. */
export function checkedAddonDraft(value: unknown): ManagedAddon[] {
  const parsed = parseAddonConfiguration(value)
  if (!parsed.ok) throw new AddonDraftError(parsed.code)
  return parsed.addons
}

export function isManagedCinemeta(addon: Pick<ManagedAddon, 'manifest' | 'transportUrl'>) {
  if (
    ['com.linvo.cinemeta', 'org.stremio.cinemeta', 'cinemeta'].includes(addon.manifest.id) ||
    addon.manifest.name.toLowerCase() === 'cinemeta'
  )
    return true
  try {
    return (
      new URL(addon.transportUrl.replace(/^stremio:/i, 'https:')).hostname ===
      'v3-cinemeta.strem.io'
    )
  } catch {
    return false
  }
}

export function newDraftAddon(transportUrl: string, manifest: ManagedManifest): ManagedAddon {
  const addon = checkedAddonDraft([{ transportUrl, manifest }])[0]
  return { ...addon, flags: { enabled: true, protected: isManagedCinemeta(addon) } }
}

export function moveDraftItem<T>(items: readonly T[], index: number, destination: number): T[] {
  const next = [...items]
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(destination) ||
    index < 0 ||
    destination < 0 ||
    index >= items.length ||
    destination >= items.length
  )
    return next
  const [entry] = next.splice(index, 1)
  next.splice(destination, 0, entry)
  return next
}

export function removeDraftAddon(addons: readonly ManagedAddon[], index: number) {
  if (addons[index]?.flags?.protected) throw new AddonDraftError('PROTECTED_ADDON')
  return addons.filter((_, current) => current !== index)
}

export function editAddonMetadata(
  addon: ManagedAddon,
  key: 'customName' | 'customLogo' | 'customDescription',
  value: string
): ManagedAddon {
  const metadata = { ...addon.metadata }
  if (value === '') delete metadata[key]
  else metadata[key] = value
  return { ...addon, metadata }
}

export function setCatalogHidden(addon: ManagedAddon, id: string, hidden: boolean): ManagedAddon {
  const removed = new Set(addon.catalogOverrides?.removed ?? [])
  if (hidden) removed.add(id)
  else removed.delete(id)
  return { ...addon, catalogOverrides: { ...addon.catalogOverrides, removed: [...removed] } }
}

export function renameDraftCatalog(addon: ManagedAddon, index: number, name: string): ManagedAddon {
  return {
    ...addon,
    manifest: {
      ...addon.manifest,
      catalogs: (addon.manifest.catalogs ?? []).map((catalog, current) =>
        current === index ? { ...catalog, name } : catalog
      ),
    },
  }
}

export function editCinemetaOption(
  addon: ManagedAddon,
  key: 'removeSearchArtifacts' | 'removeStandardCatalogs' | 'removeMetaResource',
  value: boolean
): ManagedAddon {
  const config: ManagedCinemetaConfig = {
    removeSearchArtifacts: false,
    removeStandardCatalogs: false,
    removeMetaResource: false,
    ...addon.metadata?.cinemetaConfig,
    [key]: value,
  }
  // Retain a clean base: projection, not this editor, applies these transforms.
  return { ...addon, metadata: { ...addon.metadata, cinemetaConfig: config } }
}

export function replaceDraftUrl(
  addon: ManagedAddon,
  transportUrl: string,
  manifest: ManagedManifest
): ManagedAddon {
  if (manifest.id !== addon.manifest.id) throw new AddonDraftError('MANIFEST_ID_MISMATCH')
  // A URL change must not erase custom catalog names/order or saved preferences.
  return checkedAddonDraft([{ ...addon, transportUrl }])[0]
}

export function resetDraftCatalogs(addon: ManagedAddon, manifest: ManagedManifest): ManagedAddon {
  if (manifest.id !== addon.manifest.id) throw new AddonDraftError('MANIFEST_ID_MISMATCH')
  return checkedAddonDraft([
    {
      ...addon,
      manifest: { ...addon.manifest, catalogs: manifest.catalogs ?? [] },
      catalogOverrides: { ...addon.catalogOverrides, removed: [] },
    },
  ])[0]
}
