import { addonUrlIdentity, parseAddonConfiguration, MAX_MANAGED_ADDONS } from './addon-config.js'

export const emptyAccountOverrides = () => ({ addons: [], removed: [], order: [] })
const identity = (addon) => addonUrlIdentity(addon.transportUrl)
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value
export const sameAddonSetup = (first, second) =>
  JSON.stringify(canonical(first)) === JSON.stringify(canonical(second))

export function parseAccountOverrides(value) {
  const invalid = { ok: false, code: 'INVALID_ADDON_CONFIG' }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !['addons', 'removed', 'order'].includes(key))
  )
    return invalid
  const parsed = parseAddonConfiguration(value.addons)
  if (!parsed.ok) return parsed
  for (const field of ['removed', 'order']) {
    if (
      !Array.isArray(value[field]) ||
      value[field].length > MAX_MANAGED_ADDONS ||
      value[field].some((url) => !addonUrlIdentity(url)) ||
      new Set(value[field].map(addonUrlIdentity)).size !== value[field].length
    )
      return invalid
  }
  if (parsed.addons.some((addon) => value.removed.map(addonUrlIdentity).includes(identity(addon))))
    return invalid
  return {
    ok: true,
    overrides: {
      addons: parsed.addons,
      removed: value.removed.map(addonUrlIdentity),
      order: value.order.map(addonUrlIdentity),
    },
  }
}

/** Account edits replace only that account's copy of a group addon. */
export function applyAccountOverrides(group, personal, value = emptyAccountOverrides()) {
  const base = parseAddonConfiguration(group)
  const extra = parseAddonConfiguration(personal)
  const parsed = parseAccountOverrides(value)
  if (!base.ok) return base
  if (!extra.ok) return extra
  if (!parsed.ok) return parsed
  const overrides = parsed.overrides
  const replacements = new Map(overrides.addons.map((addon) => [identity(addon), addon]))
  const personalByUrl = new Map(extra.addons.map((addon) => [identity(addon), addon]))
  const groupUrls = new Set(base.addons.map(identity))
  const removed = new Set(overrides.removed)
  const combined = parseAddonConfiguration([
    ...base.addons
      .filter((addon) => !removed.has(identity(addon)))
      .map(
        (addon) => replacements.get(identity(addon)) ?? personalByUrl.get(identity(addon)) ?? addon
      ),
    ...extra.addons.filter((addon) => !groupUrls.has(identity(addon))),
  ])
  if (!combined.ok)
    return {
      ...combined,
      code: combined.code === 'DUPLICATE_ADDON_URL' ? 'ADDON_LAYER_CONFLICT' : combined.code,
    }
  const positions = new Map(overrides.order.map((url, index) => [url, index]))
  return {
    ok: true,
    addons: combined.addons.sort(
      (a, b) => (positions.get(identity(a)) ?? Infinity) - (positions.get(identity(b)) ?? Infinity)
    ),
  }
}

/** Store only differences, so untouched addons continue to follow group updates. */
export function accountSetupChanges(group, desired) {
  const base = parseAddonConfiguration(group)
  const next = parseAddonConfiguration(desired)
  if (!base.ok) return base
  if (!next.ok) return next
  const byUrl = new Map(base.addons.map((addon) => [identity(addon), addon]))
  const nextUrls = new Set(next.addons.map(identity))
  const personal = next.addons.filter((addon) => !byUrl.has(identity(addon)))
  const addons = next.addons.filter(
    (addon) => byUrl.has(identity(addon)) && !sameAddonSetup(addon, byUrl.get(identity(addon)))
  )
  const removed = base.addons.filter((addon) => !nextUrls.has(identity(addon))).map(identity)
  const naturalOrder = [
    ...base.addons.filter((addon) => nextUrls.has(identity(addon))),
    ...personal,
  ].map(identity)
  const requestedOrder = next.addons.map(identity)
  return {
    ok: true,
    personal,
    overrides: {
      addons,
      removed,
      order: sameAddonSetup(naturalOrder, requestedOrder) ? [] : requestedOrder,
    },
  }
}
