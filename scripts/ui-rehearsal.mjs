// Isolated manual UI rehearsal. Never opens an existing DB or enables provider IO.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { buildServer } from '../server/app.js'
import { createManagedManifestService } from '../server/managed/manifests.js'
import { configuredAddon } from '../tests/fixtures/addon-config.mjs'

const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-ui-rehearsal-'))
const noProvider = async () => {
  throw new Error('Provider transport disabled in UI rehearsal')
}
let app
let closing = false
let timeout
async function close() {
  if (closing) return
  closing = true
  clearTimeout(timeout)
  try {
    if (app) await app.close()
  } finally {
    const target = path.resolve(directory)
    if (
      path.dirname(target) !== path.resolve(tmpdir()) ||
      !path.basename(target).startsWith('aiomanager-ui-rehearsal-')
    )
      throw new Error('Invalid synthetic cleanup path')
    await rm(target, { recursive: true, force: true })
    process.stdin.pause()
  }
}
try {
  const groupRehearsal = process.argv.includes('--seed-groups')
  const manifestService = createManagedManifestService({
    resolve: async (host) => {
      if (!groupRehearsal || !['addon.example.invalid', 'cinemeta.example.invalid'].includes(host))
        return noProvider()
      return [{ address: '8.8.8.8', family: 4 }]
    },
    read: async (url) => {
      if (
        !groupRehearsal ||
        !['addon.example.invalid', 'cinemeta.example.invalid'].includes(url.hostname)
      )
        return noProvider()
      if (url.pathname.includes('/offline/')) return noProvider()
      const manifest = structuredClone(configuredAddon().manifest)
      manifest.types = ['movie', 'series']
      manifest.catalogs.push({ id: 'series', type: 'series', name: 'Series catalog' })
      if (url.hostname === 'cinemeta.example.invalid') {
        manifest.id = 'com.linvo.cinemeta'
        manifest.name = 'Cinemeta'
      }
      if (url.pathname.includes('/wrong-id/')) manifest.id = 'different.addon'
      return { status: 200, headers: {}, body: Buffer.from(JSON.stringify(manifest)) }
    },
  })
  app = await buildServer({
    env: {},
    dataDir: directory,
    encryptionKey: 'synthetic-ui-key-only',
    logger: false,
    backgroundWorkers: false,
    fetch: noProvider,
    httpClient: { post: noProvider },
    manifestService,
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  let loginQuery = ''
  if (process.argv.includes('--seed-membership') || groupRehearsal) {
    const owner = randomUUID()
    const password = 'Synthetic-rehearsal-only-2026!'
    const token = createHash('sha256').update(`${password}:sync-auth-token`).digest('hex')
    const headers = { 'x-manager-id': owner, 'x-sync-password': token }
    const identity = await app.inject({
      method: 'POST',
      url: `/api/sync/${owner}`,
      headers,
      payload: { accounts: [], salt: randomBytes(16).toString('base64') },
    })
    if (identity.statusCode !== 200) throw new Error('Synthetic identity setup failed')
    const staged = await app.inject({
      method: 'POST',
      url: '/api/managed/imports',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: {
        accounts: groupRehearsal
          ? Array.from({ length: 3 }, (_, i) => ({
              email: `group-user-${i + 1}@example.invalid`,
              password: 'Synthetic-client-only!',
            }))
          : [{ email: 'membership@example.invalid', password: 'Synthetic-client-only!' }],
      },
    })
    if (staged.statusCode !== 201) throw new Error('Synthetic staging failed')
    loginQuery = `?id=${owner}`
    console.log(`Synthetic test login password: ${password}`)
  }
  console.log(`Synthetic UI rehearsal: ${address}/managed${loginQuery}`)
  console.log(
    'Fresh temporary data only; provider requests disabled. Enter stop to close and remove the synthetic data.'
  )
  timeout = setTimeout(
    () => {
      void close()
    },
    15 * 60 * 1000
  )
  process.once('SIGINT', () => {
    void close()
  })
  process.once('SIGTERM', () => {
    void close()
  })
  process.stdin.on('data', (data) => {
    if (data.toString().trim() === 'stop') void close()
  })
  process.stdin.resume()
} catch (error) {
  await close()
  throw error
}
