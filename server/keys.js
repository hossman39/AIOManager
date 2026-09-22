import fs from 'node:fs/promises'
import path from 'node:path'
import { generateRandomKey } from './crypto.js'

const retainedTables = [
  'kv_store',
  'autopilot_rules',
  'failover_history',
  'managed_accounts',
  'managed_groups',
  'managed_snapshots',
  'managed_batches',
  'managed_settings',
  'managed_metadata',
  'managed_owners',
]

async function hasRetainedData(db) {
  const tables =
    db.type === 'sqlite'
      ? await db.query("SELECT name FROM sqlite_master WHERE type = 'table'")
      : await db.query(
          'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()'
        )
  const present = new Set(tables.map((table) => table.name))
  for (const table of retainedTables) {
    // Identifier comes only from the constant allowlist above.
    if (present.has(table) && (await db.get(`SELECT 1 AS present FROM ${table} LIMIT 1`)))
      return true
  }
  return false
}

async function readKey(filename) {
  try {
    const key = (await fs.readFile(filename, 'utf8')).trim()
    if (!key) throw new Error('Persistent encryption key is empty; restore the matching key')
    return key
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/** Never create a replacement key over retained data whose key is missing. */
export async function loadServerKeys({ db, dataDir, configuredKey }) {
  const filename = path.join(dataDir, 'server_secret.key')
  const fileKey = await readKey(filename)
  let restoredFallbacks = []
  try {
    restoredFallbacks = JSON.parse(
      await fs.readFile(path.join(dataDir, 'server_fallback_keys.json'), 'utf8')
    )
    if (
      !Array.isArray(restoredFallbacks) ||
      restoredFallbacks.length > 16 ||
      restoredFallbacks.some((key) => typeof key !== 'string' || !key)
    )
      throw new Error('Invalid restored encryption keyring')
  } catch (error) {
    if (error.code !== 'ENOENT')
      throw new Error('Restored encryption keyring is unreadable; restore the matching key files')
  }
  if (configuredKey) {
    return {
      primary: configuredKey,
      candidates: [...new Set([configuredKey, fileKey, ...restoredFallbacks].filter(Boolean))],
    }
  }
  if (fileKey)
    return { primary: fileKey, candidates: [...new Set([fileKey, ...restoredFallbacks])] }
  if (await hasRetainedData(db)) {
    throw new Error(
      'Encryption key is missing for retained data; restore the matching key before startup'
    )
  }
  const newKey = generateRandomKey()
  try {
    const file = await fs.open(filename, 'wx', 0o600)
    try {
      await file.writeFile(newKey, 'utf8')
      await file.sync()
    } finally {
      await file.close()
    }
    return { primary: newKey, candidates: [newKey] }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const existing = await readKey(filename)
    if (!existing) throw new Error('Persistent encryption key disappeared during startup')
    return { primary: existing, candidates: [existing] }
  }
}
