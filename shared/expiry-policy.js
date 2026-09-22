import { addonUrlIdentity } from './addon-config.js'

// Older setups continue to disable every addon until the owner publishes a choice.
export const disablesOnExpiry = (addon) => addon.flags?.disableOnExpiry !== false

export function isBrowsingAddon(addon) {
  const resources = (addon.manifest.resources ?? []).map((resource) =>
    typeof resource === 'string' ? resource : (resource?.name ?? resource?.value)
  )
  return (
    !resources.includes('stream') &&
    resources.some((name) => ['catalog', 'meta', 'subtitles'].includes(name))
  )
}

/** Group expiry choices also apply to individually customized group addons. */
export function applyGroupExpiryPolicy(addons, group) {
  const templates = new Map(group.map((addon) => [addonUrlIdentity(addon.transportUrl), addon]))
  return addons.map((addon) => {
    const template = templates.get(addonUrlIdentity(addon.transportUrl))
    if (!template || template.flags?.disableOnExpiry === addon.flags?.disableOnExpiry) return addon
    const flags = { ...addon.flags }
    if (template.flags?.disableOnExpiry === undefined) delete flags.disableOnExpiry
    else flags.disableOnExpiry = template.flags.disableOnExpiry
    return { ...addon, flags }
  })
}
