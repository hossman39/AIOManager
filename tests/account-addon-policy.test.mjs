import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  accountSetupChanges,
  applyAccountOverrides,
  emptyAccountOverrides,
  parseAccountOverrides,
} from '../shared/account-addons.js'
import { projectManagedCollection } from '../server/managed/projection.js'
import { configuredAddon } from './fixtures/addon-config.mjs'

const addon = (name) => ({
  ...configuredAddon(),
  transportUrl: 'https://example.invalid/' + name + '/manifest.json',
  manifest: { ...configuredAddon().manifest, name },
})

test('individual edits round-trip names, catalogs, enabled preferences, removals and custom order', () => {
  const group = [addon('first'), addon('second'), addon('third')]
  const changed = {
    ...group[0],
    flags: { enabled: false, protected: true },
    metadata: { customName: 'Only me' },
    catalogOverrides: { removed: ['movies'] },
  }
  const desired = [addon('personal'), group[2], changed]
  const change = accountSetupChanges(group, desired)
  assert.equal(change.ok, true)
  assert.deepEqual(applyAccountOverrides(group, change.personal, change.overrides), {
    ok: true,
    addons: desired,
  })
  assert.equal(group[0].metadata.customName, configuredAddon().metadata.customName)
  assert.deepEqual(change.overrides.removed, [group[1].transportUrl])
})

test('untouched group addons follow later changes while an individual override stays isolated', () => {
  const group = [addon('first'), addon('second')]
  const own = { ...group[0], metadata: { customName: 'My name' } }
  const change = accountSetupChanges(group, [own, group[1]])
  assert.deepEqual(change.overrides.order, [])
  const published = [
    { ...group[1], metadata: { customName: 'New shared name' } },
    group[0],
    addon('new'),
  ]
  assert.deepEqual(applyAccountOverrides(published, change.personal, change.overrides).addons, [
    published[0],
    own,
    published[2],
  ])
  assert.deepEqual(applyAccountOverrides(published, [], emptyAccountOverrides()).addons, published)
})

test('a later group URL cannot overwrite an existing account-only addon or create duplicates', () => {
  const own = addon('personal')
  const shared = { ...own, metadata: { customName: 'Shared version' } }
  assert.deepEqual(applyAccountOverrides([shared], [own]).addons, [own])
})

test('explicit individual edits work on protected addons, and expiry still disables every addon', () => {
  const original = { ...addon('protected'), flags: { enabled: true, protected: true } }
  const custom = { ...original, metadata: { customName: 'Personal name' } }
  const policy = {
    group: [],
    personal: [custom],
    saved: [original],
    remote: [original],
    safeMode: true,
    individual: true,
    accountOverrides: emptyAccountOverrides(),
  }
  const active = projectManagedCollection({ ...policy, target: 'active' })
  assert.equal(active.expected[0].manifest.name, 'Personal name')
  const expired = projectManagedCollection({
    ...policy,
    saved: active.configuration,
    target: 'suspended',
  })
  assert.deepEqual(expired.expected, [])
  assert.deepEqual(expired.configuration, active.configuration)
  assert.deepEqual(
    projectManagedCollection({ ...policy, personal: [], target: 'active' }).expected,
    []
  )
})

test('malformed, duplicated and ambiguous override payloads are rejected', () => {
  assert.equal(parseAccountOverrides({ addons: [], removed: ['not-a-url'], order: [] }).ok, false)
  assert.equal(
    parseAccountOverrides({ addons: [addon('x')], removed: [addon('x').transportUrl], order: [] })
      .ok,
    false
  )
  assert.equal(
    parseAccountOverrides({
      addons: [],
      removed: [],
      order: ['https://x.invalid', 'https://x.invalid/'],
    }).ok,
    false
  )
  assert.equal(
    parseAccountOverrides({ addons: [], removed: [], order: [], secret: 'invalid' }).ok,
    false
  )
})

test('explicit account order includes protected addons even with safe mode enabled', () => {
  const protectedAddon = { ...addon('protected'), flags: { enabled: true, protected: true } }
  const ordinary = { ...addon('ordinary'), flags: { enabled: true, protected: false } }
  const desired = [ordinary, protectedAddon]
  const remote = [protectedAddon, ordinary]
  for (const individual of [true, false]) {
    const changes = accountSetupChanges(individual ? [] : remote, desired)
    const result = projectManagedCollection({
      group: individual ? [] : remote,
      personal: changes.personal,
      accountOverrides: changes.overrides,
      saved: remote,
      remote,
      individual,
      safeMode: true,
      target: 'active',
    })
    assert.deepEqual(result.configuration, desired)
  }
})
