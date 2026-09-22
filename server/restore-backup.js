// Offline tool: never opens a listener or starts provider workers. Refuses existing data.
import fs from 'node:fs/promises'
import path from 'node:path'
import { buildServer } from './app.js'
import { DB } from './db.js'
import { restoreManagedBackup } from './managed/backups.js'

const [filename, target] = process.argv.slice(2)
if (!filename || !target || !process.env.AIO_BACKUP_KEY) {
  console.error(
    'Usage: AIO_BACKUP_KEY=<matching key> node server/restore-backup.js <archive.aiobackup> <NEW data directory>'
  )
  process.exitCode = 1
} else {
  const directory = path.resolve(target)
  let app, db
  try {
    // mkdir without recursive intentionally rejects existing directories.
    await fs.mkdir(directory, { mode: 0o700 })
    const env = {
      ...process.env,
      DB_TYPE: process.env.AIO_RESTORE_DATABASE_URL ? 'postgres' : 'sqlite',
      DATABASE_URL: process.env.AIO_RESTORE_DATABASE_URL || '',
      MANAGED_WRITES_ENABLED: 'false',
      MANAGED_BACKUPS_ENABLED: 'false',
      ENCRYPTION_KEY: '',
    }
    db = new DB({ env, sqlitePath: path.join(directory, 'aio.db') })
    app = await buildServer({
      env,
      dataDir: directory,
      database: db,
      logger: false,
      serveStatic: false,
    })
    const restored = await restoreManagedBackup({
      db,
      filename: path.resolve(filename),
      secret: process.env.AIO_BACKUP_KEY,
    })
    await fs.writeFile(path.join(directory, 'server_secret.key'), restored.keys.primary, {
      mode: 0o600,
    })
    await fs.writeFile(
      path.join(directory, 'server_fallback_keys.json'),
      JSON.stringify(restored.keys.candidates ?? []),
      { flag: 'wx', mode: 0o600 }
    )
    console.log(
      `Restored ${restored.rows} records from ${new Date(restored.createdAt).toISOString()}. Managed sync and Autopilot are paused. Start this separate instance with managed writes disabled and review it first.`
    )
  } catch {
    console.error(
      'Restore failed. Use a new directory, an empty database, the matching archive/key, and the matching application version. No provider requests were made.'
    )
    process.exitCode = 1
  } finally {
    if (app) await app.close()
    else await db?.close()
  }
}
