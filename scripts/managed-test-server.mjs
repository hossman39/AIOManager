// Dedicated local test instance. Never reads the existing app's database or key configuration.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../server/app.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nuvioPilot = process.argv.includes('--nuvio-pilot')
const port = nuvioPilot ? 1612 : 1611
const directory = path.join(root, 'data', nuvioPilot ? 'nuvio-pilot' : 'managed-test')
const env = {
  ...process.env,
  DB_TYPE: 'sqlite',
  DATABASE_URL: '',
  ENCRYPTION_KEY: '',
  DATA_DIR: directory,
  MANAGED_BACKUP_DIR: path.join(directory, 'backups'),
  MANAGED_WRITES_ENABLED: 'true',
  MANAGED_BACKUPS_ENABLED: 'true',
  MANAGED_MANIFEST_PRIVATE_ORIGINS: '',
  LOG_LEVEL: 'warn',
  LOG_PRETTY_PRINT: 'false',
}
const app = await buildServer({ env, dataDir: directory, backgroundWorkers: true })
let closing = false
const close = async () => {
  if (!closing) {
    closing = true
    await app.close()
  }
}
process.once('SIGINT', () => {
  void close()
})
process.once('SIGTERM', () => {
  void close()
})
try {
  const address = await app.listen({ host: '127.0.0.1', port })
  console.log(`Managed test instance: ${address}/`)
  console.log(
    'Separate test data; real Nuvio and Stremio services. Managed sync starts paused for a new manager. Use dedicated test accounts.'
  )
} catch (error) {
  await close()
  throw error
}
