import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { DB } from '../server/db.js'
import { prepareManagedFixture } from './managed-contract.mjs'
import { acquireWriterOwnership } from '../server/managed/writer-owner.js'

test('SQLite writer ownership excludes another process and quarantines an unclean restart', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-writer-test-'))
  const filename = path.join(directory, 'aio.db'),
    db = new DB({ env: {}, sqlitePath: filename })
  let owner, child
  try {
    await db.init()
    const fixture = await prepareManagedFixture(db)
    owner = await acquireWriterOwnership(db, { now: fixture.now })
    const script = `
      import { DB } from ${JSON.stringify(new URL('../server/db.js', import.meta.url).href)};
      import { acquireWriterOwnership } from ${JSON.stringify(new URL('../server/managed/writer-owner.js', import.meta.url).href)};
      const db = new DB({ env: {}, sqlitePath: process.env.SYNTHETIC_DB });
      await db.init();
      try { const owner = await acquireWriterOwnership(db); console.log('owned'); await owner.close(); }
      catch (error) { console.log(error.code); }
      finally { await db.close(); }
    `
    child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      windowsHide: true,
      env: { ...process.env, SYNTHETIC_DB: filename },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    const timeout = setTimeout(() => child.kill(), 10_000)
    const code = await new Promise((resolve) => child.once('exit', resolve))
    clearTimeout(timeout)
    assert.equal(code, 0)
    assert.equal(output.trim(), 'WRITER_UNAVAILABLE')
    await owner.close(false)
    owner = await acquireWriterOwnership(db, { now: fixture.now, recoveryMs: 30_000 })
    await assert.rejects(owner.assertOwned(), { code: 'WRITER_UNAVAILABLE' })
    fixture.advance(30_000)
    await owner.assertOwned()
    await owner.close()
    await owner.close()
    const replacement = await acquireWriterOwnership(db, { now: fixture.now })
    await owner.close()
    await replacement.assertOwned()
    await replacement.close()
  } finally {
    child?.kill()
    await owner?.close()
    await db.close()
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-writer-test-'))
    await rm(target, { recursive: true, force: true })
  }
})
