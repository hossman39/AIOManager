import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DB, postgresOptions } from '../server/db.js'

async function sqlite(t, filename = ':memory:') {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: filename })
  await db.init()
  t.after(() => db.close())
  await db.exec('CREATE TABLE IF NOT EXISTS sample (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function latch() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('SQLite binds numbered, repeated, and reordered parameters without editing SQL literals', async (t) => {
  const db = await sqlite(t)
  assert.deepEqual(
    await db.get("SELECT $2 AS second, $1 AS first, $2 AS again, '$1' AS literal", ['A', 'B']),
    { second: 'B', first: 'A', again: 'B', literal: '$1' }
  )
  assert.deepEqual(await db.run('INSERT INTO sample VALUES ($1, $2)', ['one', 'value']), {
    changes: 1,
  })
  assert.deepEqual(await db.query('SELECT * FROM sample'), [{ id: 'one', value: 'value' }])
})

test('SQLite commits an awaited transaction and returns its result', async (t) => {
  const db = await sqlite(t)
  const result = await db.transaction(async (tx) => {
    await tx.run('INSERT INTO sample VALUES ($1, $2)', ['one', 'first'])
    await tx.run('INSERT INTO sample VALUES ($1, $2)', ['two', 'second'])
    return (await tx.query('SELECT * FROM sample')).length
  })
  assert.equal(result, 2)
  assert.equal((await db.query('SELECT * FROM sample')).length, 2)
})

test('SQLite rolls back all writes after an application or constraint failure', async (t) => {
  const db = await sqlite(t)
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO sample VALUES ($1, $2)', ['one', 'first'])
      await tx.run('INSERT INTO sample VALUES ($1, $2)', ['one', 'duplicate'])
    }),
    /UNIQUE/
  )
  assert.deepEqual(await db.query('SELECT * FROM sample'), [])
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run('INSERT INTO sample VALUES ($1, $2)', ['two', 'second'])
      throw new Error('Synthetic failure')
    }),
    /Synthetic failure/
  )
  assert.deepEqual(await db.query('SELECT * FROM sample'), [])
  assert.equal(await db.healthCheck(), true)
})

test('unrelated SQLite requests cannot join or observe an in-flight transaction', async (t) => {
  const db = await sqlite(t)
  const entered = latch()
  const release = latch()
  const transaction = db.transaction(async (tx) => {
    await tx.run('INSERT INTO sample VALUES ($1, $2)', ['transaction', 'rollback'])
    entered.resolve()
    await release.promise
    throw new Error('Rollback')
  })
  const rejected = assert.rejects(transaction, /Rollback/)
  await entered.promise
  let completed = false
  const unrelated = db
    .run('INSERT INTO sample VALUES ($1, $2)', ['outside', 'retained'])
    .then(() => {
      completed = true
    })
  const read = db.query('SELECT * FROM sample')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(completed, false)
  release.resolve()
  await rejected
  await unrelated
  assert.deepEqual(await read, [{ id: 'outside', value: 'retained' }])
})

test('ambient calls use the transaction and nested transactions fail promptly', async (t) => {
  const db = await sqlite(t)
  await assert.rejects(
    db.transaction(async () => {
      await db.run('INSERT INTO sample VALUES ($1, $2)', ['one', 'rollback'])
      await db.transaction(async () => {})
    }),
    /Nested transactions/
  )
  assert.deepEqual(await db.query('SELECT * FROM sample'), [])
})

test('transaction handles cannot write after commit or rollback', async (t) => {
  const db = await sqlite(t)
  let escaped
  await db.transaction(async (tx) => {
    escaped = tx
  })
  await assert.rejects(
    escaped.run('INSERT INTO sample VALUES ($1, $2)', ['late', 'no']),
    /no longer active/
  )
  await assert.rejects(
    db.transaction(async (tx) => {
      escaped = tx
      throw new Error('Rollback')
    })
  )
  await assert.rejects(escaped.query('SELECT * FROM sample'), /no longer active/)
})

test('concurrent SQLite transactions serialize without losing updates', async (t) => {
  const db = await sqlite(t)
  await db.run('INSERT INTO sample VALUES ($1, $2)', ['counter', '0'])
  await Promise.all(
    Array.from({ length: 100 }, () =>
      db.transaction(async (tx) => {
        const row = await tx.get('SELECT value FROM sample WHERE id = $1', ['counter'])
        await tx.run('UPDATE sample SET value = $1 WHERE id = $2', [
          String(Number(row.value) + 1),
          'counter',
        ])
      })
    )
  )
  assert.equal((await db.get('SELECT value FROM sample WHERE id = $1', ['counter'])).value, '100')
})

test('SQLite persisted data survives close and a separate connection', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'aiomanager-db-test-'))
  // Only this uniquely created synthetic test directory is removed.
  t.after(async () => {
    const target = path.resolve(directory)
    assert.equal(path.dirname(target), path.resolve(tmpdir()))
    assert.ok(path.basename(target).startsWith('aiomanager-db-test-'))
    await rm(target, { recursive: true, force: true })
  })
  const filename = path.join(directory, 'synthetic.db')
  const first = new DB({ env: {}, type: 'sqlite', sqlitePath: filename })
  await first.init()
  await first.exec('CREATE TABLE sample (value TEXT)')
  await first.run('INSERT INTO sample VALUES ($1)', ['retained'])
  await first.close()
  const second = new DB({ env: {}, type: 'sqlite', sqlitePath: filename })
  await second.init()
  try {
    assert.deepEqual(await second.query('SELECT * FROM sample'), [{ value: 'retained' }])
  } finally {
    await second.close()
  }
})

test('close drains an active SQLite transaction and blocks new operations', async (t) => {
  const db = await sqlite(t)
  const entered = latch()
  const release = latch()
  const pending = db.transaction(async (tx) => {
    entered.resolve()
    await release.promise
    await tx.run('INSERT INTO sample VALUES ($1, $2)', ['one', 'value'])
  })
  await entered.promise
  const closing = db.close()
  await assert.rejects(db.query('SELECT * FROM sample'), /not open/)
  release.resolve()
  await pending
  await closing
  assert.equal(await db.healthCheck(), false)
})

function fakePostgres({ fail = () => false, connectFailure = false } = {}) {
  const events = []
  const client = {
    async query(sql, params) {
      events.push({ connection: 'client', sql, params })
      if (fail(sql)) throw new Error('Synthetic database failure')
      return { rows: [{ value: 1 }], rowCount: 1 }
    },
    release(destroy) {
      events.push({ release: true, destroy: Boolean(destroy) })
    },
  }
  const pool = {
    on() {},
    async connect() {
      events.push({ connect: true })
      if (connectFailure) throw new Error('Synthetic connection failure')
      return client
    },
    async query(sql, params) {
      events.push({ connection: 'pool', sql, params })
      if (fail(sql)) throw new Error('Synthetic database failure')
      return { rows: [{ value: 1 }], rowCount: 1 }
    },
    async end() {
      events.push({ end: true })
    },
  }
  const db = new DB({
    env: { DATABASE_URL: 'postgres://test:test@db:5432/synthetic', DB_MAX_RETRIES: '2' },
    type: 'postgres',
    poolFactory: () => pool,
    retryDelay: async () => {},
  })
  return { db, events }
}

test('PostgreSQL transaction uses one client, never pool.query, and releases it', async (t) => {
  const { db, events } = fakePostgres()
  await db.init()
  t.after(() => db.close())
  events.length = 0
  await db.transaction(async (tx) => {
    await tx.run('INSERT INTO synthetic VALUES ($1)', ['test'])
    await db.get('SELECT 1')
  })
  assert.deepEqual(
    events.filter((event) => event.sql).map((event) => [event.connection, event.sql]),
    [
      ['client', 'BEGIN'],
      ['client', 'INSERT INTO synthetic VALUES ($1)'],
      ['client', 'SELECT 1'],
      ['client', 'COMMIT'],
    ]
  )
  assert.equal(events.filter((event) => event.release).length, 1)
})

test('PostgreSQL rolls back failure and destroys a client if rollback fails', async (t) => {
  for (const failRollback of [false, true]) {
    const { db, events } = fakePostgres({
      fail: (sql) => sql === 'WRITE' || (failRollback && sql === 'ROLLBACK'),
    })
    await db.init()
    t.after(() => db.close())
    events.length = 0
    await assert.rejects(
      db.transaction((tx) => tx.run('WRITE')),
      /Synthetic/
    )
    assert.deepEqual(
      events.filter((event) => event.sql).map((event) => event.sql),
      ['BEGIN', 'WRITE', 'ROLLBACK']
    )
    assert.deepEqual(events.at(-1), { release: true, destroy: failRollback })
  }
})

test('failed PostgreSQL initialization releases/ends resources and permits explicit retry', async () => {
  const { db, events } = fakePostgres({ fail: () => true })
  await assert.rejects(db.init(), /Unable to connect/)
  assert.equal(events.filter((event) => event.release).length, 2)
  assert.equal(events.filter((event) => event.end).length, 1)
  assert.equal(db.pool, null)
  assert.equal(db.isHealthy, false)
  await db.close()
})

test('PostgreSQL TLS defaults verify remote certificates and never trusts hostname substrings', () => {
  assert.deepEqual(postgresOptions({ DATABASE_URL: 'postgres://u:p@remote.invalid/db' }).ssl, {
    rejectUnauthorized: true,
  })
  assert.deepEqual(
    postgresOptions({ DATABASE_URL: 'postgres://localhost:p@remote.invalid/db' }).ssl,
    { rejectUnauthorized: true }
  )
  assert.equal(postgresOptions({ DATABASE_URL: 'postgres://u:p@db:5432/db' }).ssl, false)
  assert.throws(
    () => postgresOptions({ DATABASE_URL: 'postgres://u:p@remote.invalid/db?sslmode=no-verify' }),
    /TLS/
  )
  assert.throws(() => postgresOptions({ DATABASE_URL: 'not-a-url' }), /invalid/)
})
