import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { firstAuth, secondAuth, parsedAccounts } from './managed-contract.mjs'
import { prepareJobFixture } from './managed-job-contract.mjs'
import { migrateManagedSchema, managedMigrations } from '../server/managed/schema.js'

export function managedMembershipContract(prefix, options, fixture) {
  const check = (name, fn) =>
    test(`${prefix}: ${name}`, options, async (t) => fn(await fixture(t), t))

  check(
    'chosen timezone survives saves, replay and an equivalent-instant timezone edit',
    async ({ repository }) => {
      const id = (await repository.stageImport(firstAuth, parsedAccounts(), randomUUID()))
        .accounts[0].id
      const key = randomUUID()
      const input = {
        mode: 'term',
        local: '2027-01-01T12:00',
        timezone: 'Asia/Kathmandu',
        expectedVersion: 1,
      }
      const saved = await repository.setMembership(firstAuth, id, input, key)
      assert.equal(saved.account.expiry.timezone, 'Asia/Kathmandu')
      assert.equal(saved.account.expiry.offset, 345)
      assert.equal(saved.account.expiry.at, Date.parse('2027-01-01T06:15:00Z'))
      assert.equal((await repository.setMembership(firstAuth, id, input, key)).replayed, true)
      const changed = await repository.setMembership(
        firstAuth,
        id,
        {
          mode: 'term',
          local: '2027-01-01T06:15',
          timezone: 'UTC',
          expectedVersion: saved.account.version,
        },
        randomUUID()
      )
      assert.equal(changed.account.expiry.at, saved.account.expiry.at)
      assert.equal((await repository.getAccount(firstAuth, id)).expiry.timezone, 'UTC')
      await assert.rejects(
        repository.setMembership(
          firstAuth,
          id,
          { ...input, timezone: 'Bad/Timezone', expectedVersion: changed.account.version },
          randomUUID()
        ),
        { code: 'INVALID_TIMEZONE' }
      )
    }
  )

  test(
    `${prefix}: additive upgrade preserves existing dates and encrypted records without inventing lifetime`,
    options,
    async (t) => {
      const oldMigrations = managedMigrations.slice(0, 1)
      const { db, repository } = await fixture(t, { migrations: oldMigrations })
      const report = await repository.stageImport(
        firstAuth,
        parsedAccounts([
          { email: 'unset@example.invalid', password: 'synthetic-unset' },
          { email: 'dated@example.invalid', password: 'synthetic-dated' },
        ]),
        randomUUID()
      )
      const dated = report.accounts.find((row) => row.email === 'dated@example.invalid').id
      await db.run(
        "UPDATE managed_accounts SET expiry_at = $1, expiry_local = '2027-01-01T00:00', expiry_offset = -300, expiry_timezone = 'America/New_York' WHERE id = $2",
        [Date.parse('2027-01-01T05:00:00Z'), dated]
      )
      const before = await db.query('SELECT * FROM managed_accounts ORDER BY id')
      const history = await db.get('SELECT * FROM managed_schema_migrations WHERE version = 1')
      await migrateManagedSchema(db)
      assert.deepEqual(
        await db.query('SELECT * FROM managed_accounts ORDER BY id'),
        before.map((row) => ({
          ...row,
          lifetime: 0,
          suspended_at: null,
          expiry_zone: 'America/New_York',
          expiry_zone_offset: null,
          suspension_check_at: null,
          addon_overrides_enc: null,
          addons_initialized: 0,
        }))
      )
      assert.deepEqual(
        await db.get('SELECT * FROM managed_schema_migrations WHERE version = 1'),
        history
      )
      const accounts = (await repository.listAccounts(firstAuth)).accounts
      assert.equal(
        accounts.find((row) => row.email === 'unset@example.invalid').membershipType,
        'unset'
      )
      assert.equal(accounts.find((row) => row.id === dated).membershipType, 'term')
      await assert.rejects(
        migrateManagedSchema(db, oldMigrations),
        /Unsupported managed database schema/
      )
      await migrateManagedSchema(db)
    }
  )

  check(
    'missing imported dates stay unset; explicit lifetime is passive and survives reimport',
    async ({ db, repository }) => {
      const report = await repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
      const id = report.accounts[0].id
      assert.equal((await repository.getAccount(firstAuth, id)).membershipType, 'unset')
      const saved = await repository.setMembership(
        firstAuth,
        id,
        { mode: 'lifetime', expectedVersion: 1 },
        randomUUID()
      )
      assert.equal(saved.account.membershipType, 'lifetime')
      assert.equal(saved.account.expiry, null)
      assert.equal(saved.account.state, 'staged')
      assert.equal(saved.jobId, null)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      await repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
      assert.equal((await repository.getAccount(firstAuth, id)).membershipType, 'lifetime')
    }
  )
  check(
    'dated memberships store exact New York cutoff and require DST disambiguation',
    async ({ repository }) => {
      const id = (await repository.stageImport(firstAuth, parsedAccounts(), randomUUID()))
        .accounts[0].id
      await assert.rejects(
        repository.setMembership(
          firstAuth,
          id,
          { mode: 'term', local: '2026-03-08T02:30', expectedVersion: 1 },
          randomUUID()
        ),
        { code: 'NONEXISTENT_EXPIRY' }
      )
      await assert.rejects(
        repository.setMembership(
          firstAuth,
          id,
          { mode: 'term', local: '2026-11-01T01:30', expectedVersion: 1 },
          randomUUID()
        ),
        { code: 'AMBIGUOUS_EXPIRY' }
      )
      const result = await repository.setMembership(
        firstAuth,
        id,
        { mode: 'term', local: '2026-11-01T01:30', offset: -300, expectedVersion: 1 },
        randomUUID()
      )
      assert.equal(result.account.membershipType, 'term')
      assert.equal(result.account.expiry.at, Date.parse('2026-11-01T06:30:00Z'))
      assert.equal(result.account.expiry.local, '2026-11-01T01:30')
      assert.equal(result.account.expiry.offset, -300)
      assert.equal(result.jobId, null)
    }
  )
  check(
    'lifetime cannot retain a hidden stale deadline, even through direct SQL',
    async ({ db, repository }) => {
      const id = (await repository.stageImport(firstAuth, parsedAccounts(), randomUUID()))
        .accounts[0].id
      const term = await repository.setMembership(
        firstAuth,
        id,
        { mode: 'term', local: '2027-01-01T00:00', expectedVersion: 1 },
        randomUUID()
      )
      await assert.rejects(db.run('UPDATE managed_accounts SET lifetime = 1 WHERE id = $1', [id]))
      const lifetime = await repository.setMembership(
        firstAuth,
        id,
        { mode: 'lifetime', expectedVersion: term.account.version },
        randomUUID()
      )
      assert.equal(lifetime.account.expiry, null)
      const row = await db.get(
        'SELECT lifetime, expiry_at, expiry_local, expiry_offset, expiry_timezone FROM managed_accounts WHERE id = $1',
        [id]
      )
      assert.deepEqual(row, {
        lifetime: 1,
        expiry_at: null,
        expiry_local: null,
        expiry_offset: null,
        expiry_timezone: null,
      })
    }
  )
  check(
    'membership changes are scoped, versioned, idempotent, and no-op aware',
    async ({ db, repository }) => {
      const id = (await repository.stageImport(firstAuth, parsedAccounts(), randomUUID()))
        .accounts[0].id
      const key = randomUUID()
      const input = { mode: 'lifetime', expectedVersion: 1 }
      await assert.rejects(repository.setMembership(secondAuth, id, input, randomUUID()), {
        code: 'NOT_FOUND',
      })
      const saved = await repository.setMembership(firstAuth, id, input, key)
      const replayed = await repository.setMembership(firstAuth, id, input, key)
      assert.equal(replayed.replayed, true)
      assert.equal(replayed.account.version, saved.account.version)
      await assert.rejects(
        repository.setMembership(
          firstAuth,
          id,
          { mode: 'term', local: '2027-01-01T00:00', expectedVersion: saved.account.version },
          key
        ),
        { code: 'IDEMPOTENCY_CONFLICT' }
      )
      await assert.rejects(repository.setMembership(firstAuth, id, input, randomUUID()), {
        code: 'VERSION_CONFLICT',
      })
      const unchanged = await repository.setMembership(
        firstAuth,
        id,
        { ...input, expectedVersion: saved.account.version },
        randomUUID()
      )
      assert.equal(unchanged.account.version, saved.account.version)
      assert.equal(
        (
          await db.get(
            "SELECT COUNT(*) AS count FROM managed_audit WHERE event_type = 'membership.changed'"
          )
        ).count,
        1
      )
    }
  )
  check('simultaneous membership edits cannot lose the winning update', async ({ repository }) => {
    const id = (await repository.stageImport(firstAuth, parsedAccounts(), randomUUID())).accounts[0]
      .id
    const changes = await Promise.allSettled([
      repository.setMembership(
        firstAuth,
        id,
        { mode: 'lifetime', expectedVersion: 1 },
        randomUUID()
      ),
      repository.setMembership(
        firstAuth,
        id,
        { mode: 'term', local: '2027-01-01T00:00', expectedVersion: 1 },
        randomUUID()
      ),
    ])
    assert.equal(changes.filter((change) => change.status === 'fulfilled').length, 1)
    assert.equal(
      changes.find((change) => change.status === 'rejected').reason.code,
      'VERSION_CONFLICT'
    )
  })
  check(
    'an expired user renewed to lifetime supersedes in-flight disabling and retains configuration',
    async (storage) => {
      const { db, repository, jobs, ids, enqueue, expire } = await prepareJobFixture(storage)
      await expire()
      await enqueue()
      const disabling = await jobs.claim()
      const before = await db.get(
        'SELECT credentials_enc, personal_enc, configuration_enc, group_id FROM managed_accounts WHERE id = $1',
        [ids[0]]
      )
      const lifetime = await repository.setMembership(
        firstAuth,
        ids[0],
        {
          mode: 'lifetime',
          expectedVersion: (await repository.getAccount(firstAuth, ids[0])).version,
        },
        randomUUID()
      )
      assert.equal(lifetime.account.membershipType, 'lifetime')
      assert.ok(lifetime.jobId)
      assert.equal(
        (await jobs.completeVerified(disabling, { expected: [], observed: [] })).state,
        'superseded'
      )
      const renewing = await jobs.claim()
      assert.equal(renewing.target, 'active')
      assert.equal(renewing.cause, 'renewal')
      const after = await db.get(
        'SELECT credentials_enc, personal_enc, configuration_enc, group_id FROM managed_accounts WHERE id = $1',
        [ids[0]]
      )
      assert.deepEqual(after, before)
    }
  )
  check(
    'lifetime users still receive normal group work and can move back to dated membership',
    async (storage) => {
      const { repository, jobs, ids, advance } = await prepareJobFixture(storage)
      const lifetime = await repository.setMembership(
        firstAuth,
        ids[0],
        { mode: 'lifetime', expectedVersion: 1 },
        randomUUID()
      )
      advance(100 * 366 * 24 * 60 * 60 * 1000)
      const syncing = await jobs.claim()
      assert.equal(syncing.target, 'active')
      await jobs.completeVerified(syncing, { expected: [], observed: [] })
      const term = await repository.setMembership(
        firstAuth,
        ids[0],
        { mode: 'term', local: '2027-01-01T00:00', expectedVersion: lifetime.account.version },
        randomUUID()
      )
      assert.equal(term.account.membershipType, 'term')
      assert.equal((await jobs.claim()).target, 'suspended')
    }
  )
  check('offboarding cannot be cancelled by changing membership', async (storage) => {
    const { db, repository, ids } = await prepareJobFixture(storage)
    await db.run("UPDATE managed_accounts SET state = 'offboarding' WHERE id = $1", [ids[0]])
    await assert.rejects(
      repository.setMembership(
        firstAuth,
        ids[0],
        { mode: 'lifetime', expectedVersion: 1 },
        randomUUID()
      ),
      { code: 'INVALID_STATE' }
    )
  })
  check(
    'a late failure rolls back membership, queued work, audit and retry record together',
    async (storage) => {
      const { db, repository, ids } = await prepareJobFixture(storage)
      const id = ids[0]
      const before = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [id])
      const key = randomUUID()
      const original = db.statement.bind(db)
      db.statement = (connection, method, sql, params) => {
        if (
          sql.startsWith('INSERT INTO managed_idempotency') &&
          params[1] === 'accounts.membership'
        )
          throw new Error('synthetic late failure')
        return original(connection, method, sql, params)
      }
      try {
        await assert.rejects(
          repository.setMembership(firstAuth, id, { mode: 'lifetime', expectedVersion: 1 }, key),
          /synthetic late failure/
        )
      } finally {
        db.statement = original
      }
      assert.deepEqual(await db.get('SELECT * FROM managed_accounts WHERE id = $1', [id]), before)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      assert.equal(
        (
          await db.get(
            "SELECT COUNT(*) AS count FROM managed_audit WHERE event_type = 'membership.changed'"
          )
        ).count,
        0
      )
      assert.equal(
        (
          await db.get(
            "SELECT COUNT(*) AS count FROM managed_idempotency WHERE scope = 'accounts.membership'"
          )
        ).count,
        0
      )
      assert.equal(
        (
          await repository.setMembership(
            firstAuth,
            id,
            { mode: 'lifetime', expectedVersion: 1 },
            key
          )
        ).account.membershipType,
        'lifetime'
      )
    }
  )
}
