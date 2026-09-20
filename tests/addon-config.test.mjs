import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  addonUrlIdentity,
  parseAddonConfiguration,
  combineAddonLayers,
  MAX_MANAGED_ADDONS,
  MAX_ADDON_CONFIG_BYTES,
} from '../shared/addon-config.js'

import { configuredAddon } from './fixtures/addon-config.mjs'

test('managed addon validation retains descriptors, customization, order, extensions and enabled flags', () => {
  const input = [configuredAddon(), configuredAddon('PersonalToken')]
  const result = parseAddonConfiguration(input)
  assert.equal(result.ok, true)
  assert.deepEqual(result.addons, input)
  result.addons[0].manifest.extension.nested.push('changed')
  assert.deepEqual(input[0].manifest.extension.nested, ['preserved'])
})

test('URL identity preserves case-sensitive paths, tokens, query values and parameter order', () => {
  assert.equal(
    addonUrlIdentity('https://EXAMPLE.invalid:443/Token/manifest.json?q=ABC'),
    'https://example.invalid/Token/manifest.json?q=ABC'
  )
  assert.notEqual(
    addonUrlIdentity('https://example.invalid/Token/manifest.json'),
    addonUrlIdentity('https://example.invalid/token/manifest.json')
  )
  assert.notEqual(
    addonUrlIdentity('https://example.invalid/?token=ABC'),
    addonUrlIdentity('https://example.invalid/?token=abc')
  )
  assert.notEqual(
    addonUrlIdentity('https://example.invalid/?a=1&b=2'),
    addonUrlIdentity('https://example.invalid/?b=2&a=1')
  )
  assert.equal(
    addonUrlIdentity('stremio://example.invalid/Token/manifest.json'),
    addonUrlIdentity('https://example.invalid/Token/manifest.json')
  )
})

test('same manifest ID supports different configured instances while duplicate URLs are rejected', () => {
  assert.equal(
    parseAddonConfiguration([configuredAddon('Token'), configuredAddon('token')]).ok,
    true
  )
  assert.deepEqual(parseAddonConfiguration([configuredAddon(), configuredAddon()]), {
    ok: false,
    code: 'DUPLICATE_ADDON_URL',
    rows: [1, 2],
  })
  assert.equal(
    combineAddonLayers([configuredAddon()], [configuredAddon()]).code,
    'ADDON_LAYER_CONFLICT'
  )
  const group = configuredAddon('Group')
  const personal = configuredAddon('Personal')
  assert.deepEqual(combineAddonLayers([group], [personal]).addons, [group, personal])
})

test('invalid JSON, flags, catalogs, URLs and missing manifests never become empty configuration', () => {
  const cyclic = configuredAddon()
  cyclic.metadata.loop = cyclic
  for (const input of [
    null,
    {},
    [null],
    [{}],
    [{ transportUrl: 'https://example.invalid/manifest.json' }],
    [{ ...configuredAddon(), flags: { enabled: 'false' } }],
    [{ ...configuredAddon(), manifest: null }],
    [{ ...configuredAddon(), catalogOverrides: { removed: [null] } }],
    [cyclic],
    [{ ...configuredAddon(), metadata: { date: new Date() } }],
    [{ ...configuredAddon(), metadata: { number: Infinity } }],
    [{ ...configuredAddon(), metadata: JSON.parse('{"__proto__":{"polluted":true}}') }],
  ])
    assert.equal(parseAddonConfiguration(input).ok, false)
  for (const transportUrl of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'https://user:password@example.invalid/',
    'https://example.invalid/#token',
    'https://example.invalid/ token',
    'https://example.invalid/\\token',
  ]) {
    const result = parseAddonConfiguration([{ ...configuredAddon(), transportUrl }])
    assert.equal(result.ok, false)
    assert.ok(!JSON.stringify(result).includes(transportUrl))
  }
  assert.deepEqual(parseAddonConfiguration([]), { ok: true, addons: [] })
})

test('managed addon validation bounds item counts, UTF-8 size and nesting depth', () => {
  assert.equal(
    parseAddonConfiguration(
      Array.from({ length: MAX_MANAGED_ADDONS + 1 }, (_, i) => configuredAddon(String(i)))
    ).code,
    'ADDON_CONFIG_TOO_LARGE'
  )
  assert.equal(
    parseAddonConfiguration([
      { ...configuredAddon(), note: '🔑'.repeat(MAX_ADDON_CONFIG_BYTES / 4) },
    ]).code,
    'ADDON_CONFIG_TOO_LARGE'
  )
  let nested = 'bottom'
  for (let i = 0; i < 42; i++) nested = { nested }
  assert.equal(
    parseAddonConfiguration([{ ...configuredAddon(), nested }]).code,
    'INVALID_ADDON_CONFIG'
  )
})
