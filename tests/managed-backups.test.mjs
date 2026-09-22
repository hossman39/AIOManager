import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DB } from '../server/db.js'
import {
  firstAuth,
  parsedAccounts,
  prepareManagedFixture,
  syntheticKey,
} from './managed-contract.mjs'
import {
  writeManagedBackup,
  restoreManagedBackup,
  createManagedBackupScheduler,
} from '../server/managed/backups.js'
import { initializeManagedCrypto } from '../server/managed/crypto.js'
import { createManagedRepository } from '../server/managed/repository.js'
import { migrateManagedSchema } from '../server/managed/schema.js'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildServer } from '../server/app.js'
import { configuredAddon } from './fixtures/addon-config.mjs'
import { defaultExpiryNotice } from '../shared/expiry-notice.js'

test('daily encrypted snapshots restore credentials, selected timezone, and key material with all writes paused', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aiomanager-backup-test-'))
  const source = new DB({ env: {}, sqlitePath: ':memory:' }),
    restored = new DB({ env: {}, sqlitePath: ':memory:' })
  let scheduler
  try {
    await source.init()
    await restored.init()
    const s = await prepareManagedFixture(source)
    const staged = await s.repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
    const id = staged.accounts[0].id
    const cached = {
      accounts: [{ localId: 'backup-cache-account', email: 'Person@example.invalid' }],
    }
    assert.equal(
      (await s.repository.connectAccounts(firstAuth, cached)).connections[0].account.id,
      id
    )
    await s.repository.setMembership(
      firstAuth,
      id,
      { expectedVersion: 1, mode: 'term', local: '2027-02-03T12:30', timezone: 'Europe/Paris' },
      randomUUID()
    )
    const addon = { ...configuredAddon(), flags: { enabled: true, protected: false } }
    const group = (
      await s.repository.createGroup(
        firstAuth,
        { name: 'Backup group', addons: [addon], safeMode: null },
        randomUUID()
      )
    ).group
    const assigned = await s.repository.assignGroup(
      firstAuth,
      { groupId: group.id, accounts: [{ id, expectedVersion: 2 }] },
      randomUUID()
    )
    const custom = {
      ...addon,
      metadata: { ...addon.metadata, customName: 'Private account override' },
    }
    await s.repository.setAccountAddons(
      firstAuth,
      id,
      {
        expectedVersion: assigned.accounts[0].account.version,
        groupVersion: group.version,
        addons: [custom],
        allowEmpty: false,
      },
      randomUUID()
    )
    const expiryNotice = await s.repository.saveExpiryNotice(
      firstAuth,
      {
        expectedVersion: 1,
        settings: {
          ...defaultExpiryNotice,
          enabled: true,
          baseUrl: 'https://notice.example.invalid',
          message: 'Private renewal instructions',
        },
      },
      randomUUID()
    )
    const keys = { primary: syntheticKey, candidates: [syntheticKey, 'synthetic-retired-key'] }
    const accessKey = await s.repository.createApiKey(firstAuth, { name: 'Backup integration', scopes: ['read'], expiresInDays: 365 })
    await s.repository.linkIntegrationAccount(firstAuth, { externalRef: 'backup:customer', accountId: id }, randomUUID())
    scheduler = createManagedBackupScheduler({ db: source, keys, directory, now: s.now })
    const backup = await scheduler.run()
    assert.ok(backup.filename)
    assert.equal(await scheduler.run(), null)
    const bytes = await fs.readFile(backup.filename)
    assert.equal(bytes.includes(Buffer.from('Person@example.invalid')), false)
    assert.equal(bytes.includes(Buffer.from(syntheticKey)), false)
    assert.equal(bytes.includes(Buffer.from('Private account override')), false)
    assert.equal(bytes.includes(Buffer.from('Private renewal instructions')), false)
    await restored.exec(
      'CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT, password TEXT, updated_at BIGINT)'
    )
    await migrateManagedSchema(restored)
    await initializeManagedCrypto(restored, { primary: 'synthetic-new-database' })
    const before = await restored.get('SELECT * FROM managed_metadata')
    await assert.rejects(
      restoreManagedBackup({ db: restored, filename: backup.filename, secret: 'wrong-key' })
    )
    assert.deepEqual(await restored.get('SELECT * FROM managed_metadata'), before)
    const damaged = Buffer.from(bytes)
    damaged[damaged.length - 1] ^= 1
    const corrupt = path.join(directory, 'corrupt.aiobackup')
    await fs.writeFile(corrupt, damaged)
    await assert.rejects(
      restoreManagedBackup({ db: restored, filename: corrupt, secret: syntheticKey })
    )
    assert.equal((await restored.get('SELECT COUNT(*) AS count FROM kv_store')).count, 0)
    assert.deepEqual(await restored.get('SELECT * FROM managed_metadata'), before)
    const result = await restoreManagedBackup({
      db: restored,
      filename: backup.filename,
      secret: syntheticKey,
    })
    assert.deepEqual(result.keys, keys)
    const crypto = await initializeManagedCrypto(restored, keys)
    const repository = createManagedRepository({ db: restored, crypto, legacyKeys: [syntheticKey] })
    const account = await repository.getAccount(firstAuth, id)
    assert.equal(account.expiry.timezone, 'Europe/Paris')
    assert.equal(account.email, 'Person@example.invalid')
    assert.equal(account.setupSaved, true)
    const setup = await repository.getAccountAddons(firstAuth, id)
    assert.deepEqual(setup.addons, [custom])
    assert.equal((await repository.listApiKeys(firstAuth)).keys[0].id, accessKey.key.id)
    assert.equal((await repository.integrationAccount(firstAuth, 'backup:customer')).accountId, id)
    assert.deepEqual((await repository.getExpiryNotice(firstAuth)).settings, expiryNotice.settings)
    assert.deepEqual(setup.overrides.addons, [custom])
    assert.equal(
      (await repository.connectAccounts(firstAuth, cached)).connections[0].account.id,
      id
    )
    assert.equal((await restored.get('SELECT COUNT(*) AS count FROM managed_accounts')).count, 1)
    assert.equal((await restored.get('SELECT write_paused FROM managed_metadata')).write_paused, 1)
    assert.equal(
      (await restored.get('SELECT write_paused FROM managed_owners LIMIT 1')).write_paused,
      1
    )
    await assert.rejects(
      restoreManagedBackup({ db: restored, filename: backup.filename, secret: syntheticKey }),
      /empty database/
    )
    // Fourteen successful daily archives are retained; unrelated files survive.
    for (let day = 0; day < 15; day++) {
      s.advance(86_400_000)
      await scheduler.run()
    }
    const names = await fs.readdir(directory)
    assert.equal(names.filter((name) => name.startsWith('aiomanager-')).length, 14)
    assert.ok(names.includes('corrupt.aiobackup'))
    await assert.rejects(writeManagedBackup({ db: source, keys, directory: corrupt }))
  } finally {
    await scheduler?.close()
    await source.close()
    await restored.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-backup-test-'))
    await fs.rm(target, { recursive: true, force: true })
  }
})

test('offline restore CLI isolates its database and boots with the complete restored keyring', async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'aiomanager-backup-cli-'))
  const db = new DB({ env: {}, sqlitePath: ':memory:' })
  let app
  try {
    await db.init()
    const fixture = await prepareManagedFixture(db)
    const staged = await fixture.repository.stageImport(firstAuth, parsedAccounts(), randomUUID())
    const keys = { primary: syntheticKey, candidates: [syntheticKey, 'synthetic-retired-key'] }
    const backup = await writeManagedBackup({
      db,
      keys,
      directory: path.join(directory, 'archives'),
    })
    const target = path.join(directory, 'restored')
    const invoke = () =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../server/restore-backup.js', import.meta.url)),
          backup.filename,
          target,
        ],
        {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15_000,
          env: {
            ...process.env,
            AIO_BACKUP_KEY: syntheticKey,
            AIO_RESTORE_DATABASE_URL: '',
            DB_TYPE: 'postgres',
            DATABASE_URL: 'postgres://must-never-be-opened.invalid/production',
            ENCRYPTION_KEY: 'wrong-existing-configuration',
          },
        }
      )
    const restored = invoke()
    assert.equal(restored.status, 0, restored.stderr)
    assert.equal(restored.stdout.includes(syntheticKey), false)
    const before = await fs.readFile(path.join(target, 'aio.db'))
    assert.equal(invoke().status, 1, 'An existing target is refused')
    assert.deepEqual(await fs.readFile(path.join(target, 'aio.db')), before)
    app = await buildServer({ env: {}, dataDir: target, logger: false, serveStatic: false })
    const headers = { 'x-manager-id': firstAuth.owner, 'x-sync-password': firstAuth.token }
    const response = await app.inject({
      method: 'GET',
      url: `/api/managed/accounts/${staged.accounts[0].id}`,
      headers,
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().email, 'Person@example.invalid')
    const status = await app.inject({ method: 'GET', url: '/api/managed/status', headers })
    assert.equal(status.json().writePaused, true)
    assert.deepEqual(
      JSON.parse(await fs.readFile(path.join(target, 'server_fallback_keys.json'), 'utf8')),
      keys.candidates
    )
  } finally {
    await app?.close()
    await db.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-backup-cli-'))
    await fs.rm(target, { recursive: true, force: true })
  }
})
