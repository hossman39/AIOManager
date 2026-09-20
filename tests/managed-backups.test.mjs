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
    await s.repository.setMembership(
      firstAuth,
      id,
      { expectedVersion: 1, mode: 'term', local: '2027-02-03T12:30', timezone: 'Europe/Paris' },
      randomUUID()
    )
    const keys = { primary: syntheticKey, candidates: [syntheticKey, 'synthetic-retired-key'] }
    scheduler = createManagedBackupScheduler({ db: source, keys, directory, now: s.now })
    const backup = await scheduler.run()
    assert.ok(backup.filename)
    assert.equal(await scheduler.run(), null)
    const bytes = await fs.readFile(backup.filename)
    assert.equal(bytes.includes(Buffer.from('Person@example.invalid')), false)
    assert.equal(bytes.includes(Buffer.from(syntheticKey)), false)
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
