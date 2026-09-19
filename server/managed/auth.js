import { decrypt } from '../crypto.js'
import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'

export async function authenticateManager(db, auth, keys, { lock = false } = {}) {
  if (
    !auth ||
    typeof auth.owner !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(auth.owner) ||
    typeof auth.token !== 'string' ||
    !auth.token ||
    auth.token.length > 1024
  )
    throw new ManagedError('UNAUTHORIZED')
  const row = await db.get(
    `SELECT password FROM kv_store WHERE key = $1${lock && db.type === 'postgres' ? ' FOR UPDATE' : ''}`,
    [auth.owner]
  )
  // Legacy sync supports both older token rows and encrypted tokens. This is an
  // authentication bridge only; managed records never use this decrypt fallback.
  if (!row || !equalSecret(decrypt(row.password, keys), auth.token))
    throw new ManagedError('UNAUTHORIZED')
  return auth.owner
}
