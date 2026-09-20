import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { firstAuth, secondAuth, parsedAccounts } from './managed-contract.mjs'
import { configuredAddon } from './fixtures/addon-config.mjs'

export async function prepareGroupFixture(storage, count = 3) {
  const { db, repository, crypto, now } = storage
  const accounts = (
    await repository.stageImport(
      firstAuth,
      parsedAccounts(
        Array.from({ length: count }, (_, index) => ({
          email: `group-${index}@example.invalid`,
          password: 'synthetic-group-only',
        }))
      ),
      randomUUID()
    )
  ).accounts
  const group = (
    await repository.createGroup(
      firstAuth,
      { name: 'Synthetic private group', addons: [configuredAddon()] },
      randomUUID()
    )
  ).group
  // Internal simulated enrollment/publication only. These helpers perform no IO.
  const publishFixture = async (target = group) => {
    await db.run(
      'INSERT INTO managed_group_revisions (owner_id, group_id, revision, config_enc, payload_digest, explicit_empty, published_at) VALUES ($1, $2, 1, $3, $4, 0, $5)',
      [
        firstAuth.owner,
        target.id,
        crypto.seal(target.draft, {
          owner: firstAuth.owner,
          id: target.id,
          purpose: 'group-revision:1',
        }),
        crypto.fingerprint(target.draft, {
          owner: firstAuth.owner,
          id: target.id,
          purpose: 'group-payload',
        }),
        now(),
      ]
    )
    await db.run('UPDATE managed_groups SET published_revision = 1 WHERE id = $1', [target.id])
  }
  const activateFixture = async (id = accounts[0].id) => {
    await db.run(
      "UPDATE managed_accounts SET state = 'active', provider_key = $1, provider_enc = 'synthetic-enrollment', group_id = $2 WHERE id = $3",
      [`synthetic-subject-${id}`, group.id, id]
    )
  }
  return { ...storage, group, accounts, publishFixture, activateFixture }
}

export function managedGroupsContract(prefix, options, fixture) {
  const check = (name, fn) =>
    test(`${prefix}: ${name}`, options, async (t) => fn(await fixture(t), t))

  check(
    'draft creation is encrypted, retry-safe, safe by default and job-free',
    async ({ db, repository, crypto }) => {
      const key = randomUUID()
      const input = { name: 'Private customer group', addons: [configuredAddon()] }
      const created = await repository.createGroup(firstAuth, input, key)
      const again = await repository.createGroup(firstAuth, input, key)
      assert.equal(again.group.id, created.group.id)
      assert.equal(again.replayed, true)
      assert.equal(created.group.effectiveSafeMode, true)
      assert.equal(created.group.safeMode, null)
      assert.equal(created.group.publishedRevision, null)
      assert.deepEqual(created.group.draft, input.addons)
      const row = await db.get('SELECT * FROM managed_groups WHERE id = $1', [created.group.id])
      assert.ok(!JSON.stringify(row).includes(input.name))
      assert.ok(!JSON.stringify(row).includes('GroupToken'))
      assert.throws(
        () =>
          crypto.open(row.draft_enc, {
            owner: secondAuth.owner,
            id: row.id,
            purpose: 'group-draft',
          }),
        { code: 'DATA_UNREADABLE' }
      )
      const inventory = await repository.listGroups(firstAuth)
      assert.equal(inventory.groups[0].addonCount, 1)
      assert.ok(!JSON.stringify(inventory).includes('GroupToken'))
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
    }
  )

  check(
    'draft edits are versioned and cannot change published configuration or queue work',
    async (storage) => {
      const { db, repository, group, publishFixture } = await prepareGroupFixture(storage)
      await publishFixture()
      const before = await db.get('SELECT * FROM managed_group_revisions WHERE group_id = $1', [
        group.id,
      ])
      const input = {
        expectedVersion: 1,
        name: 'Edited draft',
        addons: [configuredAddon('NewDraftToken')],
        safeMode: false,
      }
      const key = randomUUID()
      const result = await repository.saveGroupDraft(firstAuth, group.id, input, key)
      assert.equal(result.group.version, 2)
      assert.equal(result.group.publishedRevision, 1)
      assert.equal(result.group.effectiveSafeMode, false)
      assert.equal(
        (await repository.saveGroupDraft(firstAuth, group.id, input, key)).replayed,
        true
      )
      await assert.rejects(repository.saveGroupDraft(firstAuth, group.id, input, randomUUID()), {
        code: 'VERSION_CONFLICT',
      })
      const noChange = await repository.saveGroupDraft(
        firstAuth,
        group.id,
        { ...input, expectedVersion: 2 },
        randomUUID()
      )
      assert.equal(noChange.group.version, 2)
      assert.deepEqual(
        await db.get('SELECT * FROM managed_group_revisions WHERE group_id = $1', [group.id]),
        before
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
    }
  )

  check('group, personal and assignment operations reject another owner', async (storage) => {
    const { repository, accounts, group } = await prepareGroupFixture(storage)
    assert.deepEqual((await repository.listGroups(secondAuth)).groups, [])
    await assert.rejects(repository.getGroup(secondAuth, group.id), { code: 'NOT_FOUND' })
    await assert.rejects(
      repository.saveGroupDraft(
        secondAuth,
        group.id,
        { expectedVersion: 1, name: 'Other', addons: [], safeMode: null },
        randomUUID()
      ),
      { code: 'NOT_FOUND' }
    )
    await assert.rejects(repository.getPersonalAddons(secondAuth, accounts[0].id), {
      code: 'NOT_FOUND',
    })
    await assert.rejects(
      repository.setPersonalAddons(
        secondAuth,
        accounts[0].id,
        { expectedVersion: 1, addons: [] },
        randomUUID()
      ),
      { code: 'NOT_FOUND' }
    )
    await assert.rejects(
      repository.assignGroup(
        secondAuth,
        { groupId: group.id, accounts: [{ id: accounts[0].id, expectedVersion: 1 }] },
        randomUUID()
      ),
      { code: 'NOT_FOUND' }
    )
  })

  check(
    '100-user staging assignment is atomic, idempotent and never activates users',
    async (storage, t) => {
      const { repository, db, accounts, group } = await prepareGroupFixture(storage, 100)
      const before = await db.query(
        'SELECT id, credentials_enc, configuration_enc FROM managed_accounts ORDER BY id'
      )
      const key = randomUUID()
      const input = {
        groupId: group.id,
        accounts: accounts.map(({ id }) => ({ id, expectedVersion: 1 })),
      }
      const started = performance.now()
      const assigned = await repository.assignGroup(firstAuth, input, key)
      t.diagnostic(
        `100-user passive assignment: ${Math.round(performance.now() - started)} ms (synthetic; not provider throughput)`
      )
      assert.equal(assigned.accounts.length, 100)
      for (const { account, jobId } of assigned.accounts) {
        assert.equal(account.state, 'staged')
        assert.equal(account.groupId, group.id)
        assert.equal(account.version, 2)
        assert.equal(jobId, null)
      }
      assert.equal((await repository.assignGroup(firstAuth, input, key)).replayed, true)
      assert.deepEqual(
        await db.query(
          'SELECT id, credentials_enc, configuration_enc FROM managed_accounts ORDER BY id'
        ),
        before
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
    }
  )

  check('one stale member aborts the entire bulk assignment', async (storage) => {
    const { db, repository, group, accounts } = await prepareGroupFixture(storage)
    const members = accounts
      .map(({ id }) => ({ id, expectedVersion: 1 }))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    members[members.length - 1].expectedVersion = 99
    await assert.rejects(
      repository.assignGroup(firstAuth, { groupId: group.id, accounts: members }, randomUUID()),
      { code: 'VERSION_CONFLICT' }
    )
    assert.equal(
      (await db.get('SELECT COUNT(*) AS count FROM managed_accounts WHERE group_id IS NOT NULL'))
        .count,
      0
    )
    assert.equal(
      (await db.get('SELECT COUNT(*) AS count FROM managed_accounts WHERE record_version <> 1'))
        .count,
      0
    )
  })

  check(
    'personal addons retain all customization and resolve exact URL conflicts explicitly',
    async (storage) => {
      const { db, repository, group, accounts } = await prepareGroupFixture(storage)
      const id = accounts[0].id
      await repository.assignGroup(
        firstAuth,
        { groupId: group.id, accounts: [{ id, expectedVersion: 1 }] },
        randomUUID()
      )
      await assert.rejects(
        repository.setPersonalAddons(
          firstAuth,
          id,
          { expectedVersion: 2, addons: group.draft },
          randomUUID()
        ),
        { code: 'ADDON_LAYER_CONFLICT' }
      )
      const addons = [configuredAddon('PersonalToken')]
      const saved = await repository.setPersonalAddons(
        firstAuth,
        id,
        { expectedVersion: 2, addons },
        randomUUID()
      )
      assert.deepEqual(saved.addons, addons)
      assert.equal(saved.jobId, null)
      assert.deepEqual((await repository.getPersonalAddons(firstAuth, id)).addons, addons)
      const row = await db.get('SELECT personal_enc FROM managed_accounts WHERE id = $1', [id])
      assert.ok(!row.personal_enc.includes('PersonalToken'))
      const collisionGroup = (
        await repository.createGroup(firstAuth, { name: 'Conflicting', addons }, randomUUID())
      ).group
      await assert.rejects(
        repository.assignGroup(
          firstAuth,
          {
            groupId: collisionGroup.id,
            accounts: [{ id, expectedVersion: saved.account.version }],
          },
          randomUUID()
        ),
        { code: 'ADDON_LAYER_CONFLICT' }
      )
      assert.equal((await repository.getAccount(firstAuth, id)).groupId, group.id)
    }
  )

  check(
    'active transfer requires a published group and offboarding cannot be cancelled',
    async (storage) => {
      const { db, repository, group, accounts, activateFixture } =
        await prepareGroupFixture(storage)
      await activateFixture()
      const request = { groupId: group.id, accounts: [{ id: accounts[0].id, expectedVersion: 1 }] }
      await assert.rejects(repository.assignGroup(firstAuth, request, randomUUID()), {
        code: 'GROUP_NOT_PUBLISHED',
      })
      await assert.rejects(
        repository.assignGroup(firstAuth, { ...request, groupId: null }, randomUUID()),
        { code: 'INVALID_STATE' }
      )
      await db.run("UPDATE managed_accounts SET state = 'offboarding' WHERE id = $1", [
        accounts[0].id,
      ])
      await assert.rejects(repository.assignGroup(firstAuth, request, randomUUID()), {
        code: 'INVALID_STATE',
      })
      await assert.rejects(
        repository.setPersonalAddons(
          firstAuth,
          accounts[0].id,
          { expectedVersion: 1, addons: [] },
          randomUUID()
        ),
        { code: 'INVALID_STATE' }
      )
    }
  )

  check(
    'personal changes use published addons, queue suspended work for expired users and active work for lifetime',
    async (storage) => {
      const { db, repository, group, accounts, activateFixture, publishFixture, now } =
        await prepareGroupFixture(storage)
      await publishFixture()
      await activateFixture(accounts[0].id)
      await activateFixture(accounts[1].id)
      await db.run(
        "UPDATE managed_accounts SET expiry_at = $1, expiry_local = '2026-09-19T00:00', expiry_offset = -240, expiry_timezone = 'America/New_York' WHERE id = $2",
        [now(), accounts[0].id]
      )
      await db.run('UPDATE managed_accounts SET lifetime = 1 WHERE id = $1', [accounts[1].id])
      const addons = [configuredAddon('Personal')]
      await repository.saveGroupDraft(
        firstAuth,
        group.id,
        { expectedVersion: 1, name: group.name, addons, safeMode: null },
        randomUUID()
      )
      for (const [index, target] of [
        [0, 'suspended'],
        [1, 'active'],
      ]) {
        const result = await repository.setPersonalAddons(
          firstAuth,
          accounts[index].id,
          { expectedVersion: 1, addons },
          randomUUID()
        )
        assert.ok(result.jobId)
        const job = await db.get(
          'SELECT target, cause, policy_version FROM managed_jobs WHERE id = $1',
          [result.jobId]
        )
        assert.deepEqual(job, { target, cause: 'personal', policy_version: 2 })
        assert.equal(result.addons[0].flags.enabled, false)
      }
    }
  )

  check('concurrent assignments cannot overwrite the winning membership', async (storage) => {
    const { repository, group, accounts } = await prepareGroupFixture(storage)
    const other = (await repository.createGroup(firstAuth, { name: 'Second' }, randomUUID())).group
    const results = await Promise.allSettled(
      [group.id, other.id].map((groupId) =>
        repository.assignGroup(
          firstAuth,
          { groupId, accounts: [{ id: accounts[0].id, expectedVersion: 1 }] },
          randomUUID()
        )
      )
    )
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
    assert.equal(
      results.find((result) => result.status === 'rejected').reason.code,
      'VERSION_CONFLICT'
    )
  })

  check(
    'published group transfer queues each active member without bypassing lifetime or expiry',
    async (storage) => {
      const { db, repository, accounts, activateFixture, publishFixture, now } =
        await prepareGroupFixture(storage)
      await publishFixture()
      const destination = (
        await repository.createGroup(
          firstAuth,
          { name: 'Destination', addons: [configuredAddon('Destination')] },
          randomUUID()
        )
      ).group
      await publishFixture(destination)
      await activateFixture(accounts[0].id)
      await activateFixture(accounts[1].id)
      await db.run(
        "UPDATE managed_accounts SET expiry_at = $1, expiry_local = '2026-09-19T00:00', expiry_offset = -240, expiry_timezone = 'America/New_York' WHERE id = $2",
        [now(), accounts[0].id]
      )
      await db.run('UPDATE managed_accounts SET lifetime = 1 WHERE id = $1', [accounts[1].id])
      const result = await repository.assignGroup(
        firstAuth,
        {
          groupId: destination.id,
          accounts: accounts.slice(0, 2).map(({ id }) => ({ id, expectedVersion: 1 })),
        },
        randomUUID()
      )
      for (const entry of result.accounts) {
        assert.equal(entry.account.groupId, destination.id)
        assert.equal(entry.account.policyVersion, 2)
        assert.equal(entry.account.state, 'active')
        const job = await db.get('SELECT target, cause FROM managed_jobs WHERE id = $1', [
          entry.jobId,
        ])
        assert.deepEqual(job, {
          target: entry.account.id === accounts[0].id ? 'suspended' : 'active',
          cause: 'assignment',
        })
      }
    }
  )

  check(
    'a late bulk-assignment failure rolls back all account versions and audit records',
    async (storage) => {
      const { db, repository, group, accounts } = await prepareGroupFixture(storage)
      const original = db.statement.bind(db)
      db.statement = (connection, method, sql, params) => {
        if (
          sql.startsWith('INSERT INTO managed_idempotency') &&
          params[1] === 'accounts.assign-group'
        )
          throw new Error('synthetic assignment failure')
        return original(connection, method, sql, params)
      }
      try {
        await assert.rejects(
          repository.assignGroup(
            firstAuth,
            { groupId: group.id, accounts: accounts.map(({ id }) => ({ id, expectedVersion: 1 })) },
            randomUUID()
          ),
          /synthetic assignment failure/
        )
      } finally {
        db.statement = original
      }
      assert.equal(
        (await db.get('SELECT COUNT(*) AS count FROM managed_accounts WHERE group_id IS NOT NULL'))
          .count,
        0
      )
      assert.equal(
        (
          await db.get(
            "SELECT COUNT(*) AS count FROM managed_audit WHERE event_type = 'accounts.group-assigned'"
          )
        ).count,
        0
      )
    }
  )

  check('a failed job insert rolls back personal changes on an active account', async (storage) => {
    const { db, repository, accounts, activateFixture, publishFixture } =
      await prepareGroupFixture(storage)
    await publishFixture()
    await activateFixture()
    const before = await db.get('SELECT * FROM managed_accounts WHERE id = $1', [accounts[0].id])
    const original = db.statement.bind(db)
    db.statement = (connection, method, sql, params) => {
      if (sql.includes('INSERT INTO managed_jobs')) throw new Error('synthetic enqueue failure')
      return original(connection, method, sql, params)
    }
    try {
      await assert.rejects(
        repository.setPersonalAddons(
          firstAuth,
          accounts[0].id,
          { expectedVersion: 1, addons: [configuredAddon('Personal')] },
          randomUUID()
        ),
        /synthetic enqueue failure/
      )
    } finally {
      db.statement = original
    }
    assert.deepEqual(
      await db.get('SELECT * FROM managed_accounts WHERE id = $1', [accounts[0].id]),
      before
    )
  })

  check(
    'malformed and duplicate bulk member lists are rejected without writes',
    async (storage) => {
      const { db, repository, group, accounts } = await prepareGroupFixture(storage)
      const entry = { id: accounts[0].id, expectedVersion: 1 }
      for (const members of [
        [],
        [entry, entry],
        [{ ...entry, expectedVersion: 0 }],
        Array(201).fill(entry),
      ])
        await assert.rejects(
          repository.assignGroup(firstAuth, { groupId: group.id, accounts: members }, randomUUID()),
          { code: 'INVALID_INPUT' }
        )
      assert.equal(
        (await db.get('SELECT COUNT(*) AS count FROM managed_accounts WHERE group_id IS NOT NULL'))
          .count,
        0
      )
    }
  )
}
