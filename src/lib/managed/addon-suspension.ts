import type { AddonDescriptor } from '@/types/addon'

/**
 * Project retained addon configuration into its effective account state.
 *
 * Keep the saved configuration as the source of truth. Never persist this
 * projection over it: that would lose manual enabled preferences on renewal.
 * The existing enabled-only sync serializer omits suspended entries from
 * Stremio while the manager can still display all of their saved configuration.
 * Entitlement calculation, durable persistence, and provider verification belong
 * to the managed worker, not this pure transformation.
 */
export function applyAddonSuspension(
  configuredAddons: readonly AddonDescriptor[],
  suspended: boolean
): AddonDescriptor[] {
  const effectiveAddons = structuredClone([...configuredAddons])
  if (suspended) {
    for (const addon of effectiveAddons) {
      addon.flags = { ...addon.flags, enabled: false }
    }
  }
  return effectiveAddons
}
