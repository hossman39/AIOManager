import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { encrypt } from '../server/crypto.js'
import { migrateManagedSchema, managedMigrations } from '../server/managed/schema.js'
import { initializeManagedCrypto } from '../server/managed/crypto.js'
import { createManagedRepository, parseImportBody } from '../server/managed/repository.js'

export const syntheticKey = 'synthetic-managed-test-key'
export const firstAuth = { owner: 'manager-one', token: 'synthetic-token-one' }
export const secondAuth = { owner: 'manager-two', token: 'synthetic-token-two' }
export const syntheticAccount = {
  email: 'Person@example.invalid',
  password: ' \tSynthetic-é-🔑\r\n ',
}
export const parsedAccounts = (accounts = [syntheticAccount]) =>
  parseImportBody({ version: '2.0.0', accounts })

export async function prepareManagedFixture(db, { migrations = managedMigrations } = {}) {
  await db.exec(
    'CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, password TEXT, updated_at BIGINT)'
  )
  for (const auth of [firstAuth, secondAuth]) {
    await db.run('INSERT INTO kv_store (key, password) VALUES ($1, $2)', [
      auth.owner,
      encrypt(auth.token, syntheticKey),
    ])
  }
  await migrateManagedSchema(db, migrations)
  const crypto = await initializeManagedCrypto(db, { primary: syntheticKey })
  let timestamp = 1_790_000_000_000
  const now = () => timestamp
  const repository = createManagedRepository({ db, crypto, legacyKeys: [syntheticKey], now })
  return {
    db,
    crypto,
    repository,
    now,
    advance: (ms) => {
      timestamp += ms
    },
  }
}

/** The identical persistence assertions run on native SQLite and hosted PostgreSQL. */
export function managedStorageContract(prefix, options, fixture) {
  const check = (name, fn) =>
    test(`${prefix}: ${name}`, options, async (t) => fn(await fixture(t), t))

  check(
    'normal account connection creates one inactive account and preserves exact credentials',
    async ({ db, repository, crypto }) => {
      const input = {
        accounts: [
          { localId: 'existing-browser-id', ...syntheticAccount, name: 'My test account' },
        ],
      }
      const first = (await repository.connectAccounts(firstAuth, input)).connections[0]
      assert.equal(first.status, 'linked')
      assert.equal(first.account.state, 'staged')
      assert.equal(first.account.membershipType, 'unset')
      assert.equal(first.account.groupId, null)
      assert.equal(first.account.name, 'My test account')
      const row = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [first.account.id])
      assert.equal(
        crypto.open(row.credentials_enc, {
          owner: firstAuth.owner,
          id: row.id,
          purpose: 'credentials',
        }).password,
        syntheticAccount.password
      )
      const replay = await repository.connectAccounts(firstAuth, input)
      assert.deepEqual(replay.connections[0], first)
      const otherDevice = await repository.connectAccounts(firstAuth, {
        accounts: [
          {
            ...input.accounts[0],
            localId: 'another-browser-id',
            email: syntheticAccount.email.toLowerCase(),
          },
        ],
      })
      assert.equal(otherDevice.connections[0].account.id, first.account.id)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 1)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      assert.ok(
        !JSON.stringify(await db.query('SELECT * FROM managed_account_links')).includes(
          syntheticAccount.password
        )
      )
    }
  )

  check(
    'connection finds an imported account without replacing its membership or saved login',
    async ({ repository, db, crypto }) => {
      const imported = await repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
      const id = imported.accounts[0].id
      await repository.setMembership(
        firstAuth,
        id,
        { expectedVersion: 1, mode: 'lifetime' },
        randomUUID()
      )
      const connected = await repository.connectAccounts(firstAuth, {
        accounts: [
          {
            localId: 'cached-account',
            email: syntheticAccount.email,
            password: 'Different old cached password',
            name: 'Old name',
          },
        ],
      })
      assert.equal(connected.connections[0].account.id, id)
      assert.equal(connected.connections[0].account.membershipType, 'lifetime')
      assert.equal(connected.connections[0].account.version, 2)
      const row = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [id])
      assert.equal(
        crypto.open(row.credentials_enc, { owner: firstAuth.owner, id, purpose: 'credentials' })
          .password,
        syntheticAccount.password
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 1)
    }
  )

  check(
    'accounts without saved credentials stay visible for completion without creating invalid server records',
    async ({ repository, db }) => {
      const input = { accounts: [{ localId: 'oauth-account', email: syntheticAccount.email }] }
      assert.deepEqual((await repository.connectAccounts(firstAuth, input)).connections, [
        { localId: 'oauth-account', status: 'needs_credentials', account: null },
      ])
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 0)
      input.accounts[0].password = syntheticAccount.password
      assert.equal(
        (await repository.connectAccounts(firstAuth, input)).connections[0].status,
        'linked'
      )
      delete input.accounts[0].password
      assert.equal(
        (await repository.connectAccounts(firstAuth, input)).connections[0].status,
        'linked'
      )
    }
  )

  check(
    'account connections are owner scoped and cannot be rebound to a different email',
    async ({ repository, db }) => {
      const input = { accounts: [{ localId: 'same-cache-id', ...syntheticAccount }] }
      const first = (await repository.connectAccounts(firstAuth, input)).connections[0].account
      const second = (await repository.connectAccounts(secondAuth, input)).connections[0].account
      assert.notEqual(first.id, second.id)
      await assert.rejects(
        repository.connectAccounts(firstAuth, {
          accounts: [
            {
              localId: 'new-before-error',
              email: 'another@example.invalid',
              password: 'synthetic',
            },
            { ...input.accounts[0], email: 'different@example.invalid' },
          ],
        }),
        { code: 'VERSION_CONFLICT' }
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 2)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_account_links')).count, 2)
      await assert.rejects(
        repository.connectAccounts({ ...firstAuth, token: 'wrong-token' }, input),
        { code: 'UNAUTHORIZED' }
      )
    }
  )

  check(
    'removed account links reject resurrection by retries, stale browsers, or another cache ID',
    async ({ repository, db }) => {
      const input = { accounts: [{ localId: 'cached-before-removal', ...syntheticAccount }] }
      const created = (await repository.connectAccounts(firstAuth, input)).connections[0].account
      await db.run('DELETE FROM managed_accounts WHERE id = $1', [created.id])
      assert.deepEqual((await repository.connectAccounts(firstAuth, input)).connections, [
        { localId: input.accounts[0].localId, status: 'removed', account: null },
      ])
      input.accounts[0].localId = 'another-stale-browser'
      assert.equal(
        (await repository.connectAccounts(firstAuth, input)).connections[0].status,
        'removed'
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 0)
    }
  )

  check(
    'connection payload validation rejects duplicate cache IDs and never accepts addon or token fields',
    async ({ repository, db }) => {
      const candidate = { localId: 'cache-id', ...syntheticAccount }
      for (const accounts of [
        [candidate, candidate],
        [{ ...candidate, authKey: 'not-uploaded' }],
        [{ ...candidate, addons: [] }],
        [{ ...candidate, email: 'invalid' }],
      ])
        await assert.rejects(repository.connectAccounts(firstAuth, { accounts }), {
          code: 'INVALID_INPUT',
        })
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 0)
    }
  )

  check(
    'numbered migrations are repeatable and changed/newer history fails closed',
    async ({ db }) => {
      await migrateManagedSchema(db)
      assert.equal(
        (await db.get('SELECT COUNT(*) AS count FROM managed_schema_migrations')).count,
        managedMigrations.length
      )
      await db.run('UPDATE managed_schema_migrations SET checksum = $1 WHERE version = 1', [
        'tampered',
      ])
      await assert.rejects(migrateManagedSchema(db), /history mismatch/)
    }
  )
  check('failed additive migrations roll back all DDL and their version record', async ({ db }) => {
    const migrations = [
      ...managedMigrations,
      {
        version: managedMigrations.length + 1,
        name: 'synthetic-failure',
        sql: 'CREATE TABLE synthetic_rolled_back (id TEXT); INSERT INTO missing_synthetic_table VALUES (1);',
      },
    ]
    await assert.rejects(migrateManagedSchema(db, migrations))
    assert.equal(
      (await db.get('SELECT COUNT(*) AS count FROM managed_schema_migrations')).count,
      managedMigrations.length
    )
    await assert.rejects(db.get('SELECT * FROM synthetic_rolled_back'))
    await db.run('INSERT INTO managed_schema_migrations VALUES ($1, $2, $3, 0)', [
      managedMigrations.length + 1,
      'future',
      'unknown',
    ])
    await assert.rejects(migrateManagedSchema(db), /Unsupported managed database schema/)
  })
  check(
    'wrapped index material fails with the wrong key and retains indexes across key rings',
    async ({ db, crypto }) => {
      const context = { owner: firstAuth.owner, id: 'email', purpose: 'lookup' }
      const fingerprint = crypto.fingerprint('person@example.invalid', context)
      await assert.rejects(initializeManagedCrypto(db, { primary: 'wrong' }), {
        code: 'DATA_UNREADABLE',
      })
      const rotated = await initializeManagedCrypto(db, {
        primary: 'new-key',
        candidates: [syntheticKey],
      })
      assert.equal(rotated.fingerprint('person@example.invalid', context), fingerprint)
      assert.notEqual(
        rotated.fingerprint('person@example.invalid', { ...context, owner: secondAuth.owner }),
        fingerprint
      )
    }
  )
  check(
    'missing key metadata over retained records never creates replacement indexes',
    async ({ db, repository }) => {
      await repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
      await db.run('DELETE FROM managed_metadata WHERE id = 1')
      await assert.rejects(initializeManagedCrypto(db, { primary: syntheticKey }), {
        code: 'DATA_UNREADABLE',
      })
      assert.equal(await db.get('SELECT * FROM managed_metadata'), undefined)
    }
  )
  check(
    'preview is authorized, password-free, and leaves no owner, accounts, jobs or rules',
    async ({ db, repository }) => {
      for (const auth of [
        { owner: 'absent', token: firstAuth.token },
        { ...firstAuth, token: 'wrong' },
        null,
      ]) {
        await assert.rejects(repository.previewImport(auth, parsedAccounts()), {
          code: 'UNAUTHORIZED',
        })
      }
      const preview = await repository.previewImport(firstAuth, parsedAccounts())
      assert.equal(preview.accounts[0].status, 'ready')
      assert.ok(!JSON.stringify(preview).includes('password'))
      for (const table of [
        'managed_owners',
        'managed_accounts',
        'managed_batches',
        'managed_jobs',
      ]) {
        assert.equal((await db.get(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0)
      }
    }
  )
  check(
    'staging persists only exact credentials with safe, inactive defaults',
    async ({ db, crypto, repository }) => {
      const parsed = parsedAccounts([
        {
          ...syntheticAccount,
          name: 'Ignore me',
          authKey: 'must-not-import',
          expiry: 1,
          addons: [{ url: 'https://secret.invalid' }],
          id: 'old-id',
        },
      ])
      const report = await repository.stageImport(firstAuth, parsed, randomUUID())
      assert.equal(report.created, 1)
      const row = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [
        report.accounts[0].id,
      ])
      assert.equal(row.state, 'staged')
      assert.equal(row.group_id, null)
      assert.equal(row.expiry_at, null)
      assert.equal(row.provider_key, null)
      assert.equal(row.provider_enc, null)
      assert.equal(row.safe_mode, null)
      assert.notEqual(row.id, 'old-id')
      const raw = JSON.stringify(row)
      for (const secret of [
        syntheticAccount.email,
        syntheticAccount.password,
        'must-not-import',
        'Ignore me',
        'secret.invalid',
      ])
        assert.ok(!raw.includes(secret))
      assert.deepEqual(
        crypto.open(row.credentials_enc, {
          owner: row.owner_id,
          id: row.id,
          purpose: 'credentials',
        }),
        { ...syntheticAccount, name: syntheticAccount.email }
      )
      assert.deepEqual(
        crypto.open(row.personal_enc, {
          owner: row.owner_id,
          id: row.id,
          purpose: 'personal-addons',
        }),
        []
      )
      assert.deepEqual(
        crypto.open(row.configuration_enc, {
          owner: row.owner_id,
          id: row.id,
          purpose: 'configuration',
        }),
        []
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      const status = await repository.status(firstAuth)
      assert.equal(status.writePaused, true)
      assert.equal(status.safeMode, true)
      assert.equal(status.capabilities.providerWrites, false)
    }
  )
  check(
    'concurrent repeated imports and ignored-addon changes create one durable batch',
    async ({ db, repository }) => {
      const reports = await Promise.all(
        Array.from({ length: 12 }, () =>
          repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
        )
      )
      assert.equal(new Set(reports.map((report) => report.batchId)).size, 1)
      assert.equal(reports.filter((report) => !report.replayed).length, 1)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 1)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_batches')).count, 1)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_audit')).count, 1)
      const changedIgnoredData = await repository.stageImport(
        firstAuth,
        parsedAccounts([{ ...syntheticAccount, addons: { malformed: true } }]),
        randomUUID()
      )
      assert.equal(changedIgnoredData.batchId, reports[0].batchId)
    }
  )
  check(
    'idempotency keys replay exactly and reject changed content without partial writes',
    async ({ db, repository }) => {
      const key = randomUUID()
      const original = await repository.stageImport(firstAuth, parsedAccounts(), key)
      const replay = await repository.stageImport(firstAuth, parsedAccounts(), key)
      assert.equal(replay.batchId, original.batchId)
      assert.equal(replay.replayed, true)
      await assert.rejects(
        repository.stageImport(
          firstAuth,
          parsedAccounts([{ email: 'different@example.invalid', password: 'changed' }]),
          key
        ),
        { code: 'IDEMPOTENCY_CONFLICT' }
      )
      await assert.rejects(repository.stageImport(firstAuth, parsedAccounts(), 'short'), {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
      })
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 1)
    }
  )
  check(
    'existing email conflicts cannot replace saved passwords or alter management',
    async ({ db, crypto, repository }) => {
      const original = await repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
      const changed = await repository.stageImport(
        firstAuth,
        parsedAccounts([{ email: 'person@EXAMPLE.invalid', password: 'replacement' }]),
        randomUUID()
      )
      assert.equal(changed.created, 0)
      assert.equal(changed.conflicts, 1)
      assert.equal(changed.issues[0].code, 'EXISTING_PASSWORD_CONFLICT')
      const row = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [
        original.accounts[0].id,
      ])
      assert.equal(
        crypto.open(row.credentials_enc, {
          owner: row.owner_id,
          id: row.id,
          purpose: 'credentials',
        }).password,
        syntheticAccount.password
      )
      const existing = await repository.stageImport(
        firstAuth,
        parseImportBody([syntheticAccount]),
        randomUUID()
      )
      assert.equal(existing.existing, 1)
      assert.equal(existing.accounts[0].id, row.id)
    }
  )
  check(
    '100 accounts reconcile with paginated password-free inventories',
    async ({ repository }, t) => {
      const start = performance.now()
      const accounts = Array.from({ length: 100 }, (_, index) => ({
        email: `client${index}@example.invalid`,
        password: `synthetic-${index}`,
      }))
      const report = await repository.stageImport(firstAuth, parsedAccounts(accounts), randomUUID())
      assert.equal(report.created, 100)
      const all = []
      let after = ''
      do {
        const page = await repository.listAccounts(firstAuth, { limit: 17, after })
        all.push(...page.accounts)
        after = page.nextCursor
      } while (after)
      assert.equal(new Set(all.map((row) => row.id)).size, 100)
      assert.ok(!JSON.stringify(all).includes('password'))
      assert.ok(!JSON.stringify(all).includes('synthetic-'))
      assert.equal((await repository.status(firstAuth)).accounts.staged, 100)
      t.diagnostic(
        `100-account staging plus inventory: ${Math.round(performance.now() - start)} ms (synthetic, not provider throughput)`
      )
    }
  )
  check(
    'ownership is enforced for account/batch reads and foreign-key references',
    async ({ db, repository }) => {
      const first = await repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
      const second = await repository.stageImport(secondAuth, parsedAccounts(), randomUUID())
      assert.notEqual(first.accounts[0].id, second.accounts[0].id)
      await assert.rejects(repository.getAccount(secondAuth, first.accounts[0].id), {
        code: 'NOT_FOUND',
      })
      await assert.rejects(repository.getBatch(secondAuth, first.batchId), { code: 'NOT_FOUND' })
      await assert.rejects(db.run('DELETE FROM kv_store WHERE key = $1', [firstAuth.owner]))
      await db.run(
        'INSERT INTO managed_groups (id, owner_id, name_enc, draft_enc, created_at, updated_at) VALUES ($1, $2, $3, $4, 0, 0)',
        ['other-group', secondAuth.owner, 'synthetic', 'synthetic']
      )
      await assert.rejects(
        db.run('UPDATE managed_accounts SET group_id = $1 WHERE id = $2', [
          'other-group',
          first.accounts[0].id,
        ])
      )
      await assert.rejects(
        db.run('UPDATE managed_accounts SET state = $1 WHERE id = $2', [
          'active',
          first.accounts[0].id,
        ])
      )
    }
  )
  check(
    'a late persistence failure rolls the entire staging operation back',
    async ({ db, repository }) => {
      const originalStatement = db.statement.bind(db)
      db.statement = (connection, method, sql, params) => {
        if (sql.startsWith('INSERT INTO managed_batches'))
          throw new Error('Synthetic storage fault')
        return originalStatement(connection, method, sql, params)
      }
      await assert.rejects(
        repository.stageImport(firstAuth, parsedAccounts(), randomUUID()),
        /Synthetic storage fault/
      )
      db.statement = originalStatement
      for (const table of [
        'managed_accounts',
        'managed_batches',
        'managed_idempotency',
        'managed_owners',
        'managed_audit',
      ]) {
        assert.equal((await db.get(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0)
      }
    }
  )
}
