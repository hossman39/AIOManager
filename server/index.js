import { buildServer } from './app.js'

let app
let stopping = false
async function shutdown(signal) {
  if (stopping) return
  stopping = true
  app?.log.info({ signal }, 'Draining server and background work')
  try {
    await app?.close()
    process.exitCode = 0
  } catch {
    app?.log.error('Server shutdown failed')
    process.exitCode = 1
  }
}

try {
  app = await buildServer({ backgroundWorkers: true, banner: true })
  process.once('SIGINT', () => {
    void shutdown('SIGINT')
  })
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM')
  })
  await app.listen({ port: Number(process.env.PORT || 16100), host: process.env.HOST || '0.0.0.0' })
} catch (error) {
  console.error('[Server] Startup failed:', error.message)
  if (app) await app.close().catch(() => {})
  process.exitCode = 1
}
