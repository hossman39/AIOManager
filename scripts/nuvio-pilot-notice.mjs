// Serve the PC pilot's public notice on the selected interface for a TV on the same LAN.
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import Fastify from 'fastify'
import ipaddr from 'ipaddr.js'
import { createEnvelopeCrypto } from '../server/managed/crypto.js'
import { registerExpiryNoticeRoutes } from '../server/managed/expiry-notice.js'

const host = process.argv[2]
const addresses = Object.values(networkInterfaces())
  .flat()
  .filter(
    (entry) =>
      entry?.family === 'IPv4' &&
      ['private', 'loopback'].includes(ipaddr.parse(entry.address).range())
  )
  .map((entry) => entry.address)
if (!addresses.includes(host)) {
  console.error('Run node scripts/nuvio-pilot-notice.mjs <PC Wi-Fi or Ethernet IPv4 address>.')
  console.error('Available addresses:', addresses.join(', '))
  process.exitCode = 1
} else {
  const data = new URL('../data/nuvio-pilot/', import.meta.url)
  const primary = (await readFile(new URL('server_secret.key', data), 'utf8')).trim()
  const db = new Database(fileURLToPath(new URL('aio.db', data)), {
    readonly: true,
    fileMustExist: true,
  })
  const app = Fastify({ logger: false })
  app.addHook('onClose', async () => db.close())
  try {
    await registerExpiryNoticeRoutes(app, {
      db: {
        get: (sql, params) =>
          db.prepare(sql).get(Object.fromEntries(params.map((value, i) => [String(i + 1), value]))),
      },
      crypto: createEnvelopeCrypto({ primary }),
    })
    const address = await app.listen({ host, port: 1613 })
    console.log('Pilot notice base URL:', address)
    process.once('SIGINT', () => void app.close())
    process.once('SIGTERM', () => void app.close())
  } catch (error) {
    await app.close()
    throw error
  }
}
