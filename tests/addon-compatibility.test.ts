import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addon } from './helpers'
import { getEffectiveManifest, prepareAddonsForSync } from '../src/lib/addon-utils'
import { mergeAddons, removeAddons } from '../src/lib/addon-merger'
import { mergeAddons as mergeRemoteState } from '../src/lib/utils'
import { applyCinemetaConfiguration } from '../src/lib/cinemeta-utils'
import { updateAddons } from '../src/api/addons'
import { stremioClient } from '../src/api/stremio-client'
import type { SavedAddon } from '../src/types/saved-addon'
import type { CinemetaManifest } from '../src/types/cinemeta'

test('custom name, description, logo and catalog exclusions survive sync preparation', () => {
  const entry = {
    ...addon(),
    metadata: {
      customName: 'My name',
      customDescription: 'My description',
      customLogo: 'https://logo.invalid/a.png',
    },
    catalogOverrides: { removed: ['movies'] },
  }
  const before = structuredClone(entry)
  const manifest = getEffectiveManifest(entry)
  assert.equal(manifest.name, entry.metadata.customName)
  assert.equal(manifest.description, entry.metadata.customDescription)
  assert.equal(manifest.logo, entry.metadata.customLogo)
  assert.deepEqual(
    manifest.catalogs?.map((catalog) => catalog.id),
    ['series']
  )
  assert.deepEqual(entry, before)
})

test('disabled addons are excluded from payload without being deleted from saved data', () => {
  const first = addon('first')
  const disabled = { ...addon('disabled'), flags: { enabled: false } }
  const last = addon('last')
  const configured = [first, disabled, last]
  const before = structuredClone(configured)
  assert.deepEqual(
    prepareAddonsForSync(configured).map((entry) => entry.manifest.id),
    ['first', 'last']
  )
  assert.deepEqual(configured, before)
})

test('existing update API sends enabled customized entries while retaining caller configuration', async (t) => {
  const first = { ...addon(), metadata: { customName: 'Customized' } }
  const disabled = { ...addon('disabled'), flags: { enabled: false } }
  const configured = [first, disabled]
  const before = structuredClone(configured)
  const setCollection = t.mock.method(stremioClient, 'setAddonCollection', async () => {})
  await updateAddons('synthetic-auth-key', configured, 'synthetic-account')
  assert.equal(setCollection.mock.callCount(), 1)
  assert.deepEqual(setCollection.mock.calls[0].arguments, [
    'synthetic-auth-key',
    prepareAddonsForSync(configured),
    'synthetic-account',
  ])
  assert.deepEqual(configured, before)
})

test('existing update API sends an empty active collection when all saved addons are disabled', async (t) => {
  const configured = [{ ...addon(), flags: { enabled: false, protected: true, official: true } }]
  const setCollection = t.mock.method(stremioClient, 'setAddonCollection', async () => {})
  await updateAddons('synthetic-auth-key', configured)
  assert.deepEqual(setCollection.mock.calls[0].arguments[1], [])
  assert.equal(configured.length, 1)
})

test('protected addons survive removal unless the caller explicitly allows it', () => {
  const protectedEntry = { ...addon('protected'), flags: { protected: true } }
  const ordinary = addon('ordinary', 'https://ordinary.invalid/manifest.json')
  const configured = [protectedEntry, ordinary]
  const result = removeAddons(configured, ['protected', 'ordinary'])
  assert.deepEqual(result.addons, [protectedEntry])
  assert.deepEqual(result.protectedAddons, ['protected'])
  assert.deepEqual(removeAddons(configured, ['protected', 'ordinary'], true).addons, [])
  assert.equal(configured.length, 2)
})

test('URL-targeted removal preserves a different configured instance with the same manifest ID', () => {
  const first = addon()
  const second = addon(first.manifest.id, 'https://addons.invalid/different-config/manifest.json')
  assert.deepEqual(removeAddons([first, second], [first.transportUrl]).addons, [second])
})

test('saved-addon merge preserves protected metadata unless protection is explicitly overridden', async () => {
  const existing = { ...addon(), flags: { protected: true } }
  const saved: SavedAddon = {
    id: 'saved',
    name: 'Customized',
    manifest: existing.manifest,
    installUrl: existing.transportUrl,
    tags: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    sourceType: 'manual',
  }
  const safe = await mergeAddons([existing], [saved])
  assert.deepEqual(safe.addons, [existing])
  assert.equal(safe.result.protected.length, 1)
  const unsafe = await mergeAddons([existing], [saved], 'synthetic-account', true)
  assert.equal(unsafe.addons[0].metadata?.customName, 'Customized')
})

test('remote merge keeps configured URL path/query case and distinct instances', () => {
  const first = addon('same-id', 'https://addons.invalid/Config/manifest.json?key=Upper')
  const second = addon('same-id', 'https://addons.invalid/config/manifest.json?key=upper')
  const result = mergeRemoteState([first, second], [first, second])
  assert.deepEqual(
    result.map((entry) => entry.transportUrl),
    [first.transportUrl, second.transportUrl]
  )
})

test('ordinary client removal stays removed during refresh when no local protection applies', () => {
  assert.deepEqual(mergeRemoteState([addon()], []), [])
})

const cinemeta: CinemetaManifest = {
  ...addon('com.linvo.cinemeta').manifest,
  resources: ['catalog', 'meta'],
  catalogs: ['movie', 'series'].flatMap((type) => [
    { id: 'top', type, extra: [{ name: 'search' }, { name: 'skip' }] },
    { id: 'year', type },
    { id: 'imdbRating', type },
    { id: 'cinemeta.search', type, extra: [{ name: 'search' }] },
  ]),
}

test('Cinemeta catalog customization can preserve search while hiding default catalogs', () => {
  const before = structuredClone(cinemeta)
  const result = applyCinemetaConfiguration(cinemeta, {
    removeSearchArtifacts: false,
    removeStandardCatalogs: true,
    removeMetaResource: false,
  })
  assert.ok(!result.catalogs.some((catalog) => ['year', 'imdbRating'].includes(catalog.id)))
  assert.equal(result.catalogs.filter((catalog) => catalog.id === 'cinemeta.search').length, 2)
  for (const catalog of result.catalogs.filter((catalog) => catalog.id === 'top')) {
    assert.equal(catalog.extra?.find((extra) => extra.name === 'search')?.isRequired, true)
  }
  assert.deepEqual(cinemeta, before)
})

test('Cinemeta search, catalog and metadata removal options remain independently usable', () => {
  const result = applyCinemetaConfiguration(cinemeta, {
    removeSearchArtifacts: true,
    removeStandardCatalogs: true,
    removeMetaResource: true,
  })
  assert.deepEqual(result.catalogs, [])
  assert.deepEqual(result.resources, ['catalog'])
  const unchanged = applyCinemetaConfiguration(cinemeta, {
    removeSearchArtifacts: false,
    removeStandardCatalogs: false,
    removeMetaResource: false,
  })
  assert.deepEqual(unchanged, cinemeta)
})
