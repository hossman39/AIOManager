export const MAX_MANAGED_ADDONS: number
export const MAX_ADDON_CONFIG_BYTES: number
export interface ManagedAddon {
  transportUrl: string
  manifest: { id: string; name: string; version: string; [key: string]: unknown }
  flags?: { enabled?: boolean; protected?: boolean; official?: boolean; [key: string]: unknown }
  metadata?: { [key: string]: unknown }
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
