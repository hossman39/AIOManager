// Isolated manual UI rehearsal. Never opens an existing DB or enables provider IO.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/app.js'

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
  app = await buildServer({
    env: {},
    dataDir: directory,
    encryptionKey: 'synthetic-ui-key-only',
    logger: false,
    backgroundWorkers: false,
    fetch: noProvider,
    httpClient: { post: noProvider },
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  console.log(`Synthetic UI rehearsal: ${address}/managed`)
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
