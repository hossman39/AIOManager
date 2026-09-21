import {
  addonUrlIdentity,
  combineAddonLayers,
  parseAddonConfiguration,
} from '../../shared/addon-config.js'
import { ManagedError } from './errors.js'
import { applyAccountOverrides } from '../../shared/account-addons.js'

export function checkedCollection(value) {
  const result = parseAddonConfiguration(value)
  if (!result.ok) throw new ManagedError('DATA_UNREADABLE')
  return result.addons
}

const identity = (addon) => addonUrlIdentity(addon.transportUrl)
const protectedAddon = (addon) =>
  addon.flags?.protected === true ||
  addon.flags?.official === true ||
  ['com.linvo.cinemeta', 'org.stremio.cinemeta', 'cinemeta'].includes(addon.manifest.id)

// Saved descriptors remain untouched. Only the outgoing manifest is transformed.
export function providerCollection(configuration) {
  return checkedCollection(configuration)
    .filter((addon) => addon.flags?.enabled !== false)
    .map((addon) => {
      const manifest = {
        ...addon.manifest,
        types: addon.manifest.types ?? [],
        resources: addon.manifest.resources ?? [],
      }
      const metadata = addon.metadata
      if (metadata?.customName) manifest.name = metadata.customName
      if (metadata?.customLogo) manifest.logo = metadata.customLogo
      if (metadata?.customDescription) manifest.description = metadata.customDescription
      const config = metadata?.cinemetaConfig
      if (config?.removeSearchArtifacts && manifest.catalogs) {
        manifest.catalogs = manifest.catalogs
          .filter((catalog) => catalog.id !== 'cinemeta.search')
          .map((catalog) => ({
            ...catalog,
            ...(catalog.extra
              ? { extra: catalog.extra.filter((extra) => extra.name !== 'search') }
              : {}),
          }))
      }
      if (config?.removeStandardCatalogs && manifest.catalogs) {
        manifest.catalogs = config.removeSearchArtifacts
          ? manifest.catalogs.filter(
              (catalog) => !['top', 'year', 'imdbRating'].some((id) => catalog.id.includes(id))
            )
          : manifest.catalogs
              .filter((catalog) => !['year', 'imdbRating'].some((id) => catalog.id.includes(id)))
              .map((catalog) => ({
                ...catalog,
                ...(catalog.id.includes('top') && catalog.extra
                  ? {
                      extra: catalog.extra.map((extra) =>
                        extra.name === 'search' ? { ...extra, isRequired: true } : extra
                      ),
                    }
                  : {}),
              }))
      }
      if (config?.removeMetaResource) {
        manifest.resources = manifest.resources.filter(
          (resource) =>
            resource !== 'meta' &&
            !(
              resource &&
              typeof resource === 'object' &&
              (resource.name === 'meta' || resource.value === 'meta')
            )
        )
      }
      if (addon.catalogOverrides?.removed && manifest.catalogs) {
        const removed = new Set(addon.catalogOverrides.removed)
        manifest.catalogs = manifest.catalogs.filter((catalog) => !removed.has(catalog.id))
      }
      return { ...addon, manifest }
    })
}

export function projectManagedCollection({
  group,
  personal,
  saved,
  remote,
  safeMode,
  target,
  accountOverrides,
  individual = false,
}) {
  const retained = checkedCollection(saved)
  const observed = checkedCollection(remote)
  const savedByUrl = new Map(retained.map((addon) => [identity(addon), addon]))
  if (target === 'suspended' || target === 'offboard') {
    // Capture previously unseen remote defaults before disabling them, without
    // replacing saved preferences with either an empty list or a disabled copy.
    const configuration = checkedCollection([
      ...retained,
      ...observed.filter((addon) => !savedByUrl.has(identity(addon))),
    ])
    return { configuration, expected: [] }
  }
  if (target !== 'active' || typeof safeMode !== 'boolean') throw new ManagedError('INVALID_STATE')
  const combined = accountOverrides
    ? applyAccountOverrides(group, personal, accountOverrides)
    : combineAddonLayers(group, personal)
  if (!combined.ok) throw new ManagedError(combined.code)
  let configuration = combined.addons
  if (safeMode && !individual) {
    // Fresh remote order anchors protected/default entries. A saved descriptor
    // keeps its clean manifest and disabled preference across expiry and retries.
    const baseline = observed.map((addon) => {
      const stored = savedByUrl.get(identity(addon))
      if (!stored) return addon
      const protectedFlag = addon.flags?.protected === true && stored.flags?.protected !== true
      const officialFlag = addon.flags?.official === true && stored.flags?.official !== true
      return protectedFlag || officialFlag
        ? {
            ...stored,
            flags: {
              ...stored.flags,
              ...(protectedFlag ? { protected: true } : {}),
              ...(officialFlag ? { official: true } : {}),
            },
          }
        : stored
    })
    const remoteUrls = new Set(observed.map(identity))
    baseline.push(...retained.filter((addon) => !remoteUrls.has(identity(addon))))
    const desiredByUrl = new Map(configuration.map((addon) => [identity(addon), addon]))
    const removed = new Set(accountOverrides?.removed ?? [])
    const edited = new Set(
      [...(accountOverrides?.addons ?? []), ...(accountOverrides ? personal : [])].map(identity)
    )
    const anchors = baseline.flatMap((addon, index) =>
      protectedAddon(addon) &&
      !removed.has(identity(addon)) &&
      (!individual || desiredByUrl.has(identity(addon)))
        ? [{ addon, index }]
        : []
    )
    const protectedUrls = new Set(anchors.map(({ addon }) => identity(addon)))
    configuration = configuration.filter((addon) => !protectedUrls.has(identity(addon)))
    for (const { addon, index } of anchors) {
      const desired = desiredByUrl.get(identity(addon))
      // Enabling/disabling remains editable even when metadata is protected.
      const kept =
        desired && (individual || edited.has(identity(addon)))
          ? desired
          : desired?.flags?.enabled === undefined
            ? addon
            : {
                ...addon,
                flags: { ...addon.flags, enabled: desired.flags.enabled },
              }
      configuration.splice(Math.min(index, configuration.length), 0, kept)
    }
  }
  // A deliberate per-account reorder also applies to protected entries. Safety
  // preserves descriptors; it must not silently undo the owner's chosen order.
  if (accountOverrides?.order.length) {
    const positions = new Map(accountOverrides.order.map((url, index) => [url, index]))
    configuration.sort(
      (a, b) => (positions.get(identity(a)) ?? Infinity) - (positions.get(identity(b)) ?? Infinity)
    )
  }
  configuration = checkedCollection(configuration)
  return { configuration, expected: providerCollection(configuration) }
}
