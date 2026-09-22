import http from 'node:http'
import https from 'node:https'
import { afterEach, beforeEach, mock } from 'node:test'
import type { AddonDescriptor } from '../src/types/addon'

// Fail closed if a unit test accidentally reaches a live service.
beforeEach(() => {
  const rejectNetwork = () => {
    throw new Error('Live network is disabled in unit tests')
  }
  mock.method(globalThis, 'fetch', rejectNetwork)
  mock.method(http, 'request', rejectNetwork)
  mock.method(https, 'request', rejectNetwork)
})
afterEach(() => mock.restoreAll())

export function addon(
  id = 'example.addon',
  url = 'https://addons.invalid/Config-A/manifest.json?token=CaseSensitive'
): AddonDescriptor {
  return {
    transportUrl: url,
    manifest: {
      id,
      name: 'Example addon',
      version: '1.0.0',
      description: 'Synthetic fixture',
      types: ['movie', 'series'],
      resources: ['catalog', 'meta', 'stream'],
      catalogs: [
        { id: 'movies', type: 'movie' },
        { id: 'series', type: 'series' },
      ],
    },
  }
}
