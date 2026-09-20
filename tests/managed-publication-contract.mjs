import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { createManagedRepository } from '../server/managed/repository.js'
import { createManagedJobStore } from '../server/managed/jobs.js'
import {
  PUBLICATION_PREVIEW_TTL_MS,
  MAX_PUBLICATION_MEMBERS,
} from '../server/managed/publication.js'
import { firstAuth, secondAuth, syntheticKey } from './managed-contract.mjs'
import { prepareGroupFixture } from './managed-groups-contract.mjs'
import { configuredAddon } from './fixtures/addon-config.mjs'

export async function preparePublicationFixture(
  storage,
  { count = 3, validator = async () => true } = {}
) {
  let validationCalls = 0
  const repository = createManagedRepository({
    ...storage,
    legacyKeys: [syntheticKey],
    validateManifests: async (addons) => {
      validationCalls++
      return validator(addons)
    },
  })
  const seeded = await prepareGroupFixture({ ...storage, repository }, count)
  const enabled = { ...configuredAddon(), flags: { enabled: true, protected: false } }
  const group = (
    await repository.saveGroupDraft(
      firstAuth,
      seeded.group.id,
      { expectedVersion: 1, name: seeded.group.name, addons: [enabled], safeMode: null },
      randomUUID()
    )
  ).group
  await storage.db.run('UPDATE managed_accounts SET group_id = $1 WHERE owner_id = $2', [
    group.id,
    firstAuth.owner,
  ])
  const activateAll = () =>
    storage.db.run(
      "UPDATE managed_accounts SET state = 'active', provider_key = 'synthetic-publish-' || id, provider_enc = 'synthetic-only' WHERE owner_id = $1",
      [firstAuth.owner]
    )
  const preview = async () =>
    repository.previewGroupPublication(firstAuth, group.id, {
      expectedVersion: (await repository.getGroup(firstAuth, group.id)).version,
    })
  const publish = async ({ allowEmpty = false, key = randomUUID() } = {}) => {
    const prepared = await preview()
    return repository.publishGroup(
      firstAuth,
      group.id,
      { expectedVersion: prepared.version, receipt: prepared.receipt, allowEmpty },
      key
    )
  }
  return {
    ...seeded,
    repository,
    group,
    preview,
    publish,
    activateAll,
    validationCalls: () => validationCalls,
  }
}

export function managedPublicationContract(prefix, options, fixture) {
  const check = (name, fn) =>
    test(`${prefix}: ${name}`, options, async (t) => fn(await fixture(t), t))

  check(
    'published rollout discovery is scoped, read-only and follows the published revision',
    async (storage) => {
      const { repository, group, publish, validationCalls } =
        await preparePublicationFixture(storage)
      assert.deepEqual(await repository.getGroupDeployment(firstAuth, group.id), {
        deployment: null,
      })
      await assert.rejects(repository.getGroupDeployment(secondAuth, group.id), {
        code: 'NOT_FOUND',
      })
      await assert.rejects(repository.getGroupDeployment(firstAuth, randomUUID()), {
        code: 'NOT_FOUND',
      })
      const first = await publish()
      const reads = validationCalls()
      assert.deepEqual(
        (await repository.getGroupDeployment(firstAuth, group.id)).deployment,
        await repository.getDeployment(firstAuth, first.deploymentId)
      )
      assert.equal(validationCalls(), reads)
      const saved = await repository.saveGroupDraft(
        firstAuth,
        group.id,
        {
          expectedVersion: first.group.version,
          name: 'Updated draft',
          safeMode: null,
          addons: [{ ...first.group.draft[0], flags: { enabled: false } }],
        },
        randomUUID()
      )
      assert.equal(
        (await repository.getGroupDeployment(firstAuth, group.id)).deployment.revision,
        1
      )
      const next = await publish({ allowEmpty: true })
      const found = (await repository.getGroupDeployment(firstAuth, group.id)).deployment
      assert.equal(found.id, next.deploymentId)
      assert.equal(found.revision, 2)
      assert.equal((await repository.getDeployment(firstAuth, first.deploymentId)).revision, 1)
      assert.equal((await storage.db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      assert.ok(saved.group.version > first.group.version)
    }
  )

  check(
    'published rollout discovery fails closed when the recorded deployment is missing',
    async (storage) => {
      const { repository, group, publish } = await preparePublicationFixture(storage)
      const result = await publish()
      await storage.db.run('DELETE FROM managed_deployments WHERE id = $1', [result.deploymentId])
      await assert.rejects(repository.getGroupDeployment(firstAuth, group.id), {
        code: 'DATA_UNREADABLE',
      })
    }
  )

  check(
    'publication cannot proceed without explicit trusted manifest validation',
    async (storage) => {
      const { repository, group, db } = await prepareGroupFixture(storage)
      await assert.rejects(
        repository.previewGroupPublication(firstAuth, group.id, { expectedVersion: 1 }),
        { code: 'PUBLICATION_UNAVAILABLE' }
      )
      for (const invalid of [false, undefined]) {
        const unconfirmed = createManagedRepository({
          ...storage,
          legacyKeys: [syntheticKey],
          validateManifests: async () => invalid,
        })
        await assert.rejects(
          unconfirmed.previewGroupPublication(firstAuth, group.id, { expectedVersion: 1 }),
          { code: 'MANIFEST_UNAVAILABLE' }
        )
      }
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count, 0)
    }
  )

  check(
    'manifest checks run outside a database transaction and cannot overwrite curated config',
    async (storage) => {
      const prepared = await preparePublicationFixture(storage, {
        validator: async (addons) => {
          await storage.db.transaction(async (tx) =>
            assert.equal((await tx.get('SELECT COUNT(*) AS count FROM managed_groups')).count, 1)
          )
          addons[0].metadata.customName = 'Adapter must not change saved customization'
          return true
        },
      })
      const preview = await prepared.preview()
      assert.deepEqual(preview.counts, { active: 0, suspended: 0, staged: 3, offboarding: 0 })
      assert.deepEqual(preview.changes, { added: 1, removed: 0, changed: 0, reordered: false })
      assert.equal(
        (await prepared.repository.getGroup(firstAuth, prepared.group.id)).draft[0].metadata
          .customName,
        'Custom'
      )
      assert.equal((await storage.db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      assert.equal(
        (await storage.db.get('SELECT COUNT(*) AS count FROM managed_deployments')).count,
        0
      )
    }
  )

  check(
    'a failed manifest check cannot publish partial or empty state or reveal URL secrets',
    async (storage) => {
      const { preview, db } = await preparePublicationFixture(storage, {
        validator: async () => {
          throw new Error('https://private.invalid/SECRET/manifest.json')
        },
      })
      await assert.rejects(
        preview(),
        (error) => error.code === 'MANIFEST_UNAVAILABLE' && !error.message.includes('SECRET')
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count, 0)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
    }
  )

  check(
    'mixed cohorts keep staged/offboarding passive and queue expired and lifetime correctly',
    async (storage) => {
      const { db, repository, group, accounts, activateAll, preview, crypto, now } =
        await preparePublicationFixture(storage, { count: 4 })
      await activateAll()
      await db.run("UPDATE managed_accounts SET state = 'staged' WHERE id = $1", [accounts[0].id])
      await db.run("UPDATE managed_accounts SET state = 'offboarding' WHERE id = $1", [
        accounts[1].id,
      ])
      await db.run(
        "UPDATE managed_accounts SET expiry_at = $1, expiry_local = '2026-09-19T00:00', expiry_offset = -240, expiry_timezone = 'America/New_York' WHERE id = $2",
        [now(), accounts[2].id]
      )
      await db.run('UPDATE managed_accounts SET lifetime = 1 WHERE id = $1', [accounts[3].id])
      const retained = await db.query(
        'SELECT id, credentials_enc, personal_enc, configuration_enc FROM managed_accounts ORDER BY id'
      )
      const prepared = await preview()
      assert.deepEqual(prepared.counts, { active: 1, suspended: 1, staged: 1, offboarding: 1 })
      const result = await repository.publishGroup(
        firstAuth,
        group.id,
        { expectedVersion: prepared.version, receipt: prepared.receipt },
        randomUUID()
      )
      assert.equal(result.queued, 2)
      assert.equal(result.revision, 1)
      const deployment = await repository.getDeployment(firstAuth, result.deploymentId)
      assert.equal(deployment.counts.pending, 2)
      assert.deepEqual(deployment.skipped, { staged: 1, offboarding: 1 })
      assert.equal(
        deployment.members.find((row) => row.accountId === accounts[2].id).target,
        'suspended'
      )
      assert.equal(
        deployment.members.find((row) => row.accountId === accounts[3].id).target,
        'active'
      )
      assert.deepEqual(
        await db.query(
          'SELECT id, credentials_enc, personal_enc, configuration_enc FROM managed_accounts ORDER BY id'
        ),
        retained
      )
      for (const account of accounts.slice(0, 2))
        assert.equal((await repository.getAccount(firstAuth, account.id)).version, 1)
      const revision = await db.get('SELECT * FROM managed_group_revisions WHERE group_id = $1', [
        group.id,
      ])
      assert.deepEqual(
        crypto.open(revision.config_enc, {
          owner: firstAuth.owner,
          id: group.id,
          purpose: 'group-revision:1',
        }),
        group.draft
      )
      assert.ok(!JSON.stringify(revision).includes('GroupToken'))
    }
  )

  check(
    'a committed retry replays after preview expiry without creating another revision or jobs',
    async (storage) => {
      const { db, repository, group, activateAll, preview, advance, validationCalls } =
        await preparePublicationFixture(storage)
      await activateAll()
      const prepared = await preview()
      const input = { expectedVersion: prepared.version, receipt: prepared.receipt }
      const key = randomUUID()
      const first = await repository.publishGroup(firstAuth, group.id, input, key)
      advance(PUBLICATION_PREVIEW_TTL_MS + 1)
      const replayed = await repository.publishGroup(firstAuth, group.id, input, key)
      assert.equal(replayed.replayed, true)
      assert.equal(replayed.deploymentId, first.deploymentId)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 3)
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count, 1)
      assert.equal(validationCalls(), 1)
      await assert.rejects(
        repository.publishGroup(firstAuth, group.id, { ...input, allowEmpty: true }, key),
        { code: 'IDEMPOTENCY_CONFLICT' }
      )
    }
  )

  check('new requests reject expired, tampered and other-owner receipts', async (storage) => {
    const { db, repository, group, preview, advance } = await preparePublicationFixture(storage)
    const prepared = await preview()
    const input = { expectedVersion: prepared.version, receipt: prepared.receipt }
    await assert.rejects(repository.publishGroup(secondAuth, group.id, input, randomUUID()), {
      code: 'PREVIEW_STALE',
    })
    await assert.rejects(
      repository.publishGroup(firstAuth, group.id, { ...input, receipt: 'broken' }, randomUUID()),
      { code: 'PREVIEW_STALE' }
    )
    advance(PUBLICATION_PREVIEW_TTL_MS)
    await assert.rejects(repository.publishGroup(firstAuth, group.id, input, randomUUID()), {
      code: 'PREVIEW_STALE',
    })
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_deployments')).count, 0)
  })

  check(
    'membership changes and crossing the cutoff invalidate an earlier cohort preview',
    async (storage) => {
      const { repository, db, group, accounts, activateAll, preview, advance, now } =
        await preparePublicationFixture(storage)
      await activateAll()
      await db.run(
        "UPDATE managed_accounts SET expiry_at = $1, expiry_local = '2026-09-19T00:00', expiry_offset = -240, expiry_timezone = 'America/New_York' WHERE id = $2",
        [now() + 1000, accounts[0].id]
      )
      const prepared = await preview()
      advance(1000)
      await assert.rejects(
        repository.publishGroup(
          firstAuth,
          group.id,
          { expectedVersion: prepared.version, receipt: prepared.receipt },
          randomUUID()
        ),
        { code: 'PREVIEW_STALE' }
      )
      const next = await preview()
      await repository.setMembership(
        firstAuth,
        accounts[0].id,
        { mode: 'lifetime', expectedVersion: 1 },
        randomUUID()
      )
      await assert.rejects(
        repository.publishGroup(
          firstAuth,
          group.id,
          { expectedVersion: next.version, receipt: next.receipt },
          randomUUID()
        ),
        { code: 'PREVIEW_STALE' }
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_deployments')).count, 0)
    }
  )

  check(
    'draft edits during validation cannot be published using an older manifest check',
    async (storage) => {
      let prepared
      prepared = await preparePublicationFixture(storage, {
        validator: async () => {
          await prepared.repository.saveGroupDraft(
            firstAuth,
            prepared.group.id,
            {
              expectedVersion: prepared.group.version,
              name: 'Concurrent edit',
              addons: [configuredAddon('Changed')],
              safeMode: null,
            },
            randomUUID()
          )
          return true
        },
      })
      await assert.rejects(prepared.preview(), { code: 'VERSION_CONFLICT' })
      assert.equal(
        (await prepared.repository.getGroup(firstAuth, prepared.group.id)).name,
        'Concurrent edit'
      )
      assert.equal(
        (await storage.db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count,
        0
      )
    }
  )

  check('empty and entirely disabled publication require an explicit choice', async (storage) => {
    const { repository, group, preview } = await preparePublicationFixture(storage)
    for (const addons of [[], [configuredAddon('Disabled')]]) {
      const current = await repository.getGroup(firstAuth, group.id)
      await repository.saveGroupDraft(
        firstAuth,
        group.id,
        { expectedVersion: current.version, name: current.name, addons, safeMode: null },
        randomUUID()
      )
      const prepared = await preview()
      assert.equal(prepared.empty, true)
      const input = { expectedVersion: prepared.version, receipt: prepared.receipt }
      await assert.rejects(repository.publishGroup(firstAuth, group.id, input, randomUUID()), {
        code: 'EMPTY_PUBLICATION_CONFIRMATION',
      })
      assert.equal(
        (
          await repository.publishGroup(
            firstAuth,
            group.id,
            { ...input, allowEmpty: true },
            randomUUID()
          )
        ).unchanged,
        false
      )
    }
  })

  check(
    'personal-layer conflict blocks publication for staged or active members',
    async (storage) => {
      const { repository, db, group, accounts, preview } = await preparePublicationFixture(storage)
      await repository.setPersonalAddons(
        firstAuth,
        accounts[0].id,
        { expectedVersion: 1, addons: [configuredAddon('Personal')] },
        randomUUID()
      )
      await repository.saveGroupDraft(
        firstAuth,
        group.id,
        {
          expectedVersion: group.version,
          name: group.name,
          addons: [configuredAddon('Personal')],
          safeMode: null,
        },
        randomUUID()
      )
      await assert.rejects(preview(), { code: 'ADDON_LAYER_CONFLICT' })
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count, 0)
    }
  )

  check(
    'an unchanged configuration creates no repeated rollout or active-client drift rewrite',
    async (storage) => {
      const { repository, db, publish, activateAll } = await preparePublicationFixture(storage)
      await activateAll()
      const first = await publish()
      const before = await db.query('SELECT id, policy_version FROM managed_accounts ORDER BY id')
      const again = await publish()
      assert.equal(again.unchanged, true)
      assert.equal(again.deploymentId, first.deploymentId)
      assert.equal(again.queued, 0)
      assert.deepEqual(
        await db.query('SELECT id, policy_version FROM managed_accounts ORDER BY id'),
        before
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 3)
      assert.equal(
        (await repository.getDeployment(firstAuth, first.deploymentId)).members.length,
        3
      )
    }
  )

  check(
    'a late failure rolls back revision, group version, policies, jobs, cohort and audit',
    async (storage) => {
      const { db, repository, group, preview, activateAll } =
        await preparePublicationFixture(storage)
      await activateAll()
      const prepared = await preview()
      const before = await db.query('SELECT * FROM managed_accounts ORDER BY id')
      const original = db.statement.bind(db)
      db.statement = (connection, method, sql, params) => {
        if (sql.startsWith('INSERT INTO managed_idempotency') && params[1] === 'groups.publish')
          throw new Error('synthetic final insert failure')
        return original(connection, method, sql, params)
      }
      const key = randomUUID()
      const input = { expectedVersion: prepared.version, receipt: prepared.receipt }
      try {
        await assert.rejects(
          repository.publishGroup(firstAuth, group.id, input, key),
          /synthetic final insert failure/
        )
      } finally {
        db.statement = original
      }
      assert.deepEqual(await db.query('SELECT * FROM managed_accounts ORDER BY id'), before)
      assert.equal((await repository.getGroup(firstAuth, group.id)).version, group.version)
      for (const table of ['managed_group_revisions', 'managed_jobs', 'managed_deployments'])
        assert.equal((await db.get(`SELECT COUNT(*) AS count FROM ${table}`)).count, 0)
      assert.equal(
        (
          await db.get(
            "SELECT COUNT(*) AS count FROM managed_audit WHERE event_type = 'group.published'"
          )
        ).count,
        0
      )
      assert.equal((await repository.publishGroup(firstAuth, group.id, input, key)).queued, 3)
    }
  )

  check(
    'newer publication supersedes old pending progress and cannot accept stale running completion',
    async (storage) => {
      const { db, repository, group, activateAll, publish } =
        await preparePublicationFixture(storage)
      await activateAll()
      await db.run('UPDATE managed_metadata SET write_paused = 0')
      await db.run('UPDATE managed_owners SET write_paused = 0')
      const jobs = createManagedJobStore(storage)
      const first = await publish()
      const running = await jobs.claim()
      const saved = await repository.getGroup(firstAuth, group.id)
      const before = await db.get(
        'SELECT config_enc FROM managed_group_revisions WHERE group_id = $1 AND revision = 1',
        [group.id]
      )
      await repository.saveGroupDraft(
        firstAuth,
        group.id,
        {
          expectedVersion: saved.version,
          name: saved.name,
          addons: [{ ...configuredAddon('New'), flags: { enabled: true } }],
          safeMode: null,
        },
        randomUUID()
      )
      const next = await publish()
      assert.equal(next.revision, 2)
      assert.equal(
        (await repository.getDeployment(firstAuth, first.deploymentId)).counts.superseded,
        2
      )
      assert.equal(
        (await jobs.completeVerified(running, { expected: [], observed: [] })).state,
        'superseded'
      )
      assert.equal(
        (await repository.getDeployment(firstAuth, first.deploymentId)).counts.superseded,
        3
      )
      assert.equal((await repository.getDeployment(firstAuth, next.deploymentId)).counts.pending, 3)
      assert.deepEqual(
        await db.get(
          'SELECT config_enc FROM managed_group_revisions WHERE group_id = $1 AND revision = 1',
          [group.id]
        ),
        before
      )
      await assert.rejects(repository.getDeployment(secondAuth, next.deploymentId), {
        code: 'NOT_FOUND',
      })
    }
  )

  for (const count of [40, 100, MAX_PUBLICATION_MEMBERS])
    check(
      `publication queues ${count} accounts atomically with one shared validation call`,
      async (storage, t) => {
        const { activateAll, publish, repository, validationCalls } =
          await preparePublicationFixture(storage, { count })
        await activateAll()
        const started = performance.now()
        const result = await publish()
        t.diagnostic(
          `${count}-account preview + publication: ${Math.round(performance.now() - started)} ms (synthetic, not provider throughput)`
        )
        assert.equal(result.queued, count)
        const deployment = await repository.getDeployment(firstAuth, result.deploymentId)
        assert.equal(deployment.counts.pending, count)
        assert.equal(validationCalls(), 1)
        assert.equal(new Set(deployment.members.map((row) => row.jobId)).size, count)
      }
    )

  check('an oversized cohort is rejected without partial publication', async (storage) => {
    const { preview, db } = await preparePublicationFixture(storage, {
      count: MAX_PUBLICATION_MEMBERS + 1,
    })
    await assert.rejects(preview(), { code: 'GROUP_TOO_LARGE' })
    assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count, 0)
  })

  check(
    'concurrent duplicate delivery commits one rollout and rejects a second request for the stale version',
    async (storage) => {
      const { repository, db, group, preview, activateAll } =
        await preparePublicationFixture(storage)
      await activateAll()
      const prepared = await preview()
      const input = { expectedVersion: prepared.version, receipt: prepared.receipt }
      const key = randomUUID()
      const results = await Promise.all(
        Array.from({ length: 8 }, () => repository.publishGroup(firstAuth, group.id, input, key))
      )
      assert.equal(new Set(results.map((result) => result.deploymentId)).size, 1)
      assert.equal(results.filter((result) => !result.replayed).length, 1)
      await assert.rejects(repository.publishGroup(firstAuth, group.id, input, randomUUID()), {
        code: 'VERSION_CONFLICT',
      })
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 3)
    }
  )

  check(
    'assignment and inherited safe-mode changes invalidate cohort previews',
    async (storage) => {
      const { repository, db, group, accounts, preview } = await preparePublicationFixture(storage)
      const first = await preview()
      await repository.assignGroup(
        firstAuth,
        { groupId: null, accounts: [{ id: accounts[0].id, expectedVersion: 1 }] },
        randomUUID()
      )
      await assert.rejects(
        repository.publishGroup(
          firstAuth,
          group.id,
          { expectedVersion: first.version, receipt: first.receipt },
          randomUUID()
        ),
        { code: 'PREVIEW_STALE' }
      )
      const second = await preview()
      await db.run('UPDATE managed_owners SET safe_mode = 0 WHERE owner_id = $1', [firstAuth.owner])
      await assert.rejects(
        repository.publishGroup(
          firstAuth,
          group.id,
          { expectedVersion: second.version, receipt: second.receipt },
          randomUUID()
        ),
        { code: 'PREVIEW_STALE' }
      )
    }
  )

  check(
    'inconsistent published config and digest fail closed even after a valid preview',
    async (storage) => {
      const { repository, db, group, preview, publish } = await preparePublicationFixture(storage)
      await publish()
      const prepared = await preview()
      await db.run(
        "UPDATE managed_group_revisions SET payload_digest = 'synthetic-corruption' WHERE group_id = $1",
        [group.id]
      )
      await assert.rejects(preview(), { code: 'DATA_UNREADABLE' })
      await assert.rejects(
        repository.publishGroup(
          firstAuth,
          group.id,
          { expectedVersion: prepared.version, receipt: prepared.receipt },
          randomUUID()
        ),
        { code: 'DATA_UNREADABLE' }
      )
      assert.equal((await db.get('SELECT COUNT(*) AS count FROM managed_group_revisions')).count, 1)
    }
  )
}
