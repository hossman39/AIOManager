import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { firstAuth } from './managed-contract.mjs'
import { preparePublicationFixture } from './managed-publication-contract.mjs'
import { configuredAddon } from './fixtures/addon-config.mjs'
import { createManagedJobStore, currentAccountTarget } from '../server/managed/jobs.js'
import { providerIdentityKey } from '../server/managed/execution.js'
import { createManagedWorker, ProviderFailure } from '../server/managed/worker.js'
import { providerCollection } from '../server/managed/projection.js'
import { managedMigrations, migrateManagedSchema } from '../server/managed/schema.js'
import { prepareJobFixture } from './managed-job-contract.mjs'

export async function prepareWorkerFixture(storage, t, { count = 1 } = {}) {
  const seeded = await preparePublicationFixture(storage, { count })
  await seeded.publish()
  await seeded.activateAll()
  const { db, crypto, now, advance, repository, group } = seeded
  const rows = await db.query('SELECT * FROM managed_accounts ORDER BY id')
  for (const row of rows) {
    const provider = { id: `synthetic-${row.id}`, authKey: `synthetic-key-${row.id}` }
    await db.run('UPDATE managed_accounts SET provider_key = $1, provider_enc = $2 WHERE id = $3', [
      providerIdentityKey(crypto, provider.id),
      crypto.seal(provider, { owner: firstAuth.owner, id: row.id, purpose: 'provider-session' }),
      row.id,
    ])
  }
  await db.run('UPDATE managed_metadata SET write_paused = 0')
  await db.run('UPDATE managed_owners SET write_paused = 0')
  const ids = rows.map((row) => row.id)
  const jobs = createManagedJobStore({ db, crypto, now })
  const remote = new Map(ids.map((id) => [`synthetic-${id}`, []]))
  const calls = []
  const hooks = {}
  const provider = {
    async getIdentity(session, options) {
      calls.push({ method: 'identity', id: session.id, at: now() })
      return hooks.identity ? hooks.identity(session, options) : session.id
    },
    async getCollection(session, options) {
      calls.push({ method: 'get', id: session.id, at: now() })
      return hooks.get ? hooks.get(session, options) : structuredClone(remote.get(session.id))
    },
    async setCollection(session, addons, options) {
      calls.push({ method: 'set', id: session.id, at: now(), addons: structuredClone(addons) })
      if (hooks.set) return hooks.set(session, addons, options)
      remote.set(session.id, structuredClone(addons))
    },
  }
  let monotonic = 0
  const makeWorker = (overrides = {}) => {
    const worker = createManagedWorker({
      db,
      jobs,
      provider,
      now,
      random: () => 0.5,
      monotonic: () => monotonic,
      wait: async (ms) => {
        monotonic += ms
        advance(ms)
      },
      ...overrides,
    })
    t.after(() => worker.close())
    return worker
  }
  const enqueue = async (id = ids[0]) => {
    const account = await repository.getAccount(firstAuth, id)
    return jobs.enqueue({
      owner: firstAuth.owner,
      accountId: id,
      expectedPolicy: account.policyVersion,
      cause: 'manual',
    })
  }
  const saved = async (id = ids[0]) => {
    const row = await db.get('SELECT configuration_enc FROM managed_accounts WHERE id = $1', [id])
    return crypto.open(row.configuration_enc, {
      owner: firstAuth.owner,
      id,
      purpose: 'configuration',
    })
  }
  const expire = (id = ids[0]) =>
    db.run(
      `UPDATE managed_accounts SET lifetime = 0, expiry_at = $1,
    expiry_local = '2026-09-19T12:00', expiry_offset = -240, expiry_timezone = 'America/New_York' WHERE id = $2`,
      [now(), id]
    )
  const passTime = (ms) => {
    monotonic += ms
    advance(ms)
  }
  return {
    ...seeded,
    jobs,
    ids,
    group,
    remote,
    calls,
    hooks,
    provider,
    makeWorker,
    enqueue,
    saved,
    expire,
    passTime,
  }
}

export function managedWorkerContract(prefix, options, fixture) {
  const check = (name, fn) =>
    test(`${prefix}: ${name}`, options, async (t) =>
      fn(await prepareWorkerFixture(await fixture(t), t), t)
    )

  test(
    `${prefix}: additive upgrade retains known suspension and does not undo an explicit renewal`,
    options,
    async (t) => {
      const s = await prepareJobFixture(
        await fixture(t, { migrations: managedMigrations.slice(0, 2) })
      )
      for (const id of s.ids) await s.expire(id)
      await s.db.run(
        `UPDATE managed_accounts SET applied_version = 1, applied_target = 'suspended', verified_at = $1 WHERE id = $2`,
        [s.now(), s.ids[0]]
      )
      await s.db.run(
        `INSERT INTO managed_jobs (id, owner_id, account_id, policy_version, target, cause, due_at, created_at, updated_at)
      VALUES ($1, $2, $3, 1, 'suspended', 'expiry', $4, $4, $4)`,
        [randomUUID(), firstAuth.owner, s.ids[1], s.now()]
      )
      await s.db.run(
        `UPDATE managed_accounts SET policy_version = 2, applied_version = 1, applied_target = 'suspended',
      expiry_at = expiry_at + 86400000 WHERE id = $1`,
        [s.ids[2]]
      )
      const before = await s.db.query('SELECT * FROM managed_accounts ORDER BY id')
      await migrateManagedSchema(s.db)
      const after = await s.db.query('SELECT * FROM managed_accounts ORDER BY id')
      assert.deepEqual(
        after,
        before.map((row) => ({
          ...row,
          suspended_at: row.id === s.ids[2] ? null : s.now(),
          expiry_zone: 'America/New_York',
          expiry_zone_offset: null,
          suspension_check_at: null,
        }))
      )
      assert.equal((await s.db.get('SELECT execution_enc FROM managed_jobs')).execution_enc, null)
    }
  )

  check(
    'writes the complete projected collection once, snapshots first, and verifies exactly',
    async (s) => {
      await s.enqueue()
      const worker = s.makeWorker()
      s.hooks.set = async (session, addons) => {
        const job = await s.db.get("SELECT * FROM managed_jobs WHERE state = 'running'")
        assert.equal(job.write_intent, 1)
        assert.ok(job.execution_enc && !job.execution_enc.includes('GroupToken'))
        assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 1)
        assert.deepEqual(providerCollection(await s.saved()), addons)
        s.remote.set(session.id, addons)
      }
      assert.equal((await worker.runOnce()).state, 'verified')
      assert.deepEqual(
        s.calls.map((call) => call.method),
        ['identity', 'get', 'set', 'get']
      )
      assert.equal(s.calls[2].addons[0].manifest.name, 'Custom')
      assert.deepEqual(s.calls[2].addons[0].manifest.catalogs, [])
      assert.equal((await s.saved())[0].manifest.catalogs.length, 1)
      assert.equal((await s.repository.getAccount(firstAuth, s.ids[0])).appliedTarget, 'active')
      for (let i = 1; i < s.calls.length; i++) assert.ok(s.calls[i].at - s.calls[i - 1].at >= 500)
    }
  )

  check(
    'matching collections complete without writing or scheduling active drift checks',
    async (s) => {
      const desired = providerCollection((await s.repository.getGroup(firstAuth, s.group.id)).draft)
      s.remote.set(`synthetic-${s.ids[0]}`, desired)
      await s.enqueue()
      const worker = s.makeWorker()
      assert.equal((await worker.runOnce()).state, 'verified')
      assert.equal(s.calls.filter((call) => call.method === 'set').length, 0)
      assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 0)
      s.remote.set(`synthetic-${s.ids[0]}`, [])
      s.passTime(60_000)
      assert.equal((await worker.runOnce()).state, 'idle')
      assert.equal(s.calls.length, 2)
    }
  )

  check('malformed reads and identity mismatches cannot become an empty replacement', async (s) => {
    await s.enqueue()
    s.hooks.get = async () => ({ result: {} })
    const result = await s.makeWorker().runOnce()
    assert.equal(result.state, 'failed')
    assert.equal(result.code, 'DATA_UNREADABLE')
    assert.equal(
      s.calls.some((call) => call.method === 'set'),
      false
    )
    assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 0)
  })

  check(
    'an enrolled provider identity is checked instead of trusting the supplied session',
    async (s) => {
      await s.enqueue()
      s.hooks.identity = async () => 'someone-else'
      const result = await s.makeWorker().runOnce()
      assert.equal(result.state, 'failed')
      assert.equal(result.code, 'IDENTITY_MISMATCH')
      assert.deepEqual(
        s.calls.map((call) => call.method),
        ['identity']
      )
    }
  )

  check(
    'corrupt published configuration blocks execution before any provider request',
    async (s) => {
      await s.enqueue()
      await s.db.run('UPDATE managed_group_revisions SET payload_digest = $1 WHERE group_id = $2', [
        'corrupt',
        s.group.id,
      ])
      const result = await s.makeWorker().runOnce()
      assert.equal(result.state, 'failed')
      assert.equal(result.code, 'DATA_UNREADABLE')
      assert.equal(s.calls.length, 0)
    }
  )

  check(
    'expiry can disable a protected remote collection after a group becomes unavailable',
    async (s) => {
      const remote = {
        ...configuredAddon('RetainedOnExpiry'),
        flags: { enabled: true, protected: true },
      }
      s.remote.set(`synthetic-${s.ids[0]}`, [remote])
      await s.db.run('UPDATE managed_accounts SET group_id = NULL WHERE id = $1', [s.ids[0]])
      await s.expire()
      assert.equal((await s.makeWorker().runOnce()).state, 'verified')
      assert.deepEqual(s.remote.get(`synthetic-${s.ids[0]}`), [])
      assert.deepEqual(await s.saved(), [remote])
    }
  )

  check(
    'an accepted write with a lost response resumes from the saved plan without another write',
    async (s) => {
      const protectedDefault = {
        ...configuredAddon('DefaultToken'),
        flags: { protected: true, enabled: true },
      }
      s.remote.set(`synthetic-${s.ids[0]}`, [protectedDefault])
      await s.enqueue()
      const first = s.makeWorker()
      s.hooks.set = async (session, addons) => {
        s.remote.set(session.id, addons)
        throw new Error('synthetic secret must not escape')
      }
      assert.equal((await first.runOnce()).code, 'OUTCOME_UNKNOWN')
      await first.close()
      delete s.hooks.set
      s.passTime(1000)
      const second = s.makeWorker()
      assert.equal((await second.runOnce()).state, 'verified')
      assert.equal(s.calls.filter((call) => call.method === 'set').length, 1)
      assert.deepEqual((await s.saved())[0], protectedDefault)
    }
  )

  check('same-length wrong URLs or persistent stale readback never verify', async (s) => {
    await s.enqueue()
    s.hooks.set = async () => {}
    s.hooks.get = async () => [{ ...configuredAddon('WrongCaseToken'), flags: { enabled: true } }]
    const result = await s.makeWorker().runOnce()
    assert.equal(result.code, 'VERIFICATION_MISMATCH')
    assert.equal(result.state, 'retrying')
    assert.equal((await s.repository.getAccount(firstAuth, s.ids[0])).verifiedAt, null)
    assert.equal(s.calls.filter((call) => call.method === 'get').length, 3)
  })

  check(
    'a retry preserves a new protected remote addon instead of replaying a destructive stale collection',
    async (s) => {
      await s.enqueue()
      const worker = s.makeWorker()
      s.hooks.set = async () => {
        throw new ProviderFailure('OUTCOME_UNKNOWN')
      }
      assert.equal((await worker.runOnce()).state, 'retrying')
      const extra = {
        ...configuredAddon('NewRemoteDefault'),
        flags: { protected: true, enabled: true },
      }
      s.remote.set(`synthetic-${s.ids[0]}`, [extra])
      delete s.hooks.set
      s.passTime(1000)
      assert.equal((await worker.runOnce()).state, 'verified')
      assert.equal(s.remote.get(`synthetic-${s.ids[0]}`)[0].transportUrl, extra.transportUrl)
      assert.equal((await s.saved())[0].transportUrl, extra.transportUrl)
    }
  )

  check('pause and failed snapshot persistence each prevent remote dispatch', async (s) => {
    await s.enqueue()
    s.hooks.get = async () => {
      await s.db.run('UPDATE managed_metadata SET write_paused = 1')
      return []
    }
    assert.equal((await s.makeWorker().runOnce()).code, 'WRITE_PAUSED')
    assert.equal(
      s.calls.some((call) => call.method === 'set'),
      false
    )
    assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 0)
  })

  check(
    'a failed plan commit rolls back snapshot, configuration and write intent together',
    async (s) => {
      await s.enqueue()
      const original = s.db.statement.bind(s.db)
      s.db.statement = (connection, method, sql, params) => {
        if (sql.startsWith('UPDATE managed_jobs SET execution_enc'))
          throw new Error('synthetic disk failure')
        return original(connection, method, sql, params)
      }
      try {
        assert.equal((await s.makeWorker().runOnce()).state, 'failed')
      } finally {
        s.db.statement = original
      }
      assert.deepEqual(await s.saved(), [])
      assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 0)
      assert.equal(
        s.calls.some((call) => call.method === 'set'),
        false
      )
    }
  )

  check(
    'expiry racing a write cannot report active completion and a later run disables everything',
    async (s) => {
      await s.enqueue()
      s.hooks.set = async (session, addons) => {
        s.remote.set(session.id, addons)
        await s.expire()
      }
      const worker = s.makeWorker()
      assert.equal((await worker.runOnce()).state, 'superseded')
      delete s.hooks.set
      assert.equal((await worker.runOnce()).state, 'verified')
      assert.deepEqual(s.remote.get(`synthetic-${s.ids[0]}`), [])
      assert.ok((await s.saved()).length > 0)
      assert.equal((await s.repository.getAccount(firstAuth, s.ids[0])).appliedTarget, 'suspended')
    }
  )

  check(
    'renewal during an in-flight disable preserves preferences and schedules current setup',
    async (s) => {
      const worker = s.makeWorker()
      await s.enqueue()
      await worker.runOnce()
      const original = await s.saved()
      await s.expire()
      s.hooks.set = async (session, addons) => {
        s.remote.set(session.id, addons)
        const account = await s.repository.getAccount(firstAuth, s.ids[0])
        await s.repository.setMembership(
          firstAuth,
          account.id,
          { mode: 'lifetime', expectedVersion: account.version },
          randomUUID()
        )
      }
      assert.equal((await worker.runOnce()).state, 'superseded')
      delete s.hooks.set
      assert.equal((await worker.runOnce()).state, 'verified')
      assert.deepEqual(await s.saved(), original)
      assert.equal((await s.repository.getAccount(firstAuth, s.ids[0])).suspendedAt, null)
    }
  )

  check(
    'safe-mode changes during a call requeue without claiming stale settings are verified',
    async (s) => {
      await s.enqueue()
      s.hooks.set = async (session, addons) => {
        s.remote.set(session.id, addons)
        await s.db.run('UPDATE managed_groups SET safe_mode = 0 WHERE id = $1', [s.group.id])
      }
      const worker = s.makeWorker()
      assert.equal((await worker.runOnce()).state, 'retrying')
      delete s.hooks.set
      assert.equal((await worker.runOnce()).state, 'verified')
    }
  )

  check('Retry-After and a provider outage hold the queue without retry storms', async (s) => {
    await s.enqueue()
    s.hooks.identity = async () => {
      throw new ProviderFailure('RATE_LIMITED', 60_000)
    }
    const worker = s.makeWorker()
    assert.equal((await worker.runOnce()).state, 'retrying')
    const job = await s.db.get("SELECT * FROM managed_jobs WHERE state = 'retrying'")
    assert.equal(job.due_at, s.now() + 60_000)
    for (let i = 0; i < 5; i++) assert.equal((await worker.runOnce()).state, 'backoff')
    assert.equal(s.calls.length, 1)
    delete s.hooks.identity
    s.passTime(60_000)
    assert.equal((await worker.runOnce()).state, 'verified')
  })

  check(
    'repeated network failures open the circuit and exhaust a finite retry budget',
    async (s) => {
      await s.enqueue()
      s.hooks.identity = async () => {
        throw new ProviderFailure('PROVIDER_UNAVAILABLE')
      }
      const worker = s.makeWorker()
      for (let attempt = 1; attempt <= 5; attempt++) {
        const result = await worker.runOnce()
        assert.equal(result.state, attempt === 5 ? 'failed' : 'retrying')
        if (attempt >= 3) assert.equal((await worker.runOnce()).state, 'backoff')
        s.passTime(30_000)
      }
      assert.equal(s.calls.length, 5)
      assert.equal((await worker.runOnce()).state, 'idle')
      assert.equal((await s.db.get('SELECT attempts FROM managed_jobs')).attempts, 5)
    }
  )

  check(
    'invalid credentials require attention without unattended login or repeated calls',
    async (s) => {
      await s.enqueue()
      s.hooks.identity = async () => {
        throw new ProviderFailure('INVALID_CREDENTIALS')
      }
      const worker = s.makeWorker()
      const result = await worker.runOnce()
      assert.equal(result.state, 'failed')
      assert.equal(result.code, 'INVALID_CREDENTIALS')
      s.passTime(86_400_000)
      assert.equal((await worker.runOnce()).state, 'idle')
      assert.deepEqual(
        s.calls.map((call) => call.method),
        ['identity']
      )
    }
  )

  check(
    'only one local runner owns a database and concurrent polls share one execution',
    async (s) => {
      await s.enqueue()
      const worker = s.makeWorker()
      assert.throws(() => s.makeWorker(), { code: 'INVALID_INPUT' })
      const first = worker.runOnce()
      assert.equal(worker.runOnce(), first)
      assert.equal((await first).state, 'verified')
      assert.equal(s.calls.filter((call) => call.method === 'set').length, 1)
      await worker.close()
      const replacement = s.makeWorker()
      await worker.close()
      assert.throws(() => s.makeWorker(), { code: 'INVALID_INPUT' })
      assert.equal((await replacement.runOnce()).state, 'idle')
    }
  )

  check(
    'bounded expiry scans latch suspension while paused and survive a backward clock',
    async (s) => {
      await s.expire()
      const before = await s.repository.getAccount(firstAuth, s.ids[0])
      await s.db.run('UPDATE managed_metadata SET write_paused = 1')
      assert.deepEqual(
        (
          await Promise.all([s.jobs.scanExpiry({ limit: 1 }), s.jobs.scanExpiry({ limit: 1 })])
        ).sort(),
        [0, 1]
      )
      assert.equal(s.calls.length, 0)
      const suspended = await s.repository.getAccount(firstAuth, s.ids[0])
      assert.equal(suspended.suspendedAt, s.now())
      assert.equal(suspended.version, before.version + 1)
      s.advance(-86_400_000)
      const row = await s.db.get('SELECT * FROM managed_accounts WHERE id = $1', [s.ids[0]])
      assert.equal(currentAccountTarget(row, s.now()), 'suspended')
      await s.publish()
      assert.equal(
        (await s.db.get('SELECT target FROM managed_jobs ORDER BY created_at DESC LIMIT 1')).target,
        'suspended'
      )
      assert.equal(await s.jobs.scanExpiry(), 0)
      assert.deepEqual(await s.saved(), [])
    }
  )

  check('staged, lifetime and future memberships are excluded from expiry scanning', async (s) => {
    await s.expire()
    await s.db.run("UPDATE managed_accounts SET state = 'staged' WHERE id = $1", [s.ids[0]])
    assert.equal(await s.jobs.scanExpiry(), 0)
    await s.db.run(
      "UPDATE managed_accounts SET state = 'active', expiry_at = expiry_at + 10000 WHERE id = $1",
      [s.ids[0]]
    )
    assert.equal(await s.jobs.scanExpiry(), 0)
    await s.repository.setMembership(
      firstAuth,
      s.ids[0],
      { mode: 'lifetime', expectedVersion: 1 },
      randomUUID()
    )
    s.advance(1_000_000)
    assert.equal(await s.jobs.scanExpiry(), 0)
  })

  check(
    'a failed expiry enqueue rolls back observation so the next scan can recover it',
    async (s) => {
      await s.expire()
      const original = s.db.statement.bind(s.db)
      s.db.statement = (connection, method, sql, params) => {
        if (sql.startsWith('INSERT INTO managed_jobs')) throw new Error('synthetic queue failure')
        return original(connection, method, sql, params)
      }
      try {
        await assert.rejects(s.jobs.scanExpiry(), /synthetic queue failure/)
      } finally {
        s.db.statement = original
      }
      assert.equal((await s.repository.getAccount(firstAuth, s.ids[0])).suspendedAt, null)
      assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 0)
      assert.equal(await s.jobs.scanExpiry(), 1)
    }
  )

  test(
    `${prefix}: 100 accounts retain bounded scanning, one job each and shared request spacing`,
    options,
    async (t) => {
      const s = await prepareWorkerFixture(await fixture(t), t, { count: 100 })
      for (const id of s.ids) await s.expire(id)
      assert.equal(await s.jobs.scanExpiry({ limit: 40 }), 40)
      assert.equal(await s.jobs.scanExpiry({ limit: 40 }), 40)
      assert.equal(await s.jobs.scanExpiry({ limit: 40 }), 20)
      assert.equal(await s.jobs.scanExpiry({ limit: 40 }), 0)
      const worker = s.makeWorker()
      for (let i = 0; i < 100; i++) assert.equal((await worker.runOnce()).state, 'verified')
      assert.equal((await worker.runOnce()).state, 'idle')
      assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 100)
      assert.equal(s.calls.filter((call) => call.method === 'set').length, 0)
      assert.equal(s.calls.length, 200)
      for (let i = 1; i < s.calls.length; i++) assert.ok(s.calls[i].at - s.calls[i - 1].at >= 500)
    }
  )
}
