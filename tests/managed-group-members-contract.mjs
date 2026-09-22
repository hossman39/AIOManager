import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createManagedRepository } from '../server/managed/repository.js'
import { firstAuth, secondAuth, syntheticKey } from './managed-contract.mjs'
import { prepareGroupFixture } from './managed-groups-contract.mjs'

async function prepareMembers(storage) {
  const repository = createManagedRepository({
    ...storage,
    legacyKeys: [syntheticKey],
    runtime: { enabled: true },
  })
  const seeded = await prepareGroupFixture({ ...storage, repository })
  seeded.group = (
    await repository.saveGroupDraft(
      firstAuth,
      seeded.group.id,
      {
        expectedVersion: seeded.group.version,
        name: seeded.group.name,
        safeMode: null,
        addons: seeded.group.draft.map((addon) => ({
          ...addon,
          flags: { ...addon.flags, enabled: true },
        })),
      },
      randomUUID()
    )
  ).group
  await seeded.publishFixture(seeded.group)
  await repository.assignGroup(
    firstAuth,
    {
      groupId: seeded.group.id,
      accounts: seeded.accounts.map(({ id }) => ({ id, expectedVersion: 1 })),
    },
    randomUUID()
  )
  await seeded.activateFixture(seeded.accounts[0].id)
  await seeded.activateFixture(seeded.accounts[1].id)
  const members = await Promise.all(
    seeded.accounts.map(({ id }) => repository.getAccount(firstAuth, id))
  )
  return {
    ...seeded,
    members,
    selection: members.map(({ id, version }) => ({ id, expectedVersion: version })),
  }
}

const stored = (db) =>
  Promise.all(
    ['managed_accounts', 'managed_jobs', 'managed_audit', 'managed_idempotency'].map(
      async (table) =>
        (await db.query(`SELECT * FROM ${table}`)).map((row) => JSON.stringify(row)).sort()
    )
  )

export function managedGroupMembersContract(prefix, options, fixture) {
  const check = (name, run) =>
    test(`${prefix}: ${name}`, options, async (t) => run(await prepareMembers(await fixture(t)), t))

  check(
    'bulk membership preserves the chosen timezone and only queues started accounts',
    async ({ repository, db, group, selection, members }) => {
      const before = await db.query(
        'SELECT id, credentials_enc, personal_enc, group_id FROM managed_accounts ORDER BY id'
      )
      const result = await repository.setGroupMembership(
        firstAuth,
        group.id,
        {
          accounts: selection,
          membership: { mode: 'term', local: '2027-01-01T12:00', timezone: 'Asia/Kathmandu' },
        },
        randomUUID()
      )
      assert.equal(result.accounts.length, 3)
      assert.equal(result.accounts.filter((entry) => entry.jobId).length, 2)
      for (const { account } of result.accounts) {
        assert.equal(account.expiry.timezone, 'Asia/Kathmandu')
        assert.equal(account.expiry.at, Date.parse('2027-01-01T06:15:00Z'))
        assert.equal(account.version, 3)
        assert.equal(account.state, members.find((item) => item.id === account.id).state)
      }
      assert.deepEqual(
        await db.query(
          'SELECT id, credentials_enc, personal_enc, group_id FROM managed_accounts ORDER BY id'
        ),
        before
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 2)
    }
  )

  check(
    'stale, moved, foreign, offboarding, and oversized selections cannot partially update membership',
    async ({ repository, db, group, selection }) => {
      const before = await stored(db)
      const membership = { mode: 'lifetime' }
      await assert.rejects(
        repository.setGroupMembership(
          secondAuth,
          group.id,
          { accounts: selection, membership },
          randomUUID()
        ),
        { code: 'NOT_FOUND' }
      )
      for (const accounts of [
        [],
        [selection[0], selection[0]],
        Array.from({ length: 201 }, () => ({ id: randomUUID(), expectedVersion: 1 })),
      ])
        await assert.rejects(
          repository.setGroupMembership(
            firstAuth,
            group.id,
            { accounts, membership },
            randomUUID()
          ),
          { code: 'INVALID_INPUT' }
        )
      await assert.rejects(
        repository.setGroupMembership(
          firstAuth,
          group.id,
          {
            accounts: selection.map((entry, index) =>
              index === 2 ? { ...entry, expectedVersion: 99 } : entry
            ),
            membership,
          },
          randomUUID()
        ),
        { code: 'VERSION_CONFLICT' }
      )
      assert.deepEqual(await stored(db), before)
      await db.run('UPDATE managed_accounts SET group_id = NULL WHERE id = $1', [selection[2].id])
      const moved = await stored(db)
      await assert.rejects(
        repository.setGroupMembership(
          firstAuth,
          group.id,
          { accounts: selection, membership },
          randomUUID()
        ),
        { code: 'VERSION_CONFLICT' }
      )
      assert.deepEqual(await stored(db), moved)
      await db.run(
        "UPDATE managed_accounts SET group_id = $1, state = 'offboarding', provider_key = 'synthetic-offboarding', provider_enc = 'synthetic' WHERE id = $2",
        [group.id, selection[2].id]
      )
      const offboarding = await stored(db)
      await assert.rejects(
        repository.setGroupMembership(
          firstAuth,
          group.id,
          { accounts: selection, membership },
          randomUUID()
        ),
        { code: 'INVALID_STATE' }
      )
      assert.deepEqual(await stored(db), offboarding)
    }
  )

  check(
    'DST gaps and ambiguous times fail before bulk changes, and an explicit occurrence is retained',
    async ({ repository, db, group, selection }) => {
      const before = await stored(db)
      const request = {
        accounts: selection,
        membership: { mode: 'term', local: '2027-03-14T02:30', timezone: 'America/New_York' },
      }
      await assert.rejects(
        repository.setGroupMembership(firstAuth, group.id, request, randomUUID()),
        { code: 'NONEXISTENT_EXPIRY' }
      )
      request.membership.local = '2027-11-07T01:30'
      await assert.rejects(
        repository.setGroupMembership(firstAuth, group.id, request, randomUUID()),
        { code: 'AMBIGUOUS_EXPIRY' }
      )
      assert.deepEqual(await stored(db), before)
      const result = await repository.setGroupMembership(
        firstAuth,
        group.id,
        { ...request, membership: { ...request.membership, offset: -300 } },
        randomUUID()
      )
      for (const { account } of result.accounts)
        assert.equal(account.expiry.at, Date.parse('2027-11-07T06:30:00Z'))
    }
  )

  check(
    'bulk membership rolls back all members, jobs, and audit after a late failure',
    async ({ repository, db, group, selection }) => {
      const before = await stored(db)
      const original = db.statement.bind(db)
      db.statement = (connection, method, sql, params) => {
        if (sql.startsWith('INSERT INTO managed_idempotency') && params[1] === 'groups.membership')
          throw new Error('Synthetic bulk commit failure')
        return original(connection, method, sql, params)
      }
      const request = { accounts: selection, membership: { mode: 'lifetime' } },
        key = randomUUID()
      try {
        await assert.rejects(
          repository.setGroupMembership(firstAuth, group.id, request, key),
          /Synthetic bulk commit failure/
        )
      } finally {
        db.statement = original
      }
      assert.deepEqual(await stored(db), before)
      assert.equal(
        (await repository.setGroupMembership(firstAuth, group.id, request, key)).accounts.length,
        3
      )
    }
  )

  check(
    'concurrent retries share one bulk membership change and reject a different selection',
    async ({ repository, db, group, selection }) => {
      const request = { accounts: selection, membership: { mode: 'lifetime' } },
        key = randomUUID()
      const results = await Promise.all([
        repository.setGroupMembership(firstAuth, group.id, request, key),
        repository.setGroupMembership(
          firstAuth,
          group.id,
          { ...request, accounts: [...selection].reverse() },
          key
        ),
      ])
      assert.equal(results.filter((result) => !result.replayed).length, 1)
      const before = await stored(db)
      assert.equal(
        (await repository.setGroupMembership(firstAuth, group.id, request, key)).replayed,
        true
      )
      await assert.rejects(
        repository.setGroupMembership(
          firstAuth,
          group.id,
          { ...request, accounts: selection.slice(0, 1) },
          key
        ),
        { code: 'IDEMPOTENCY_CONFLICT' }
      )
      assert.deepEqual(await stored(db), before)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 2)
    }
  )

  check(
    'bulk sync retains expiry targets, rejects inactive selections, and replays once',
    async ({ repository, db, group, selection }) => {
      await db.run(
        "UPDATE managed_accounts SET expiry_at = 1, expiry_local = '1970-01-01T00:00', expiry_offset = -300, expiry_timezone = 'America/New_York' WHERE id = $1",
        [selection[0].id]
      )
      const before = await stored(db)
      await assert.rejects(
        repository.requestGroupSync(firstAuth, group.id, { accounts: selection }, randomUUID()),
        { code: 'INVALID_STATE' }
      )
      assert.deepEqual(await stored(db), before)
      const request = { accounts: selection.slice(0, 2) },
        key = randomUUID()
      const result = await repository.requestGroupSync(firstAuth, group.id, request, key)
      assert.equal(result.accounts.length, 2)
      assert.ok(result.accounts.every((entry) => entry.jobId && entry.account.state === 'active'))
      assert.deepEqual(
        (await db.query('SELECT target FROM managed_jobs ORDER BY target')).map(
          (row) => row.target
        ),
        ['active', 'suspended']
      )
      assert.equal(
        (await repository.requestGroupSync(firstAuth, group.id, request, key)).replayed,
        true
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 2)
    }
  )

  check(
    'bulk moves and removals are fenced to the source group and preserve individual setups',
    async ({ repository, db, group, selection }) => {
      const before = await Promise.all(
        selection.map(({ id }) => repository.getAccountAddons(firstAuth, id))
      )
      await db.run('UPDATE managed_accounts SET group_id = NULL WHERE id = $1', [selection[2].id])
      const moved = await stored(db)
      const request = {
          sourceGroupId: group.id,
          groupId: null,
          useGroupAddons: true,
          accounts: selection,
        },
        key = randomUUID()
      await assert.rejects(repository.assignGroup(firstAuth, request, key), {
        code: 'VERSION_CONFLICT',
      })
      assert.deepEqual(await stored(db), moved)
      await db.run('UPDATE managed_accounts SET group_id = $1 WHERE id = $2', [
        group.id,
        selection[2].id,
      ])
      const result = await repository.assignGroup(firstAuth, request, key)
      assert.ok(result.accounts.every((entry) => entry.account.groupId === null))
      const after = await Promise.all(
        selection.map(({ id }) => repository.getAccountAddons(firstAuth, id))
      )
      assert.deepEqual(
        after.map((setup) => setup.addons),
        before.map((setup) => setup.addons)
      )
      assert.equal((await repository.assignGroup(firstAuth, request, key)).replayed, true)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 2)
    }
  )
}
