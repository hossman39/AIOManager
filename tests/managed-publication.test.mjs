import { DB } from '../server/db.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { prepareManagedFixture, firstAuth, syntheticKey } from './managed-contract.mjs'
import {
  managedPublicationContract,
  preparePublicationFixture,
} from './managed-publication-contract.mjs'
import { createManagedRepository } from '../server/managed/repository.js'
import { initializeManagedCrypto } from '../server/managed/crypto.js'
import { migrateManagedSchema } from '../server/managed/schema.js'
import { PUBLICATION_PREVIEW_TTL_MS } from '../server/managed/publication.js'

managedPublicationContract('SQLite group publication', {}, async (t) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db)
})

test('file-backed publication retains its cohort and replays a committed request after restart', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-publication-restart-'))
  const connections = []
  t.after(async () => {
    try {
      for (const db of connections) await db.close()
    } finally {
      const target = path.resolve(directory)
      assert.equal(path.dirname(target), path.resolve(tmpdir()))
      assert.ok(path.basename(target).startsWith('aiomanager-publication-restart-'))
      await rm(target, { recursive: true, force: true })
    }
  })
  const open = async () => {
    const db = new DB({ env: {}, sqlitePath: path.join(directory, 'aio.db') })
    connections.push(db)
    await db.init()
    return db
  }
  const first = await open()
  const storage = await preparePublicationFixture(await prepareManagedFixture(first))
  await storage.activateAll()
  const preview = await storage.preview()
  const input = { expectedVersion: preview.version, receipt: preview.receipt }
  const key = randomUUID()
  const published = await storage.repository.publishGroup(firstAuth, storage.group.id, input, key)
  await first.close()
  const raw = await readFile(path.join(directory, 'aio.db'))
  assert.equal(raw.includes(Buffer.from('GroupToken')), false)
  storage.advance(PUBLICATION_PREVIEW_TTL_MS + 1)
  const second = await open()
  await migrateManagedSchema(second)
  const crypto = await initializeManagedCrypto(second, { primary: syntheticKey })
  // Replay must not require another network validation (or an enabled adapter).
  const repository = createManagedRepository({
    db: second,
    crypto,
    now: storage.now,
    legacyKeys: [syntheticKey],
  })
  const replay = await repository.publishGroup(firstAuth, storage.group.id, input, key)
  assert.equal(replay.replayed, true)
  assert.equal(replay.deploymentId, published.deploymentId)
  assert.equal(
    (await repository.getGroupDeployment(firstAuth, storage.group.id)).deployment.id,
    published.deploymentId
  )
  assert.equal(
    (await repository.getDeployment(firstAuth, published.deploymentId)).counts.pending,
    3
  )
  assert.equal((await second.get('SELECT COUNT(*) AS count FROM managed_jobs')).count, 3)
})
