import Database from 'better-sqlite3'
import fs from 'node:fs'
import pg from 'pg'
import { postgresOptions } from '../db.js'
import { ManagedError } from './errors.js'

const localOwners = new Set()
/** Holds a dedicated OS/database lock for the writer's complete lifetime. */
export async function acquireWriterOwnership(db, { now = Date.now, recoveryMs = 30_000 } = {}) {
  const key =
    db.type === 'sqlite' && db.sqlitePath !== ':memory:' ? fs.realpathSync(db.sqlitePath) : db
  if (localOwners.has(key)) throw new ManagedError('WRITER_UNAVAILABLE')
  localOwners.add(key)
  let sqlite,
    client,
    active = true,
    closing = null
  const controller = new AbortController()
  const lost = () => {
    active = false
    controller.abort()
  }
  try {
    if (db.type === 'postgres') {
      client = new pg.Client(postgresOptions(db.env))
      client.on('error', lost)
      client.on('end', lost)
      await client.connect()
      const locked = await client.query('SELECT pg_try_advisory_lock(804160, 3) AS locked')
      if (!locked.rows[0].locked) throw new ManagedError('WRITER_UNAVAILABLE')
    } else {
      sqlite = new Database(typeof key === 'string' ? `${key}.writer-lock` : ':memory:', {
        timeout: 0,
      })
      sqlite.exec('BEGIN EXCLUSIVE')
    }
    const previous = await db.get('SELECT writer_dirty FROM managed_metadata WHERE id = 1')
    const readyAt = now() + (previous.writer_dirty ? recoveryMs : 0)
    await db.run('UPDATE managed_metadata SET writer_dirty = 1 WHERE id = 1')
    return Object.freeze({
      signal: controller.signal,
      readyAt,
      async assertOwned() {
        if (!active || now() < readyAt) throw new ManagedError('WRITER_UNAVAILABLE')
        try {
          if (client) {
            const result = await client.query({
              text: "SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND classid = 804160 AND objid = 3 AND granted) AS locked",
              query_timeout: 5000,
            })
            if (!result.rows[0].locked) throw new Error('lock lost')
          } else sqlite.prepare('SELECT 1').get()
        } catch {
          lost()
          throw new ManagedError('WRITER_UNAVAILABLE')
        }
      },
      close(clean = true) {
        if (!closing)
          closing = (async () => {
            const wasActive = active
            lost()
            try {
              if (clean && wasActive)
                await db.run('UPDATE managed_metadata SET writer_dirty = 0 WHERE id = 1')
            } finally {
              sqlite?.close()
              if (client) {
                if (wasActive)
                  await client.query('SELECT pg_advisory_unlock(804160, 3)').catch(() => {})
                await client.end()
              }
              localOwners.delete(key)
            }
          })()
        return closing
      },
    })
  } catch (error) {
    sqlite?.close()
    if (client) await client.end().catch(() => {})
    localOwners.delete(key)
    throw error instanceof ManagedError ? error : new ManagedError('WRITER_UNAVAILABLE')
  }
}
