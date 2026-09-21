import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ManagedError } from './errors.js'

const inputSchema = z.strictObject({
  accounts: z
    .array(
      z.strictObject({
        localId: z.string().min(1).max(128),
        email: z.email().max(254).optional(),
        name: z.string().max(120).optional(),
        password: z.string().min(1).max(4096).optional(),
      })
    )
    .min(1)
    .max(100),
})
const context = (owner, id, purpose) => ({ owner, id, purpose })

/** Link the existing account cache to its server record without activating it.
 * Owner/local IDs and owner/email keys make this operation naturally retry-safe.
 * Links survive removal so an older browser cannot recreate a removed account.
 */
export function createManagedConnections({ crypto, ownerTransaction, publicAccount }) {
  return {
    async connectAccounts(auth, input) {
      const parsed = inputSchema.safeParse(input)
      if (
        !parsed.success ||
        new Set(parsed.data.accounts.map((row) => row.localId)).size !== parsed.data.accounts.length
      )
        throw new ManagedError('INVALID_INPUT')
      return ownerTransaction(auth, async (tx, owner, _settings, timestamp) => {
        const connections = []
        for (const candidate of parsed.data.accounts) {
          const emailKey = candidate.email
            ? crypto.fingerprint(candidate.email.toLowerCase(), context(owner, 'email', 'lookup'))
            : null
          let link = await tx.get(
            'SELECT * FROM managed_account_links WHERE owner_id = $1 AND local_id = $2',
            [owner, candidate.localId]
          )
          if (link && emailKey && link.email_key !== emailKey)
            throw new ManagedError('VERSION_CONFLICT')
          // Another device may use a different cache ID for the same Stremio account.
          if (!link && emailKey)
            link = await tx.get(
              'SELECT * FROM managed_account_links WHERE owner_id = $1 AND email_key = $2 LIMIT 1',
              [owner, emailKey]
            )
          let row = link
            ? await tx.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
                owner,
                link.account_id,
              ])
            : emailKey
              ? await tx.get(
                  'SELECT * FROM managed_accounts WHERE owner_id = $1 AND email_key = $2',
                  [owner, emailKey]
                )
              : null
          if (!link && !row && (!candidate.email || !candidate.password)) {
            connections.push({
              localId: candidate.localId,
              status: 'needs_credentials',
              account: null,
            })
            continue
          }
          if (!link && !row) {
            const id = randomUUID()
            await tx.run(
              `INSERT INTO managed_accounts
              (id, owner_id, email_key, credentials_enc, personal_enc, configuration_enc, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
              [
                id,
                owner,
                emailKey,
                crypto.seal(
                  {
                    email: candidate.email,
                    password: candidate.password,
                    name: candidate.name?.trim() || candidate.email,
                  },
                  context(owner, id, 'credentials')
                ),
                crypto.seal([], context(owner, id, 'personal-addons')),
                crypto.seal([], context(owner, id, 'configuration')),
                timestamp,
              ]
            )
            row = await tx.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
              owner,
              id,
            ])
          }
          await tx.run(
            `INSERT INTO managed_account_links (owner_id, local_id, account_id, email_key, created_at)
             VALUES ($1, $2, $3, $4, $5) ON CONFLICT (owner_id, local_id) DO NOTHING`,
            [
              owner,
              candidate.localId,
              row?.id ?? link.account_id,
              emailKey ?? link.email_key,
              timestamp,
            ]
          )
          connections.push({
            localId: candidate.localId,
            status: row ? 'linked' : 'removed',
            account: row ? publicAccount(row) : null,
          })
        }
        return { connections }
      })
    },
  }
}
