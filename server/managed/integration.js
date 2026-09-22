import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ManagedError } from './errors.js'

const externalRef = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)
const createInput = z.strictObject({
  externalRef,
  email: z.email().max(254),
  password: z.string().min(1).max(4096),
  name: z.string().trim().min(1).max(120).optional(),
})
const linkInput = z.strictObject({ externalRef, accountId: z.uuid() })
const context = (owner, id, purpose) => ({ owner, id, purpose })
const parse = (schema, input) => {
  const result = schema.safeParse(input)
  if (!result.success) throw new ManagedError('INVALID_INPUT')
  return result.data
}

export function createIntegrationRepository({
  db,
  crypto,
  authorize,
  ownerTransaction,
  idempotent,
  publicAccount,
}) {
  return {
    async createIntegrationAccount(auth, input, key) {
      const value = parse(createInput, input)
      return ownerTransaction(auth, (tx, owner, _settings, timestamp) =>
        idempotent(tx, owner, 'api.accounts.create', key, value, timestamp, async () => {
          const prior = await tx.get(
            'SELECT account_id FROM managed_external_refs WHERE owner_id = $1 AND external_ref = $2',
            [owner, value.externalRef]
          )
          if (prior) throw new ManagedError('ACCOUNT_EXISTS')
          const emailKey = crypto.fingerprint(
            value.email.toLowerCase(),
            context(owner, 'email', 'lookup')
          )
          if (
            (await tx.get(
              'SELECT id FROM managed_accounts WHERE owner_id = $1 AND email_key = $2',
              [owner, emailKey]
            )) ||
            (await tx.get(
              'SELECT account_id FROM managed_account_links WHERE owner_id = $1 AND email_key = $2',
              [owner, emailKey]
            ))
          )
            throw new ManagedError('ACCOUNT_EXISTS')
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
                { email: value.email, password: value.password, name: value.name ?? value.email },
                context(owner, id, 'credentials')
              ),
              crypto.seal([], context(owner, id, 'personal-addons')),
              crypto.seal([], context(owner, id, 'configuration')),
              timestamp,
            ]
          )
          await tx.run(
            'INSERT INTO managed_external_refs (owner_id, external_ref, account_id, created_at) VALUES ($1, $2, $3, $4)',
            [owner, value.externalRef, id, timestamp]
          )
          // Reserve the email after offboarding just like a browser-created account.
          await tx.run(
            'INSERT INTO managed_account_links (owner_id, local_id, account_id, email_key, created_at) VALUES ($1, $2, $3, $4, $5)',
            [owner, `api:${id}`, id, emailKey, timestamp]
          )
          const row = await tx.get(
            'SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2',
            [owner, id]
          )
          return {
            account: publicAccount(row),
            externalRef: value.externalRef,
            jobId: null,
            replayed: false,
          }
        })
      )
    },
    async linkIntegrationAccount(auth, input, key) {
      const value = parse(linkInput, input)
      return ownerTransaction(auth, (tx, owner, _settings, timestamp) =>
        idempotent(tx, owner, 'api.accounts.link', key, value, timestamp, async () => {
          const row = await tx.get(
            'SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2',
            [owner, value.accountId]
          )
          if (!row) throw new ManagedError('NOT_FOUND')
          const prior = await tx.get(
            'SELECT account_id FROM managed_external_refs WHERE owner_id = $1 AND external_ref = $2',
            [owner, value.externalRef]
          )
          if (prior && prior.account_id !== row.id) throw new ManagedError('ACCOUNT_EXISTS')
          await tx.run(
            `INSERT INTO managed_external_refs (owner_id, external_ref, account_id, created_at)
            VALUES ($1, $2, $3, $4) ON CONFLICT (owner_id, external_ref) DO NOTHING`,
            [owner, value.externalRef, row.id, timestamp]
          )
          return {
            account: publicAccount(row),
            externalRef: value.externalRef,
            jobId: null,
            replayed: false,
          }
        })
      )
    },
    async integrationAccount(auth, reference) {
      parse(externalRef, reference)
      const owner = await authorize(auth)
      const ref = await db.get(
        'SELECT account_id FROM managed_external_refs WHERE owner_id = $1 AND external_ref = $2',
        [owner, reference]
      )
      if (!ref) throw new ManagedError('NOT_FOUND')
      const row = await db.get('SELECT * FROM managed_accounts WHERE owner_id = $1 AND id = $2', [
        owner,
        ref.account_id,
      ])
      return {
        externalRef: reference,
        accountId: ref.account_id,
        removed: !row,
        account: row ? publicAccount(row) : null,
      }
    },
    async integrationCredentials(auth, id) {
      const owner = await authorize(auth)
      const row = await db.get(
        'SELECT credentials_enc FROM managed_accounts WHERE owner_id = $1 AND id = $2',
        [owner, id]
      )
      if (!row) throw new ManagedError('NOT_FOUND')
      const saved = crypto.open(row.credentials_enc, context(owner, id, 'credentials'))
      return { accountId: id, email: saved.email, password: saved.password }
    },
    async integrationOperation(auth, id) {
      const owner = await authorize(auth)
      const row =
        (await db.get(
          `SELECT id, account_id, policy_version, target, state, error_code, updated_at
        FROM managed_jobs WHERE owner_id = $1 AND id = $2`,
          [owner, id]
        )) ??
        (await db.get('SELECT * FROM managed_job_history WHERE owner_id = $1 AND id = $2', [
          owner,
          id,
        ]))
      if (!row) throw new ManagedError('NOT_FOUND')
      return {
        id: row.id,
        accountId: row.account_id,
        policyVersion: row.policy_version,
        target: row.target,
        state: row.state,
        errorCode: row.error_code,
        updatedAt: row.updated_at,
      }
    },
    async integrationReceipt(auth, scope, key) {
      const owner = await authorize(auth)
      if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new ManagedError('INVALID_INPUT')
      const row = await db.get(
        'SELECT response_enc FROM managed_idempotency WHERE owner_id = $1 AND scope = $2 AND request_key = $3',
        [owner, scope, key]
      )
      if (!row) throw new ManagedError('NOT_FOUND')
      return {
        ...crypto.open(row.response_enc, context(owner, `${scope}:${key}`, 'idempotency-response')),
        replayed: true,
      }
    },
  }
}
