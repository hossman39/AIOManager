import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addon } from './helpers'
import { applyAddonSuspension } from '../src/lib/managed/addon-suspension'
import { prepareAddonsForSync } from '../src/lib/addon-utils'
import { mergeAddons } from '../src/lib/utils'

function configuredAddons() {
  return [
    { ...addon('cinemeta'), flags: { official: true, protected: true, enabled: true } },
    {
      ...addon('personal', 'https://personal.invalid/manifest.json'),
      metadata: { customName: 'Personal testing', customLogo: 'https://logo.invalid/image.png' },
      catalogOverrides: { removed: ['series'] },
    },
    {
      ...addon('manual-disabled', 'https://disabled.invalid/manifest.json'),
      flags: { enabled: false },
    },
  ]
}

test('expiry suspension disables every entry, including protected/default and personal addons', () => {
  const configured = configuredAddons()
  const before = structuredClone(configured)
  const effective = applyAddonSuspension(configured, true)
  assert.equal(effective.length, configured.length)
  effective.forEach((entry, index) => {
    assert.deepEqual(entry, { ...before[index], flags: { ...before[index].flags, enabled: false } })
  })
  assert.deepEqual(configured, before)
  assert.deepEqual(prepareAddonsForSync(effective), [])
})

test('upstream refresh merge retains disabled entries when absent from remote active collection', () => {
  const suspended = applyAddonSuspension(configuredAddons(), true)
  const refreshed = mergeAddons(suspended, [])
  assert.deepEqual(refreshed, suspended)
  assert.deepEqual(prepareAddonsForSync(refreshed), [])
})

test('renewal lifts suspension but does not re-enable manually disabled addons', () => {
  const configured = configuredAddons()
  applyAddonSuspension(configured, true)
  const renewed = applyAddonSuspension(configured, false)
  assert.deepEqual(renewed, configured)
  assert.deepEqual(
    prepareAddonsForSync(renewed).map((entry) => entry.manifest.id),
    ['cinemeta', 'personal']
  )
  assert.equal(renewed[2].flags?.enabled, false)
})

test('repeated expiry/renewal and serialized restart do not discard preferences or configuration', () => {
  const configured = configuredAddons()
  let retained = structuredClone(configured)
  for (let i = 0; i < 20; i++) {
    const suspended = applyAddonSuspension(retained, true)
    assert.equal(suspended.length, configured.length)
    // The durable worker must save configured state separately from the projection.
    retained = JSON.parse(JSON.stringify(retained))
    assert.deepEqual(applyAddonSuspension(retained, false), configured)
  }
})

test('edits during suspension remain ineffective until renewal and retain their enabled choices', () => {
  const configured = configuredAddons()
  configured.push({
    ...addon('new-group-entry', 'https://new.invalid/manifest.json'),
    flags: { enabled: true },
  })
  configured[0].flags = { ...configured[0].flags, enabled: false }
  assert.deepEqual(prepareAddonsForSync(applyAddonSuspension(configured, true)), [])
  const renewed = prepareAddonsForSync(applyAddonSuspension(configured, false))
  assert.deepEqual(
    renewed.map((entry) => entry.manifest.id),
    ['personal', 'new-group-entry']
  )
})

test('effective state cannot mutate nested saved configuration through aliasing', () => {
  const configured = configuredAddons()
  const before = structuredClone(configured)
  const effective = applyAddonSuspension(configured, true)
  effective[0].manifest.name = 'Changed projection'
  effective[1].catalogOverrides!.removed.push('movies')
  effective[1].metadata!.customName = 'Changed projection'
  assert.deepEqual(configured, before)
})

test('empty configured collection remains empty without manufacturing entries', () => {
  assert.deepEqual(applyAddonSuspension([], true), [])
  assert.deepEqual(applyAddonSuspension([], false), [])
})
