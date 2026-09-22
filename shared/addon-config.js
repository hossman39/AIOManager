import { z } from 'zod'

export const MAX_MANAGED_ADDONS = 200
export const MAX_ADDON_CONFIG_BYTES = 2 * 1024 * 1024

/** Identity only: never lowercase a configured path/query or rewrite stored URLs. */
export function addonUrlIdentity(value) {
  if (typeof value !== 'string' || value.length > 65_536 || /[\s\\]/u.test(value)) return null
  try {
    const url = new URL(value.replace(/^stremio:\/\//i, 'https://'))
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
      return null
    return url.href
  } catch {
    return null
  }
}

const text = z.string()
const catalog = z.looseObject({
  id: text.min(1),
  type: text.min(1),
  name: text.optional(),
  extra: z
    .array(
      z.looseObject({
        name: text.min(1),
        isRequired: z.boolean().optional(),
        options: z.array(text).optional(),
      })
    )
    .optional(),
})
const descriptor = z.looseObject({
  transportUrl: text.refine((value) => addonUrlIdentity(value) !== null),
  transportName: text.optional(),
  manifest: z.looseObject({
    id: text.min(1),
    name: text.min(1),
    version: text.min(1),
    description: text.optional(),
    logo: text.optional(),
    background: text.optional(),
    types: z.array(text).optional(),
    catalogs: z.array(catalog).optional(),
    resources: z.array(z.unknown()).optional(),
    idPrefixes: z.array(text).optional(),
    behaviorHints: z
      .looseObject({
        adult: z.boolean().optional(),
        p2p: z.boolean().optional(),
        configurable: z.boolean().optional(),
        configurationRequired: z.boolean().optional(),
      })
      .optional(),
  }),
  flags: z
    .looseObject({
      official: z.boolean().optional(),
      protected: z.boolean().optional(),
      enabled: z.boolean().optional(),
      disableOnExpiry: z.boolean().optional(),
    })
    .optional(),
  metadata: z
    .looseObject({
      customName: text.optional(),
      customLogo: text.optional(),
      customDescription: text.optional(),
      lastUpdated: z.number().finite().optional(),
      cinemetaConfig: z
        .looseObject({
          removeSearchArtifacts: z.boolean(),
          removeStandardCatalogs: z.boolean(),
          removeMetaResource: z.boolean(),
        })
        .optional(),
    })
    .optional(),
  catalogOverrides: z.looseObject({ removed: z.array(text) }).optional(),
  syncToLibrary: z.boolean().optional(),
})

function plainJson(value, seen = new Set(), depth = 0) {
  if (depth > 40) return false
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => plainJson(item, seen, depth + 1))
    : Object.keys(value).every(
        (key) =>
          !['__proto__', 'constructor', 'prototype'].includes(key) &&
          plainJson(value[key], seen, depth + 1)
      )
  seen.delete(value)
  return valid
}

/** Pure bounded validation, not a network safety check or manifest fetch. */
export function parseAddonConfiguration(value) {
  const failure = (code, rows = []) => ({ ok: false, code, rows })
  if (!Array.isArray(value)) return failure('INVALID_ADDON_CONFIG')
  if (value.length > MAX_MANAGED_ADDONS) return failure('ADDON_CONFIG_TOO_LARGE')
  if (!plainJson(value)) return failure('INVALID_ADDON_CONFIG')
  const serialized = JSON.stringify(value)
  if (new TextEncoder().encode(serialized).length > MAX_ADDON_CONFIG_BYTES)
    return failure('ADDON_CONFIG_TOO_LARGE')
  const invalidRows = value.flatMap((item, index) =>
    descriptor.safeParse(item).success ? [] : [index + 1]
  )
  if (invalidRows.length) return failure('INVALID_ADDON_CONFIG', invalidRows)
  const seen = new Map()
  const duplicateRows = new Set()
  value.forEach((item, index) => {
    const identity = addonUrlIdentity(item.transportUrl)
    if (seen.has(identity)) {
      duplicateRows.add(seen.get(identity))
      duplicateRows.add(index + 1)
    } else seen.set(identity, index + 1)
  })
  if (duplicateRows.size)
    return failure(
      'DUPLICATE_ADDON_URL',
      [...duplicateRows].sort((a, b) => a - b)
    )
  // Preserve extension fields exactly and break aliases with caller-owned state.
  return { ok: true, addons: JSON.parse(serialized) }
}

export function combineAddonLayers(group, personal) {
  const first = parseAddonConfiguration(group)
  if (!first.ok) return first
  const second = parseAddonConfiguration(personal)
  if (!second.ok) return second
  const combined = parseAddonConfiguration([...first.addons, ...second.addons])
  return combined.ok
    ? combined
    : {
        ...combined,
        code: combined.code === 'DUPLICATE_ADDON_URL' ? 'ADDON_LAYER_CONFLICT' : combined.code,
      }
}
