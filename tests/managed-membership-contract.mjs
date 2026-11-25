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
    'one-click annual renewals use each paid-through date or local today and replay once',
    async ({ repository, advance, now }) => {
      advance(Date.parse('2028-03-01T01:00:00Z') - now())
      const { accounts } = await repository.stageImport(
        firstAuth,
        parsedAccounts([
          { email: 'new@example.invalid', password: 'synthetic' },
          { email: 'early@example.invalid', password: 'synthetic' },
          { email: 'late@example.invalid', password: 'synthetic' },
        ]),
        randomUUID()
      )
      const byEmail = (email) => accounts.find((row) => row.email === email).id
      const fresh = byEmail('new@example.invalid')
      const key = randomUUID()
      const annual = { mode: 'add-year', expectedVersion: 1 }
      const added = await repository.setMembership(firstAuth, fresh, annual, key)
      assert.equal(added.account.expiry.local, '2029-02-28')
      assert.equal(added.account.expiry.at, Date.parse('2029-03-01T05:00:00Z'))
      assert.equal(added.jobId, null)
      const setTerm = (email, local, timezone) =>
        repository.setMembership(
          firstAuth,
          byEmail(email),
          { mode: 'term', expectedVersion: 1, local, timezone },
          randomUUID()
        )
      const early = await setTerm('early@example.invalid', '2028-06-30', 'Asia/Kathmandu')
      const late = await setTerm('late@example.invalid', '2026-10-10', 'Asia/Tokyo')
      const bulk = await repository.setAccountsMembership(
        firstAuth,
        {
          accounts: [early, late].map(({ account }) => ({
            id: account.id,
            expectedVersion: account.version,
          })),
          membership: { mode: 'add-year' },
        },
        randomUUID()
      )
      const expiryOf = (id) => bulk.accounts.find((row) => row.account.id === id).account.expiry
      assert.equal(expiryOf(early.account.id).local, '2029-06-30')
      assert.equal(expiryOf(late.account.id).local, '2029-02-28')
      assert.equal(expiryOf(early.account.id).timezone, 'America/New_York')
      advance(86_400_000)
      assert.equal((await repository.setMembership(firstAuth, fresh, annual, key)).replayed, true)
      assert.equal((await repository.getAccount(firstAuth, fresh)).version, added.account.version)
      await assert.rejects(repository.setMembership(firstAuth, fresh, annual, randomUUID()), {
        code: 'VERSION_CONFLICT',
      })
      const lifetime = await repository.setMembership(
        firstAuth,
        fresh,
        { mode: 'lifetime', expectedVersion: added.account.version },
        randomUUID()
      )
      await assert.rejects(
        repository.setMembership(
          firstAuth,
          fresh,
          { ...annual, expectedVersion: lifetime.account.version },
          randomUUID()
        ),
        { code: 'INVALID_STATE' }
      )
    }
  )

  test(
    `${prefix}: timezone upgrade and settings changes preserve paid dates and reconcile access`,
    options,
    async (t) => {
      const { repository, db, ids, now, advance } = await prepareJobFixture(
        await fixture(t, { migrations: managedMigrations.slice(0, 12) })
      )
      const other = (await repository.stageImport(secondAuth, parsedAccounts(), randomUUID()))
        .accounts[0]
      const utc = Date.parse('2027-01-02T00:00:00Z')
      advance(utc + 3600000 - now())
      await db.run(
        `UPDATE managed_accounts SET expiry_local = '2027-01-01', expiry_zone = 'UTC',
      expiry_offset = 0, expiry_zone_offset = 0, expiry_timezone = 'America/New_York', expiry_at = $1`,
        [utc]
      )
      await db.run(
        "UPDATE managed_accounts SET expiry_zone = 'America/New_York', expiry_at = $1 WHERE id = $2",
        [utc + 5 * 3600000, ids[1]]
      )
      await db.run("UPDATE managed_accounts SET access_override = 'active' WHERE id = $1", [ids[2]])
      await migrateManagedSchema(db, managedMigrations, now())
      assert.equal((await repository.status(firstAuth)).membershipTimezone, 'America/New_York')
      assert.equal((await repository.status(secondAuth)).membershipTimezone, 'UTC')
      assert.equal((await repository.getAccount(secondAuth, other.id)).expiry.at, utc)
      assert.deepEqual(await db.query('SELECT account_id, cause FROM managed_jobs'), [
        { account_id: ids[0], cause: 'renewal' },
      ])
      await repository.setSettings(
        firstAuth,
        { expectedVersion: 1, membershipTimezone: 'UTC' },
        randomUUID()
      )
      const updated = await repository.getAccount(firstAuth, ids[0])
      assert.equal(updated.expiry.local, '2027-01-01')
      assert.equal(updated.expired, true)
      assert.equal((await repository.getAccount(firstAuth, ids[2])).accessOverride, 'active')
      assert.equal(
        (await db.get("SELECT COUNT(*) AS count FROM managed_jobs WHERE cause = 'expiry'")).count,
        2
      )
    }
  )

  test(
    `${prefix}: upgrading restores today's automatic expiry once and honors overrides`,
    options,
    async (t) => {
      const { db, jobs, ids, now, advance } = await prepareJobFixture(
        await fixture(t, { migrations: managedMigrations.slice(0, 11) })
      )
      const noon = Date.parse('2026-11-01T17:00:00Z')
      advance(noon - now())
      const old = Date.parse('2026-11-01T05:00:00Z')
      const end = Date.parse('2026-11-02T05:00:00Z')
      await db.run(
        `UPDATE managed_accounts SET expiry_local = '2026-11-01T01:00', expiry_at = $1,
      expiry_offset = -240, expiry_timezone = 'America/New_York', suspended_at = $1`,
        [old]
      )
      await db.run("UPDATE managed_accounts SET access_override = 'suspended' WHERE id = $1", [
        ids[1],
      ])
      await db.run("UPDATE managed_accounts SET access_override = 'active' WHERE id = $1", [ids[2]])
      await migrateManagedSchema(db, managedMigrations, noon)
      await migrateManagedSchema(db, managedMigrations, noon)
      for (const [i, id] of ids.entries()) {
        const row = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [id])
        assert.equal(row.expiry_local, '2026-11-01')
        assert.equal(row.expiry_at, end)
        assert.equal(row.suspended_at, i === 0 ? null : old)
        assert.equal(row.policy_version, i === 0 ? 2 : 1)
      }
      assert.deepEqual(await db.query('SELECT account_id, cause, target FROM managed_jobs'), [
        { account_id: ids[0], cause: 'renewal', target: 'active' },
      ])
      advance(end - 1 - now())
      assert.equal(await jobs.scanExpiry(), 0)
      advance(1)
      assert.equal(await jobs.scanExpiry(), 1)
      assert.ok(
        await db.get("SELECT id FROM managed_jobs WHERE account_id = $1 AND target = 'suspended'", [
          ids[0],
        ])
      )
    }
  )

  check(
    'one admin timezone controls existing and new dates, annual conversions, bulk requests and retries',
    async ({ repository, advance, now }) => {
      const setZone = (expectedVersion, membershipTimezone, key = randomUUID()) =>
        repository.setSettings(firstAuth, { expectedVersion, membershipTimezone }, key)
      const local = '2027-01-01'
      const staged = async (auth) =>
        (await repository.stageImport(auth, parsedAccounts(), randomUUID())).accounts[0].id
      const id = await staged(firstAuth)
      const other = await staged(secondAuth)
      const term = { mode: 'term', local, expectedVersion: 1, timezone: 'Asia/Tokyo' }
      const key = randomUUID()
      const original = await repository.setMembership(firstAuth, id, term, key)
      await repository.setMembership(secondAuth, other, term, randomUUID())
      assert.equal(original.account.expiry.timezone, 'America/New_York')
      const settingKey = randomUUID()
      await setZone(1, 'Asia/Kathmandu', settingKey)
      assert.equal((await setZone(1, 'Asia/Kathmandu', settingKey)).replayed, true)
      const revised = await repository.getAccount(firstAuth, id)
      assert.equal(revised.expiry.local, local)
      assert.equal(revised.expiry.at, Date.parse('2027-01-01T18:15:00Z'))
      assert.equal(revised.version, original.account.version + 1)
      assert.equal((await repository.setMembership(firstAuth, id, term, key)).replayed, true)
      assert.equal(
        (await repository.getAccount(secondAuth, other)).expiry.timezone,
        'America/New_York'
      )
      assert.equal((await repository.status(firstAuth)).membershipTimezone, 'Asia/Kathmandu')
      await assert.rejects(setZone(1, 'UTC'), { code: 'VERSION_CONFLICT' })
      await assert.rejects(setZone(2, 'Bad/Zone'), { code: 'INVALID_TIMEZONE' })
      const lifetime = await repository.setMembership(
        firstAuth,
        id,
        { mode: 'lifetime', expectedVersion: revised.version },
        randomUUID()
      )
      advance(Date.parse('2028-02-29T19:00:00Z') - now())
      const converted = await repository.setMembership(
        firstAuth,
        id,
        { mode: 'start-year', expectedVersion: lifetime.account.version },
        randomUUID()
      )
      assert.equal(converted.account.expiry.local, '2029-03-01')
      const bulk = await repository.setAccountsMembership(
        firstAuth,
        {
          accounts: [{ id, expectedVersion: converted.account.version }],
          membership: { mode: 'add-year' },
        },
        randomUUID()
      )
      assert.equal(bulk.accounts[0].account.expiry.local, '2030-03-01')
      assert.equal(bulk.accounts[0].account.expiry.timezone, 'Asia/Kathmandu')
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
      const upgradeTime = Date.parse('2026-11-22T16:00:00Z')
      await migrateManagedSchema(db, managedMigrations, upgradeTime)
      assert.deepEqual(
        await db.query('SELECT * FROM managed_accounts ORDER BY id'),
        before.map((row) => ({
          ...row,
          lifetime: 0,
          suspended_at: null,
          expiry_zone: 'America/New_York',
          expiry_zone_offset: row.id === dated ? -300 * 60 : null,
          ...(row.id === dated && {
            expiry_local: '2027-01-01',
            expiry_at: Date.parse('2027-01-02T05:00:00Z'),
            record_version: row.record_version + 1,
            updated_at: upgradeTime,
          }),
          suspension_check_at: null,
          addon_overrides_enc: null,
          addons_initialized: 0,
          access_override: 'automatic',
          group_sync_requested: 0,
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
    'legacy date-time requests retain validation and expire at the end of the selected date',
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
      assert.equal(result.account.expiry.at, Date.parse('2026-11-02T05:00:00Z'))
      assert.equal(result.account.expiry.local, '2026-11-01')
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
    'manual override is owner scoped, replay safe and invalidates an in-flight expiry',
    async (storage) => {
      const { repository, jobs, ids, expire, enqueue } = await prepareJobFixture(storage)
      const id = ids[0]
      await expire(id)
      await enqueue()
      const disabling = await jobs.claim()
      const before = await repository.getAccount(firstAuth, id)
      const input = { expectedVersion: before.version, override: 'active' }
      const key = randomUUID()
      await assert.rejects(repository.setAccessOverride(secondAuth, id, input, key), {
        code: 'NOT_FOUND',
      })
      const saved = await repository.setAccessOverride(firstAuth, id, input, key)
      assert.deepEqual(saved.account.expiry, before.expiry)
      assert.equal(saved.account.suspendedAt, null)
      assert.equal((await repository.setAccessOverride(firstAuth, id, input, key)).replayed, true)
      await assert.rejects(repository.setAccessOverride(firstAuth, id, input, randomUUID()), {
        code: 'VERSION_CONFLICT',
      })
      assert.equal(
        (await jobs.completeVerified(disabling, { expected: [], observed: [] })).state,
        'superseded'
      )
      assert.equal((await jobs.claim()).target, 'active')
      const unchanged = await repository.setAccessOverride(
        firstAuth,
        id,
        { ...input, expectedVersion: saved.account.version },
        randomUUID()
      )
      assert.equal(unchanged.jobId, null)
      assert.equal(unchanged.account.version, saved.account.version)
      const renewed = await repository.setMembership(
        firstAuth,
        id,
        { mode: 'lifetime', expectedVersion: saved.account.version },
        randomUUID()
      )
      assert.equal(renewed.account.accessOverride, 'active')
      const follow = await repository.setAccessOverride(
        firstAuth,
        id,
        { override: 'automatic', expectedVersion: renewed.account.version },
        randomUUID()
      )
      assert.equal(follow.account.expired, false)
    }
  )
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
