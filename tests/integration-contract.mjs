import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { firstAuth, secondAuth } from './managed-contract.mjs'
import { authenticateApiKey } from '../server/managed/api-keys.js'

export function integrationContract(prefix, options, fixture) {
  const check = (name, run) =>
    test(`${prefix}: ${name}`, options, async (t) => run(await fixture(t)))
  const input = {
    externalRef: 'customer:synthetic-001',
    email: 'integration@example.invalid',
    password: ' Exact synthetic password! ',
    name: 'Synthetic customer',
  }
  check(
    'API keys are hashed, owner scoped, permission checked, expiring and revocable',
    async ({ db, repository, now }) => {
      const result = await repository.createApiKey(firstAuth, {
        name: 'Synthetic desktop',
        scopes: ['read', 'accounts:write'],
        expiresInDays: 365,
      })
      const auth = { apiKey: result.token, requiredScopes: ['read'] }
      assert.equal((await authenticateApiKey(db, auth, { now: now() })).owner, firstAuth.owner)
      const stored = JSON.stringify(
        await db.get('SELECT * FROM managed_api_keys WHERE id = $1', [result.key.id])
      )
      assert.ok(!stored.includes(result.token))
      assert.ok(!stored.includes(firstAuth.token))
      await assert.rejects(
        authenticateApiKey(db, { ...auth, requiredScopes: ['credentials:read'] }, { now: now() }),
        { code: 'FORBIDDEN' }
      )
      await assert.rejects(authenticateApiKey(db, auth, { now: result.key.expiresAt }), {
        code: 'UNAUTHORIZED',
      })
      assert.equal((await repository.listApiKeys(secondAuth)).keys.length, 0)
      await assert.rejects(repository.revokeApiKey(secondAuth, result.key.id), {
        code: 'NOT_FOUND',
      })
      await repository.revokeApiKey(firstAuth, result.key.id)
      await repository.revokeApiKey(firstAuth, result.key.id)
      await assert.rejects(authenticateApiKey(db, auth, { now: now() }), { code: 'UNAUTHORIZED' })
    }
  )
  check(
    'concurrent account creation and response recovery preserve exact credentials without provider work',
    async ({ db, repository }) => {
      const key = randomUUID()
      const [a, b] = await Promise.all([
        repository.createIntegrationAccount(firstAuth, input, key),
        repository.createIntegrationAccount(firstAuth, input, key),
      ])
      assert.equal(a.account.id, b.account.id)
      assert.equal([a, b].filter((result) => result.replayed).length, 1)
      assert.equal(a.account.state, 'staged')
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      assert.ok(!JSON.stringify(a).includes(input.password))
      assert.ok(
        !JSON.stringify(await db.get('SELECT * FROM managed_accounts')).includes(input.password)
      )
      assert.equal(
        (await repository.integrationCredentials(firstAuth, a.account.id)).password,
        input.password
      )
      assert.equal(
        (await repository.integrationAccount(firstAuth, input.externalRef)).accountId,
        a.account.id
      )
      assert.equal(
        (await repository.integrationReceipt(firstAuth, 'api.accounts.create', key)).account.id,
        a.account.id
      )
      await assert.rejects(
        repository.createIntegrationAccount(firstAuth, { ...input, name: 'Changed' }, key),
        { code: 'IDEMPOTENCY_CONFLICT' }
      )
      await assert.rejects(
        repository.createIntegrationAccount(
          firstAuth,
          { ...input, externalRef: 'another-ref' },
          randomUUID()
        ),
        { code: 'ACCOUNT_EXISTS' }
      )
      await assert.rejects(repository.integrationAccount(secondAuth, input.externalRef), {
        code: 'NOT_FOUND',
      })
      await assert.rejects(repository.integrationReceipt(secondAuth, 'api.accounts.create', key), {
        code: 'NOT_FOUND',
      })
      await assert.rejects(repository.integrationCredentials(secondAuth, a.account.id), {
        code: 'NOT_FOUND',
      })
    }
  )
  check(
    'explicit external links are stable and failed setup rolls back the whole account',
    async ({ db, repository }) => {
      const created = await repository.createIntegrationAccount(firstAuth, input, randomUUID())
      const linked = await repository.linkIntegrationAccount(
        firstAuth,
        { externalRef: 'desktop:existing', accountId: created.account.id },
        randomUUID()
      )
      assert.equal(linked.account.id, created.account.id)
      await assert.rejects(
        repository.linkIntegrationAccount(
          secondAuth,
          { externalRef: 'desktop:existing', accountId: created.account.id },
          randomUUID()
        ),
        { code: 'NOT_FOUND' }
      )
      const original = db.transaction.bind(db)
      db.transaction = (work) =>
        original((tx) =>
          work(
            new Proxy(tx, {
              get(target, property) {
                if (property === 'run')
                  return (sql, params) => {
                    if (sql.startsWith('INSERT INTO managed_external_refs'))
                      throw new Error('Synthetic storage failure')
                    return target.run(sql, params)
                  }
                const value = target[property]
                return typeof value === 'function' ? value.bind(target) : value
              },
            })
          )
        )
      try {
        await assert.rejects(
          repository.createIntegrationAccount(
            firstAuth,
            { ...input, email: 'rollback@example.invalid', externalRef: 'rollback' },
            randomUUID()
          )
        )
      } finally {
        db.transaction = original
      }
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 1)
    }
  )
  check(
    'account inventory exposes current failed/retrying jobs without stale-policy or owner leakage',
    async ({ db, repository, now }) => {
      const created = await repository.createIntegrationAccount(firstAuth, input, randomUUID())
      const id = created.account.id
      const job = randomUUID()
      await db.run(
        `INSERT INTO managed_jobs (id, owner_id, account_id, policy_version, target, cause, state, error_code, due_at, created_at, updated_at)
      VALUES ($1, $2, $3, 1, 'active', 'manual', 'failed', 'INVALID_CREDENTIALS', $4, $4, $4)`,
        [job, firstAuth.owner, id, now()]
      )
      assert.equal((await repository.listAccounts(firstAuth)).accounts[0].syncJob.state, 'failed')
      assert.equal(
        (await repository.integrationOperation(firstAuth, job)).errorCode,
        'INVALID_CREDENTIALS'
      )
      await assert.rejects(repository.integrationOperation(secondAuth, job), { code: 'NOT_FOUND' })
      await db.run('UPDATE managed_accounts SET policy_version = 2 WHERE id = $1', [id])
      assert.equal((await repository.listAccounts(firstAuth)).accounts[0].syncJob, null)
    }
  )
}
