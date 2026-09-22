import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkedAddonDraft,
  newDraftAddon,
  moveDraftItem,
  removeDraftAddon,
  editAddonMetadata,
  setCatalogHidden,
  renameDraftCatalog,
  editCinemetaOption,
  replaceDraftUrl,
  resetDraftCatalogs,
} from '../src/lib/managed/addon-draft'
import type { ManagedAddon } from '../shared/addon-config.js'
import './helpers'

function fixture(): ManagedAddon {
  return {
    transportUrl: 'https://addon.invalid/CaSeToken/manifest.json?b=2&a=1',
    manifest: {
      id: 'cinemeta',
      name: 'Cinemeta',
      version: '1.0.0',
      description: 'Original',
      catalogs: [
        {
          id: 'popular',
          type: 'movie',
          name: 'Movies',
          extra: [{ name: 'search', extension: true }],
        },
        { id: 'popular', type: 'series', name: 'Series' },
        { id: 'last', type: 'movie' },
      ],
      resources: ['catalog', 'meta'],
      extension: { retain: ['Case'] },
    },
    flags: { enabled: false, protected: true, extension: 'keep' },
    metadata: { customName: 'My name', extension: 'keep' },
    catalogOverrides: { removed: ['other'], extension: 'keep' },
    extension: { nested: 'keep' },
  }
}

test('new draft addons preserve URL bytes, keep different configurations distinct and protect Cinemeta', () => {
  const first = fixture()
  const created = newDraftAddon(first.transportUrl, first.manifest)
  assert.equal(created.transportUrl, first.transportUrl)
  assert.deepEqual(created.flags, { enabled: true, protected: true })
  created.manifest.name = 'Changed'
  assert.equal(first.manifest.name, 'Cinemeta')
  const second = newDraftAddon(
    'https://addon.invalid/caseToken/manifest.json?b=2&a=1',
    first.manifest
  )
  assert.equal(checkedAddonDraft([first, second]).length, 2)
  assert.throws(() => checkedAddonDraft([first, first]), { code: 'DUPLICATE_ADDON_URL' })
})

test('draft metadata edits preserve extensions and clear keys without undefined values', () => {
  const first = fixture()
  const before = structuredClone(first)
  const renamed = editAddonMetadata(first, 'customName', '  My exact title  ')
  assert.equal(renamed.metadata?.customName, '  My exact title  ')
  const cleared = editAddonMetadata(renamed, 'customName', '')
  assert.ok(!Object.prototype.hasOwnProperty.call(cleared.metadata, 'customName'))
  assert.equal(cleared.metadata?.extension, 'keep')
  assert.deepEqual(checkedAddonDraft([cleared])[0], cleared)
  assert.deepEqual(first, before)
})

test('catalog visibility and naming retain complete descriptors and source ID-based hide behavior', () => {
  const first = fixture()
  const before = structuredClone(first)
  const renamed = renameDraftCatalog(first, 0, 'My catalog')
  assert.equal(renamed.manifest.catalogs?.[0].name, 'My catalog')
  assert.deepEqual(renamed.manifest.catalogs?.[0].extra, first.manifest.catalogs?.[0].extra)
  const hidden = setCatalogHidden(renamed, 'popular', true)
  assert.deepEqual(hidden.catalogOverrides?.removed, ['other', 'popular'])
  assert.equal(hidden.manifest.catalogs?.length, 3)
  assert.equal(
    hidden.manifest.catalogs?.filter(
      (catalog) => !hidden.catalogOverrides?.removed.includes(catalog.id)
    ).length,
    1
  )
  assert.deepEqual(
    setCatalogHidden(hidden, 'popular', false).manifest.catalogs,
    renamed.manifest.catalogs
  )
  assert.deepEqual(first, before)
})

test('reordering and protected removal are explicit and leave source arrays untouched', () => {
  const first = fixture()
  const second = {
    ...fixture(),
    transportUrl: 'https://addon.invalid/second',
    flags: { protected: false },
  }
  const entries = [first, second]
  assert.deepEqual(moveDraftItem(entries, 1, 0), [second, first])
  assert.deepEqual(moveDraftItem(entries, 0, -1), entries)
  assert.deepEqual(moveDraftItem(entries, 9, 0), entries)
  assert.throws(() => removeDraftAddon(entries, 0), { code: 'PROTECTED_ADDON' })
  assert.deepEqual(removeDraftAddon(entries, 1), [first])
  assert.deepEqual(entries, [first, second])
})

test('all Cinemeta options are reversible intent without mutating the saved base manifest', () => {
  const first = fixture()
  const before = structuredClone(first)
  let next = first
  for (const key of [
    'removeSearchArtifacts',
    'removeStandardCatalogs',
    'removeMetaResource',
  ] as const)
    next = editCinemetaOption(next, key, true)
  assert.deepEqual(next.metadata?.cinemetaConfig, {
    removeSearchArtifacts: true,
    removeStandardCatalogs: true,
    removeMetaResource: true,
  })
  assert.deepEqual(next.manifest, before.manifest)
  assert.equal(next.flags?.enabled, false)
  next = editCinemetaOption(next, 'removeStandardCatalogs', false)
  assert.equal(next.metadata?.cinemetaConfig?.removeStandardCatalogs, false)
  assert.equal(next.metadata?.cinemetaConfig?.removeSearchArtifacts, true)
  assert.deepEqual(first, before)
})

test('URL replacement retains custom catalogs and flags; catalog reset changes only catalog settings', () => {
  const first = fixture()
  const before = structuredClone(first)
  const fresh = {
    ...first.manifest,
    name: 'New remote title',
    catalogs: [{ id: 'fresh', type: 'movie' }],
    resources: ['stream'],
  }
  const replaced = replaceDraftUrl(first, 'https://addon.invalid/NewToken/manifest.json', fresh)
  assert.deepEqual(replaced.manifest, first.manifest)
  assert.deepEqual(replaced.metadata, first.metadata)
  assert.deepEqual(replaced.flags, first.flags)
  const reset = resetDraftCatalogs(replaced, fresh)
  assert.deepEqual(reset.manifest.catalogs, fresh.catalogs)
  assert.deepEqual(reset.manifest.resources, first.manifest.resources)
  assert.deepEqual(reset.catalogOverrides, { removed: [], extension: 'keep' })
  assert.equal(reset.flags?.enabled, false)
  assert.deepEqual(first, before)
  assert.throws(() => replaceDraftUrl(first, replaced.transportUrl, { ...fresh, id: 'other' }), {
    code: 'MANIFEST_ID_MISMATCH',
  })
  assert.throws(() => resetDraftCatalogs(first, { ...fresh, id: 'other' }), {
    code: 'MANIFEST_ID_MISMATCH',
  })
})
