import { nuvioLifecycle } from './nuvio-managed-contract.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NuvioConnect } from '../src/components/managed/NuvioConnect.tsx'
import { AccountProviderPicker } from '../src/components/accounts/AccountProviderPicker.tsx'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { createNuvioProvider } from '../server/managed/nuvio.js'
import { historyCandidates, readHistory } from '../server/managed/nuvio-history.js'

test('the add-account dialog offers both providers and Nuvio exposes credentials and both actions directly', () => {
  const picker = renderToStaticMarkup(createElement(AccountProviderPicker, { onSelect() {} }))
  assert.match(picker, />Stremio</)
  assert.match(picker, />Nuvio</)
  assert.equal((picker.match(/type="button"/g) ?? []).length, 2)
  const form = renderToStaticMarkup(
    createElement(NuvioConnect, { api: {}, onConnected() {}, onBack() {} })
  )
  assert.match(form, /Connect existing/)
  assert.match(form, /Create new/)
  assert.match(form, /type="email"/)
  assert.match(form, /type="password"/)
  assert.doesNotMatch(form, /<select/)
})

test('signup without a session prompts for email confirmation', async () => {
  const provider = createNuvioProvider({
    fetch: async () => Response.json({ user: { id: randomUUID() } }),
  })
  await assert.rejects(
    provider.register({ email: 'pending@example.invalid', password: 'fixture-only' }),
    { code: 'NUVIO_CONFIRM_EMAIL' }
  )
})

test('SQLite Nuvio enrollment, membership migration, scheduled expiry, renewal and watch history', () =>
  nuvioLifecycle())

test('Stremio episode flags retain their anchor when episodes are added; incomplete metadata is reported', async () => {
  const id = 'tt123'
  const videos = [0, 1, 2, 3].map((n) => ({ id: id + ':1:' + n, season: 1, episode: n }))
  const watched = id + ':1:3:3:' + deflateSync(Buffer.from([0b101])).toString('base64')
  const item = {
    _id: id,
    type: 'series',
    name: 'Test show',
    state: {
      watched,
      lastWatched: '2026-01-01',
      video_id: id + ':1:2',
      timeOffset: 70000,
      duration: 1800000,
    },
  }
  const ok = await historyCandidates([item], { episodes: async () => videos })
  assert.deepEqual(
    ok.watched.map((r) => r.episode),
    [1, 3]
  )
  assert.equal(ok.progress[0].episode, 2)
  assert.deepEqual((await historyCandidates([item], { episodes: async () => [] })).skipped, [
    'Test show',
  ])
})

test('complete destination snapshot includes progress beyond the default 200-row window', async () => {
  const rows = Array.from({ length: 506 }, (_, i) => ({
    content_type: 'movie',
    content_id: 'tt' + i,
    last_watched: 1711000000000,
  }))
  const offsets = []
  const result = await readHistory(
    {
      rpc: async () => [],
      progressPage: async (_token, _id, offset, limit) => {
        offsets.push(offset)
        return rows.slice(offset, offset + limit)
      },
    },
    'synthetic',
    1
  )
  assert.equal(result.progress.length, 506)
  assert.deepEqual(offsets, [0, 250, 500])
})
