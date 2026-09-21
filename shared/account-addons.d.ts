import type { ManagedAddon } from './addon-config.js'
export type AccountAddonOverrides = { addons: ManagedAddon[]; removed: string[]; order: string[] }
type Failure = { ok: false; code: string }
export function emptyAccountOverrides(): AccountAddonOverrides
export function sameAddonSetup(first: unknown, second: unknown): boolean
export function parseAccountOverrides(
  value: unknown
): { ok: true; overrides: AccountAddonOverrides } | Failure
export function applyAccountOverrides(
  group: ManagedAddon[],
  personal: ManagedAddon[],
  overrides?: AccountAddonOverrides
): { ok: true; addons: ManagedAddon[] } | Failure
export function accountSetupChanges(
  group: ManagedAddon[],
  desired: ManagedAddon[]
): { ok: true; personal: ManagedAddon[]; overrides: AccountAddonOverrides } | Failure
