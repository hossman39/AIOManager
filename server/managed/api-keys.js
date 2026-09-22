import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { ManagedError } from './errors.js'

export const API_SCOPES = Object.freeze([
  'read',
  'accounts:write',
  'groups:write',
  'sync:write',
  'configuration:read',
  'credentials:read',
  'accounts:remove',
])
const digest = (value) => createHash('sha256').update(value).digest('hex')
const publicKey = (row) => ({
  id: row.id,
  name: row.name,
  scopes: JSON.parse(row.scopes),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
})

// A high-entropy bearer secret is stored only as a SHA-256 digest. No manager
// password is exchanged or retained by integrations.
export async function authenticateApiKey(db, auth, { lock = false, now = Date.now() } = {}) {
  const match =
    typeof auth.apiKey === 'string' && /^aio_([a-f0-9-]{36})_([A-Za-z0-9_-]{43})$/.exec(auth.apiKey)
  if (!match) throw new ManagedError('UNAUTHORIZED')
  let row = await db.get('SELECT * FROM managed_api_keys WHERE id = $1', [match[1]])
  if (!row) throw new ManagedError('UNAUTHORIZED')
  if (lock && db.type === 'postgres') {
    // Match manager mutation/revocation lock ordering, then recheck revocation.
    await db.get('SELECT key FROM kv_store WHERE key = $1 FOR UPDATE', [row.owner_id])
    row = await db.get('SELECT * FROM managed_api_keys WHERE id = $1 FOR UPDATE', [match[1]])
  }
  const actual = Buffer.from(digest(auth.apiKey), 'hex')
  const expected = Buffer.from(row.token_hash, 'hex')
  if (
    expected.length !== actual.length ||
    !timingSafeEqual(actual, expected) ||
    row.revoked_at !== null ||
    row.expires_at <= now
  )
    throw new ManagedError('UNAUTHORIZED')
  const scopes = JSON.parse(row.scopes)
  if (
    !Array.isArray(auth.requiredScopes) ||
    auth.requiredScopes.some((scope) => !scopes.includes(scope))
  )
    throw new ManagedError('FORBIDDEN')
  return { owner: row.owner_id, key: publicKey(row) }
}

export function createApiKeyRepository({ db, authorize, ownerTransaction }) {
  return {
    async listApiKeys(auth) {
      if (auth.apiKey) throw new ManagedError('FORBIDDEN')
      const owner = await authorize(auth)
      const rows = await db.query(
        'SELECT * FROM managed_api_keys WHERE owner_id = $1 ORDER BY CASE WHEN revoked_at IS NULL AND expires_at > $2 THEN 0 ELSE 1 END, created_at DESC, id LIMIT 100',
        [owner, Date.now()]
      )
      return { keys: rows.map(publicKey), scopes: API_SCOPES }
    },
    async createApiKey(auth, input) {
      if (auth.apiKey) throw new ManagedError('FORBIDDEN')
      const parsed = z
        .strictObject({
          name: z.string().trim().min(1).max(80),
          scopes: z.array(z.enum(API_SCOPES)).min(1).max(API_SCOPES.length),
          expiresInDays: z.number().int().min(1).max(365),
        })
        .safeParse(input)
      if (!parsed.success) throw new ManagedError('INVALID_INPUT')
      return ownerTransaction(auth, async (tx, owner, _settings, timestamp) => {
        const count = await tx.get(
          'SELECT COUNT(*) AS count FROM managed_api_keys WHERE owner_id = $1 AND revoked_at IS NULL AND expires_at > $2',
          [owner, timestamp]
        )
        if (count.count >= 20) throw new ManagedError('API_KEY_LIMIT')
        const id = randomUUID()
        const token = `aio_${id}_${randomBytes(32).toString('base64url')}`
        const row = {
          id,
          owner_id: owner,
          name: parsed.data.name,
          token_hash: digest(token),
          scopes: JSON.stringify([...new Set(parsed.data.scopes)]),
          created_at: timestamp,
          expires_at: timestamp + parsed.data.expiresInDays * 86_400_000,
          revoked_at: null,
          last_used_at: null,
        }
        await tx.run(
          `INSERT INTO managed_api_keys (id, owner_id, name, token_hash, scopes, created_at, expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, owner, row.name, row.token_hash, row.scopes, timestamp, row.expires_at]
        )
        return { key: publicKey(row), token }
      })
    },
    async revokeApiKey(auth, id) {
      if (auth.apiKey) throw new ManagedError('FORBIDDEN')
      return ownerTransaction(auth, async (tx, owner, _settings, timestamp) => {
        const row = await tx.get(
          'SELECT id FROM managed_api_keys WHERE owner_id = $1 AND id = $2',
          [owner, id]
        )
        if (!row) throw new ManagedError('NOT_FOUND')
        await tx.run(
          'UPDATE managed_api_keys SET revoked_at = COALESCE(revoked_at, $1) WHERE owner_id = $2 AND id = $3',
          [timestamp, owner, id]
        )
        return { revoked: true }
      })
    },
  }
}
