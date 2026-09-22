import type { ManagedAddon } from './addon-config.js'
export function disablesOnExpiry(addon: ManagedAddon): boolean
export function isBrowsingAddon(addon: ManagedAddon): boolean
export function applyGroupExpiryPolicy(
  addons: ManagedAddon[],
  group: ManagedAddon[]
): ManagedAddon[]
