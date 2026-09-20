import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectManagedCollection, providerCollection } from '../server/managed/projection.js'
import { configuredAddon } from './fixtures/addon-config.mjs'
import { retryAfterMilliseconds } from '../server/managed/worker.js'

const enabled = (token, flags = {}) => ({
  ...configuredAddon(token),
  flags: { enabled: true, protected: false, ...flags },
})
const project = (overrides = {}) =>
  projectManagedCollection({
    group: [],
    personal: [],
    saved: [],
    remote: [],
    safeMode: false,
    target: 'active',
    ...overrides,
  })

test('managed projection retains exact group/personal URLs and disabled preferences without mutating inputs', () => {
  const group = [enabled('CaseSensitive'), configuredAddon('Disabled')]
  const personal = [enabled('casesensitive')]
  const original = structuredClone({ group, personal })
  const result = project({ group, personal })
  assert.deepEqual(result.configuration, [...group, ...personal])
  assert.deepEqual(
    result.expected.map((addon) => addon.transportUrl),
    [group[0].transportUrl, personal[0].transportUrl]
  )
  assert.equal(result.expected[0].manifest.name, 'Custom')
  assert.deepEqual(result.expected[0].manifest.catalogs, [])
  assert.deepEqual({ group, personal }, original)
  result.configuration[0].metadata.customName = 'changed only in result'
  assert.deepEqual({ group, personal }, original)
  assert.throws(() => project({ group, personal: [group[0]] }), { code: 'ADDON_LAYER_CONFLICT' })
})

test('safe mode anchors protected/default entries and keeps manually disabled defaults across renewal', () => {
  const retained = enabled('Default', { official: true })
  retained.metadata.customName = 'Retained default'
  const disabled = enabled('ManualDisabled', { protected: true, enabled: false })
  const group = [enabled('New'), { ...retained, metadata: { customName: 'Group edit' } }]
  const result = project({ group, saved: [retained, disabled], remote: [retained], safeMode: true })
  assert.deepEqual(
    result.configuration.map((addon) => addon.transportUrl),
    [retained.transportUrl, disabled.transportUrl, group[0].transportUrl]
  )
  assert.equal(result.expected[0].manifest.name, 'Retained default')
  assert.equal(result.expected.length, 2)
  assert.equal(result.configuration[1].flags.enabled, false)
  const unsafe = project({
    group,
    saved: [retained, disabled],
    remote: [retained],
    safeMode: false,
  })
  assert.deepEqual(unsafe.configuration, group)
  assert.equal(unsafe.expected[1].manifest.name, 'Group edit')
})

test('expiry disables everything while retaining clean descriptors, order and unseen remote defaults', () => {
  const saved = [enabled('Group'), configuredAddon('ManualDisabled')]
  const remote = [enabled('Group'), enabled('UnseenDefault', { protected: true })]
  const result = project({ target: 'suspended', saved, remote, safeMode: true })
  assert.deepEqual(result.expected, [])
  assert.deepEqual(result.configuration, [...saved, remote[1]])
  const repeated = project({ target: 'suspended', saved: result.configuration, remote: [] })
  assert.deepEqual(repeated, result)
  assert.equal(result.configuration[0].flags.enabled, true)
  assert.equal(result.configuration[1].flags.enabled, false)
})

test('repeated projection of an unflagged default does not manufacture configuration changes', () => {
  const addon = enabled('UnflaggedDefault')
  addon.manifest.id = 'com.linvo.cinemeta'
  delete addon.flags
  const first = project({ remote: [addon], safeMode: true })
  const second = project({ remote: first.expected, saved: first.configuration, safeMode: true })
  assert.deepEqual(second, first)
})

test('Cinemeta projection applies search/catalog/meta options only to the outgoing manifest', () => {
  const addon = enabled('Cinemeta')
  addon.manifest.id = 'com.linvo.cinemeta'
  addon.manifest.catalogs = [
    { id: 'cinemeta.search', type: 'movie' },
    { id: 'top', type: 'movie', extra: [{ name: 'search' }, { name: 'genre' }] },
    { id: 'year', type: 'series' },
    { id: 'imdbRating', type: 'movie' },
    { id: 'custom', type: 'movie', name: 'My catalog' },
  ]
  addon.manifest.resources = ['meta', { name: 'meta' }, { value: 'meta' }, 'stream']
  addon.catalogOverrides = { removed: [] }
  const original = structuredClone(addon)
  for (const removeSearchArtifacts of [false, true])
    for (const removeStandardCatalogs of [false, true])
      for (const removeMetaResource of [false, true]) {
        const input = {
          ...addon,
          metadata: {
            ...addon.metadata,
            cinemetaConfig: { removeSearchArtifacts, removeStandardCatalogs, removeMetaResource },
          },
        }
        const manifest = providerCollection([input])[0].manifest
        assert.equal(
          manifest.catalogs.some((catalog) => catalog.id === 'cinemeta.search'),
          !removeSearchArtifacts
        )
        assert.equal(
          manifest.catalogs.some((catalog) => catalog.id === 'year'),
          !removeStandardCatalogs
        )
        assert.equal(
          manifest.catalogs.some((catalog) => catalog.id === 'top'),
          !(removeSearchArtifacts && removeStandardCatalogs)
        )
        assert.equal(manifest.resources.length, removeMetaResource ? 1 : 4)
        assert.equal(
          manifest.catalogs.find((catalog) => catalog.id === 'custom').name,
          'My catalog'
        )
        if (!removeSearchArtifacts && removeStandardCatalogs)
          assert.equal(
            manifest.catalogs.find((catalog) => catalog.id === 'top').extra[0].isRequired,
            true
          )
      }
  assert.deepEqual(addon, original)
})

test('Retry-After accepts delta seconds or an HTTP date, and ignores invalid/past values', () => {
  const now = Date.parse('2026-09-20T12:00:00Z')
  assert.equal(retryAfterMilliseconds('60', now), 60_000)
  assert.equal(retryAfterMilliseconds('Sun, 20 Sep 2026 12:02:00 GMT', now), 120_000)
  assert.equal(retryAfterMilliseconds('Sun, 20 Sep 2026 11:59:00 GMT', now), 0)
  assert.equal(retryAfterMilliseconds('invalid', now), 0)
  assert.equal(retryAfterMilliseconds(null, now), 0)
})
