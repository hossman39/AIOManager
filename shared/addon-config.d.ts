export const MAX_MANAGED_ADDONS: number
export const MAX_ADDON_CONFIG_BYTES: number
export interface ManagedCatalog {
  id: string
  type: string
  name?: string
  extra?: Array<{ name: string; isRequired?: boolean; options?: string[]; [key: string]: unknown }>
  [key: string]: unknown
}
export interface ManagedManifest {
  id: string
  name: string
  version: string
  description?: string
  logo?: string
  background?: string
  types?: string[]
  catalogs?: ManagedCatalog[]
  resources?: unknown[]
  behaviorHints?: { configurationRequired?: boolean; [key: string]: unknown }
  [key: string]: unknown
}
export interface ManagedCinemetaConfig {
  removeSearchArtifacts: boolean
  removeStandardCatalogs: boolean
  removeMetaResource: boolean
  [key: string]: unknown
}
export interface ManagedAddon {
  transportUrl: string
  manifest: ManagedManifest
  flags?: { enabled?: boolean; protected?: boolean; official?: boolean; [key: string]: unknown }
  metadata?: {
    customName?: string
    customLogo?: string
    customDescription?: string
    cinemetaConfig?: ManagedCinemetaConfig
    [key: string]: unknown
  }
  catalogOverrides?: { removed: string[]; [key: string]: unknown }
  [key: string]: unknown
}
export type AddonConfigurationResult =
  | { ok: true; addons: ManagedAddon[] }
  | {
      ok: false
      code:
        | 'INVALID_ADDON_CONFIG'
        | 'ADDON_CONFIG_TOO_LARGE'
        | 'DUPLICATE_ADDON_URL'
        | 'ADDON_LAYER_CONFLICT'
      rows: number[]
    }
export function addonUrlIdentity(value: unknown): string | null
export function parseAddonConfiguration(value: unknown): AddonConfigurationResult
export function combineAddonLayers(group: unknown, personal: unknown): AddonConfigurationResult
