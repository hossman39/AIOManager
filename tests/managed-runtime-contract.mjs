import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { firstAuth, secondAuth, syntheticKey, parsedAccounts } from './managed-contract.mjs'
import { preparePublicationFixture } from './managed-publication-contract.mjs'
import { createManagedRuntime } from '../server/managed/runtime.js'
import { createManagedRepository } from '../server/managed/repository.js'
import { createStremioProvider, stremioCollection } from '../server/managed/stremio.js'
import { configuredAddon } from './fixtures/addon-config.mjs'
import { fakeStremio } from './fixtures/stremio.mjs'

async function runtimeFixture(storage) {
  const seeded = await preparePublicationFixture(storage, { count: 2 })
  await seeded.publish()
  const rows = await storage.db.query('SELECT * FROM managed_accounts ORDER BY id')
  const credentials = rows.map((row) =>
    storage.crypto.open(row.credentials_enc, {
      owner: firstAuth.owner,
      id: row.id,
      purpose: 'credentials',
    })
  )
  const fake = fakeStremio([
    ...credentials,
    { email: 'unmanaged@example.invalid', password: 'synthetic-only' },
  ])
  const provider = createStremioProvider({ fetch: fake.fetch, spacingMs: 0, now: storage.now })
  const runtime = createManagedRuntime({
    ...storage,
    provider,
    enabled: true,
    workerOptions: { monotonic: storage.now, random: () => 0.5, requestSpacingMs: 0 },
  })
  fake.hooks.before = () =>
    assert.equal(storage.db.context.getStore(), undefined, 'No provider request in a transaction')
  const repository = createManagedRepository({
    ...storage,
    runtime,
    legacyKeys: [syntheticKey],
    validateManifests: async () => true,
  })
  for (const row of rows)
    await repository.setMembership(
      firstAuth,
      row.id,
      { expectedVersion: row.record_version, mode: 'lifetime' },
      randomUUID()
    )
  await runtime.start({ schedule: false })
  await repository.setSettings(
    firstAuth,
    { expectedVersion: 1, writePaused: false, safeMode: true },
    randomUUID()
  )
  const id = rows[0].id,
    user = fake.accounts.get(credentials[0].email.toLowerCase())
  const preview = async () =>
    repository.previewActivation(firstAuth, id, {
      expectedVersion: (await repository.getAccount(firstAuth, id)).version,
      safeMode: null,
    })
  const activate = async () => {
    const review = await preview()
    return repository.activateAccount(
      firstAuth,
      id,
      {
        expectedVersion: review.version,
        receipt: review.receipt,
        allowEmpty: review.afterCount === 0,
      },
      randomUUID()
    )
  }
  return { ...seeded, repository, runtime, fake, user, id, preview, activate }
}

export function managedRuntimeContract(prefix, options, fixture) {
  const check = (name, fn) =>
    test(`${prefix}: ${name}`, options, async (t) => {
      const s = await runtimeFixture(await fixture(t))
      try {
        await fn(s, t)
      } finally {
        await s.runtime.close()
      }
    })
  check(
    'activation reviews without writes, binds identity, queues once and verifies the exact native descriptor',
    async (s) => {
      const defaultAddon = {
        ...configuredAddon('default'),
        flags: { official: true },
        manifest: { ...configuredAddon().manifest, id: 'com.linvo.cinemeta' },
      }
      s.user.addons = stremioCollection([defaultAddon])
      const review = await s.preview()
      assert.equal(review.beforeCount, 1)
      assert.equal(review.afterCount, 2)
      assert.equal(
        s.fake.calls.some((call) => call.type === 'AddonCollectionSet'),
        false
      )
      assert.equal(JSON.stringify(review).includes(s.user.authKey), false)
      const input = { expectedVersion: review.version, receipt: review.receipt },
        key = randomUUID()
      const saved = await s.repository.activateAccount(firstAuth, s.id, input, key)
      const count = s.fake.calls.length
      const replay = await s.repository.activateAccount(firstAuth, s.id, input, key)
      assert.equal(replay.replayed, true)
      assert.equal(replay.jobId, saved.jobId)
      assert.equal(s.fake.calls.length, count)
      assert.equal((await s.runtime.runOnce()).state, 'verified')
      const execution = await s.repository.accountExecution(firstAuth, s.id)
      assert.equal(execution.job.state, 'verified')
      assert.equal(s.user.addons.length, 2)
      assert.equal(s.user.addons[1].manifest.name, 'Custom')
      assert.equal(Object.hasOwn(s.user.addons[1], 'metadata'), false)
      assert.equal((await s.db.get('SELECT COUNT(*) AS count FROM managed_snapshots')).count, 1)
      await assert.rejects(s.repository.accountExecution(secondAuth, s.id), { code: 'NOT_FOUND' })
    }
  )
  check(
    'changed remote state or group policy invalidates a first-sync preview without enrollment',
    async (s) => {
      const review = await s.preview()
      s.user.addons = stremioCollection([configuredAddon('remote-change')])
      await assert.rejects(
        s.repository.activateAccount(
          firstAuth,
          s.id,
          { expectedVersion: review.version, receipt: review.receipt },
          randomUUID()
        ),
        { code: 'PREVIEW_STALE' }
      )
      assert.equal((await s.repository.getAccount(firstAuth, s.id)).state, 'staged')
      s.user.addons = []
      await s.db.run('UPDATE managed_owners SET safe_mode = 0 WHERE owner_id = $1', [
        firstAuth.owner,
      ])
      await assert.rejects(
        s.repository.activateAccount(
          firstAuth,
          s.id,
          { expectedVersion: review.version, receipt: review.receipt },
          randomUUID()
        ),
        { code: 'PREVIEW_STALE' }
      )
      assert.equal(
        s.fake.calls.some((call) => call.type === 'AddonCollectionSet'),
        false
      )
    }
  )
  check(
    'the legacy gate allows unmanaged writes and blocks actual enrolled identities across owners',
    async (s) => {
      const unmanaged = s.fake.accounts.get('unmanaged@example.invalid')
      await s.runtime.legacySet(unmanaged.authKey, [])
      await s.activate()
      const writes = s.fake.calls.filter((call) => call.type === 'AddonCollectionSet').length
      await assert.rejects(s.runtime.legacySet(s.user.authKey, []), { code: 'MANAGED_ACCOUNT' })
      assert.equal(s.fake.calls.filter((call) => call.type === 'AddonCollectionSet').length, writes)
      // A separate owner cannot enroll a second record for the same Stremio identity.
      const credentials = s.crypto.open(
        (await s.db.get('SELECT credentials_enc FROM managed_accounts WHERE id = $1', [s.id]))
          .credentials_enc,
        { owner: firstAuth.owner, id: s.id, purpose: 'credentials' }
      )
      await s.repository.stageImport(secondAuth, parsedAccounts([credentials]), randomUUID())
      const other = (await s.repository.listAccounts(secondAuth)).accounts[0]
      await s.repository.setMembership(
        secondAuth,
        other.id,
        { expectedVersion: other.version, mode: 'lifetime' },
        randomUUID()
      )
      // Sharing a provider binding is rejected before activation; no provider write can slip through.
      assert.equal(
        (await s.db.query('SELECT id FROM managed_accounts WHERE provider_key IS NOT NULL')).length,
        1
      )
    }
  )
  check(
    'expiry in a selected timezone retains setup, rechecks suspension, and renewal restores current preferences',
    async (s) => {
      await s.activate()
      await s.runtime.runOnce()
      let account = await s.repository.getAccount(firstAuth, s.id)
      await s.repository.setMembership(
        firstAuth,
        s.id,
        {
          expectedVersion: account.version,
          mode: 'term',
          timezone: 'Asia/Kathmandu',
          local: '2026-09-01T12:00',
        },
        randomUUID()
      )
      assert.equal((await s.runtime.runOnce()).state, 'verified')
      assert.deepEqual(s.user.addons, [])
      account = await s.repository.getAccount(firstAuth, s.id)
      assert.equal(account.expiry.timezone, 'Asia/Kathmandu')
      assert.equal(account.expired, true)
      assert.equal(
        (await s.repository.listAccounts(firstAuth, { view: 'expired' })).accounts.length,
        1
      )
      const before = await s.db.get(
        'SELECT configuration_enc FROM managed_accounts WHERE id = $1',
        [s.id]
      )
      assert.ok(
        s.crypto.open(before.configuration_enc, {
          owner: firstAuth.owner,
          id: s.id,
          purpose: 'configuration',
        }).length
      )
      s.user.addons = stremioCollection([configuredAddon('client-reinstalled')])
      s.advance(300_001)
      assert.equal((await s.runtime.runOnce()).state, 'verified')
      assert.deepEqual(s.user.addons, [])
      account = await s.repository.getAccount(firstAuth, s.id)
      await s.repository.setMembership(
        firstAuth,
        s.id,
        { expectedVersion: account.version, mode: 'lifetime' },
        randomUUID()
      )
      assert.equal((await s.runtime.runOnce()).state, 'verified')
      assert.ok(s.user.addons.some((addon) => addon.manifest.name === 'Custom'))
      assert.equal(
        (await s.repository.listAccounts(firstAuth, { view: 'expired' })).accounts.length,
        0
      )
      // Ordinary active-account drift is not periodically rewritten.
      s.user.addons = []
      s.advance(900_000)
      assert.equal((await s.runtime.runOnce()).state, 'idle')
      assert.deepEqual(s.user.addons, [])
    }
  )
  check(
    'pause prevents dispatch and resumes queued work without changing the intended version',
    async (s) => {
      const settings = await s.repository.status(firstAuth)
      await s.repository.setSettings(
        firstAuth,
        { expectedVersion: settings.version, writePaused: true, safeMode: true },
        randomUUID()
      )
      const activated = await s.activate()
      assert.equal((await s.runtime.runOnce()).state, 'idle')
      assert.equal(
        s.fake.calls.some((call) => call.type === 'AddonCollectionSet'),
        false
      )
      await s.repository.setSettings(
        firstAuth,
        { expectedVersion: settings.version + 1, writePaused: false, safeMode: true },
        randomUUID()
      )
      assert.equal((await s.runtime.runOnce()).state, 'verified')
      assert.equal((await s.repository.accountExecution(firstAuth, s.id)).job.id, activated.jobId)
    }
  )
  check(
    'failed offboarding retains credentials; verified cleanup deletes secrets and keeps replay and rollout history',
    async (s) => {
      await s.activate()
      await s.runtime.runOnce()
      const published = await s.publish()
      const account = await s.repository.getAccount(firstAuth, s.id),
        key = randomUUID()
      const body = { expectedVersion: account.version }
      await s.repository.requestSync(firstAuth, s.id, body, key, true)
      s.fake.hooks.before = (body) => {
        if (body.type === 'AddonCollectionSet') throw new Error('synthetic network failure')
      }
      assert.equal((await s.runtime.runOnce()).state, 'retrying')
      assert.ok(
        (await s.db.get('SELECT credentials_enc FROM managed_accounts WHERE id = $1', [s.id]))
          .credentials_enc
      )
      delete s.fake.hooks.before
      s.advance(5000)
      assert.equal((await s.runtime.runOnce()).state, 'verified')
      assert.deepEqual(s.user.addons, [])
      assert.equal(
        await s.db.get('SELECT id FROM managed_accounts WHERE id = $1', [s.id]),
        undefined
      )
      assert.equal(
        (
          await s.db.get('SELECT COUNT(*) AS count FROM managed_snapshots WHERE account_id = $1', [
            s.id,
          ])
        ).count,
        0
      )
      assert.equal(
        (await s.db.get('SELECT COUNT(*) AS count FROM managed_jobs WHERE account_id = $1', [s.id]))
          .count,
        0
      )
      assert.equal(
        (await s.repository.requestSync(firstAuth, s.id, body, key, true)).replayed,
        true
      )
      assert.ok((await s.repository.accountExecution(firstAuth, s.id)).removedAt)
      await s.repository.getDeployment(firstAuth, published.deploymentId)
      await assert.rejects(s.runtime.legacySet(s.user.authKey, [configuredAddon()]), {
        code: 'MANAGED_ACCOUNT',
      })
    }
  )
  check(
    'reconnecting verifies credentials, preserves identity, and retries without storing plaintext secrets',
    async (s) => {
      await s.activate()
      await s.runtime.runOnce()
      s.user.password = ' Synthetic replacement password '
      s.user.authKey = 'synthetic-rotated-key'
      let account = await s.repository.getAccount(firstAuth, s.id)
      await s.repository.requestSync(
        firstAuth,
        s.id,
        { expectedVersion: account.version },
        randomUUID()
      )
      assert.equal((await s.runtime.runOnce()).state, 'failed')
      account = await s.repository.getAccount(firstAuth, s.id)
      await assert.rejects(
        s.repository.reconnectAccount(
          firstAuth,
          s.id,
          { expectedVersion: account.version, password: 'wrong' },
          randomUUID()
        ),
        { code: 'INVALID_CREDENTIALS' }
      )
      const key = randomUUID(),
        body = { expectedVersion: account.version, password: s.user.password }
      await s.repository.reconnectAccount(firstAuth, s.id, body, key)
      const calls = s.fake.calls.length
      assert.equal((await s.repository.reconnectAccount(firstAuth, s.id, body, key)).replayed, true)
      assert.equal(s.fake.calls.length, calls)
      assert.equal((await s.runtime.runOnce()).state, 'verified')
      assert.equal(
        JSON.stringify(await s.db.query('SELECT * FROM managed_accounts')).includes(
          s.user.password
        ),
        false
      )
      s.user.id = 'synthetic-different-person'
      account = await s.repository.getAccount(firstAuth, s.id)
      await assert.rejects(
        s.repository.reconnectAccount(
          firstAuth,
          s.id,
          { expectedVersion: account.version, password: s.user.password },
          randomUUID()
        ),
        { code: 'IDENTITY_MISMATCH' }
      )
    }
  )
}
