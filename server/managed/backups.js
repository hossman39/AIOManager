import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import path from 'node:path'
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
} from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip, createGunzip } from 'node:zlib'
import { createInterface } from 'node:readline'
import { managedMigrations, migrationChecksum } from './schema.js'

// Dependency order is also the restore order. No dynamic SQL identifiers from a backup.
const tables = [
  'kv_store',
  'autopilot_rules',
  'failover_history',
  'managed_metadata',
  'managed_owners',
  'managed_groups',
  'managed_group_revisions',
  'managed_accounts',
  'managed_batches',
  'managed_idempotency',
  'managed_deployments',
  'managed_jobs',
  'managed_snapshots',
  'managed_audit',
  'managed_offboarded',
  'managed_job_history',
  'managed_account_links',
  'managed_api_keys',
  'managed_external_refs',
]
const history = () =>
  managedMigrations.map((migration) => ({
    version: migration.version,
    checksum: migrationChecksum(migration),
  }))
const material = (secret) =>
  Buffer.from(hkdfSync('sha256', secret, 'AIOManager backup v1', 'encryption', 32))
const keyId = (key) => createHash('sha256').update(key).digest('hex')
const backupName = /^aiomanager-\d{4}-\d{2}-\d{2}-[a-f0-9-]{36}\.aiobackup$/

export async function writeManagedBackup({ db, keys, directory, now = Date.now, dueOnly = false }) {
  const root = path.resolve(directory)
  await fs.mkdir(root, { recursive: true, mode: 0o700 })
  const timestamp = now(),
    name = `aiomanager-${new Date(timestamp).toISOString().slice(0, 10)}-${randomUUID()}.aiobackup`
  const filename = path.join(root, name),
    temporary = `${filename}.tmp`
  try {
    return await db.transaction(async (tx) => {
      if (tx.type === 'postgres') {
        await tx.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
        if (!(await tx.get('SELECT pg_try_advisory_xact_lock(804160, 5) AS locked')).locked)
          return null
      }
      const metadata = await tx.get('SELECT last_backup_at FROM managed_metadata WHERE id = 1')
      if (
        dueOnly &&
        metadata.last_backup_at !== null &&
        timestamp - metadata.last_backup_at < 86_400_000
      )
        return null
      const key = material(keys.primary),
        iv = randomBytes(12)
      const header = Buffer.from(
        JSON.stringify({ v: 1, kid: keyId(key), iv: iv.toString('base64url') }) + '\n'
      )
      await fs.writeFile(temporary, header, { flag: 'wx', mode: 0o600 })
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(header)
      const present = new Set(
        (
          await tx.query(
            tx.type === 'sqlite'
              ? "SELECT name FROM sqlite_master WHERE type = 'table'"
              : 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()'
          )
        ).map((row) => row.name)
      )
      const exported = tables.filter((table) => present.has(table))
      async function* records() {
        yield JSON.stringify({
          kind: 'header',
          v: 1,
          engine: db.type,
          createdAt: timestamp,
          keys,
          history: history(),
          tables: exported,
        }) + '\n'
        for (const table of exported) {
          // One row at a time bounds memory even for large legacy sync blobs.
          for (let offset = 0; ; offset++) {
            const row = await tx.get(`SELECT * FROM ${table} LIMIT 1 OFFSET $1`, [offset])
            if (!row) break
            yield JSON.stringify({ kind: 'row', table, value: row }) + '\n'
          }
        }
        yield JSON.stringify({ kind: 'complete' }) + '\n'
      }
      await pipeline(
        Readable.from(records()),
        createGzip(),
        cipher,
        createWriteStream(temporary, { flags: 'a', mode: 0o600 })
      )
      const file = await fs.open(temporary, 'a')
      try {
        await file.write(cipher.getAuthTag())
        if ((await file.stat()).size > 2 * 1024 ** 3)
          throw new Error('Backup exceeds restore size limit')
        await file.sync()
      } finally {
        await file.close()
      }
      await fs.rename(temporary, filename)
      await tx.run('UPDATE managed_metadata SET last_backup_at = $1 WHERE id = 1', [timestamp])
      return { filename, createdAt: timestamp }
    })
  } catch {
    await fs.unlink(temporary).catch(() => {})
    throw new Error('Encrypted backup failed. Check the backup directory and database.')
  }
}

/** Offline restore into an initialized EMPTY database; authentication failures roll back all rows. */
export async function restoreManagedBackup({ db, filename, secret }) {
  const file = await fs.open(filename, 'r')
  let header, headerBytes, size, tag
  try {
    size = (await file.stat()).size
    if (size < 64 || size > 2 * 1024 ** 3) throw new Error('Invalid backup size')
    const prefix = Buffer.alloc(1024)
    const { bytesRead } = await file.read(prefix, 0, prefix.length, 0)
    const end = prefix.subarray(0, bytesRead).indexOf(10)
    if (end < 0) throw new Error('Invalid backup header')
    headerBytes = prefix.subarray(0, end + 1)
    header = JSON.parse(headerBytes.toString())
    tag = Buffer.alloc(16)
    await file.read(tag, 0, 16, size - 16)
  } finally {
    await file.close()
  }
  const key = material(secret)
  if (header.v !== 1 || header.kid !== keyId(key))
    throw new Error('The backup needs its matching encryption key')
  let gunzip,
    lines,
    completion = Promise.resolve()
  try {
    return await db.transaction(async (tx) => {
      const present = new Set(
        (
          await tx.query(
            tx.type === 'sqlite'
              ? "SELECT name FROM sqlite_master WHERE type = 'table'"
              : 'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()'
          )
        ).map((row) => row.name)
      )
      for (const table of tables)
        if (
          present.has(table) &&
          table !== 'managed_metadata' &&
          (await tx.get(`SELECT 1 AS present FROM ${table} LIMIT 1`))
        )
          throw new Error('Restore requires an empty database')
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64url'))
      decipher.setAAD(headerBytes)
      decipher.setAuthTag(tag)
      gunzip = createGunzip()
      lines = createInterface({ input: gunzip, crlfDelay: Infinity })
      const iterator = lines[Symbol.asyncIterator]()
      completion = pipeline(
        createReadStream(filename, { start: headerBytes.length, end: size - 17 }),
        decipher,
        gunzip
      )
      completion.catch(() => {})
      let info,
        complete = false,
        rows = 0
      const columns = new Map()
      for await (const line of iterator) {
        if (complete || line.length > 200 * 1024 ** 2) throw new Error('Invalid backup record')
        const record = JSON.parse(line)
        if (!info) {
          if (
            record.kind !== 'header' ||
            record.v !== 1 ||
            JSON.stringify(record.history) !== JSON.stringify(history()) ||
            !Array.isArray(record.tables) ||
            record.tables.some((table) => !tables.includes(table) || !present.has(table))
          )
            throw new Error('Restore needs the matching application schema')
          if (!record.keys?.primary || !Array.isArray(record.keys.candidates))
            throw new Error('Invalid backup keyring')
          info = record
          await tx.run('DELETE FROM managed_metadata')
        } else if (record.kind === 'complete') complete = true
        else {
          if (
            record.kind !== 'row' ||
            !info.tables.includes(record.table) ||
            !record.value ||
            typeof record.value !== 'object'
          )
            throw new Error('Invalid backup row')
          if (!columns.has(record.table)) {
            const names =
              tx.type === 'sqlite'
                ? (await tx.query(`PRAGMA table_info(${record.table})`)).map((row) => row.name)
                : (
                    await tx.query(
                      'SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1',
                      [record.table]
                    )
                  ).map((row) => row.column_name)
            columns.set(record.table, new Set(names))
          }
          const names = Object.keys(record.value)
          if (
            !names.length ||
            names.some((name) => !/^[a-z_]+$/.test(name) || !columns.get(record.table).has(name))
          )
            throw new Error('Invalid backup columns')
          await tx.run(
            `INSERT INTO ${record.table} (${names.join(', ')}) VALUES (${names.map((_, index) => `$${index + 1}`).join(', ')})`,
            names.map((name) => record.value[name])
          )
          rows++
        }
      }
      await completion // Authenticate the entire archive BEFORE committing.
      if (!info || !complete) throw new Error('Incomplete backup')
      await tx.run(
        'UPDATE managed_metadata SET write_paused = 1, writer_dirty = 0, last_backup_at = NULL, last_scan_at = NULL'
      )
      await tx.run('UPDATE managed_owners SET write_paused = 1')
      if (present.has('autopilot_rules')) await tx.run('UPDATE autopilot_rules SET is_active = 0')
      return { createdAt: info.createdAt, keys: info.keys, rows }
    })
  } finally {
    lines?.close()
    gunzip?.destroy()
    await completion.catch(() => {})
  }
}

export function createManagedBackupScheduler({
  db,
  keys,
  directory,
  now = Date.now,
  onError = () => {},
}) {
  let timer,
    running,
    closed = false
  const run = () => {
    if (!running)
      running = writeManagedBackup({ db, keys, directory, now, dueOnly: true })
        .then(async (result) => {
          if (result) {
            const root = path.resolve(directory)
            const names = (await fs.readdir(root))
              .filter((name) => backupName.test(name))
              .sort()
              .reverse()
            for (const name of names.slice(14)) {
              const target = path.resolve(root, name)
              if (path.dirname(target) !== root) throw new Error('Invalid backup path')
              await fs.unlink(target)
            }
          }
          return result
        })
        .finally(() => {
          running = null
        })
    return running
  }
  return {
    run,
    start() {
      if (closed || timer) return
      const tick = async () => {
        try {
          await run()
        } catch {
          onError()
        }
        if (!closed) {
          timer = setTimeout(tick, 60_000)
          timer.unref?.()
        }
      }
      timer = setTimeout(tick, 0)
      timer.unref?.()
    },
    async close() {
      closed = true
      clearTimeout(timer)
      await running?.catch(() => {})
    },
  }
}
