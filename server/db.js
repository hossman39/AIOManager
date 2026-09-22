import Database from 'better-sqlite3'
import pg from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'

const { Pool, types } = pg
types.setTypeParser(types.builtins.INT8, (value) => Number(value))

function positiveInteger(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function postgresOptions(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL')
  let parsedUrl
  try {
    parsedUrl = new URL(env.DATABASE_URL)
  } catch {
    throw new Error('DATABASE_URL is invalid')
  }
  if (!['postgres:', 'postgresql:'].includes(parsedUrl.protocol))
    throw new Error('DATABASE_URL is invalid')
  const hostname = parsedUrl.hostname
  // pg lets ssl query parameters replace the supplied TLS policy. Require the
  // explicit option instead of silently accepting sslmode=no-verify/disable.
  for (const name of ['sslmode', 'ssl', 'sslcert', 'sslkey', 'sslrootcert']) {
    if (parsedUrl.searchParams.has(name))
      throw new Error('Set database TLS with DB_SSL_MODE, not URL parameters')
  }
  const local = ['localhost', '127.0.0.1', '[::1]', 'db', 'aiomanager-db'].includes(hostname)
  const mode = env.DB_SSL_MODE || (local ? 'disable' : 'verify-full')
  if (!['disable', 'verify-full'].includes(mode)) throw new Error('Unsupported DB_SSL_MODE')
  return {
    connectionString: env.DATABASE_URL,
    ssl: mode === 'disable' ? false : { rejectUnauthorized: true },
    max: positiveInteger(env.DB_POOL_SIZE, 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: positiveInteger(env.DB_CONNECTION_TIMEOUT, 10_000),
  }
}

/**
 * All parameterized statements use $1, $2, ... placeholders. SQLite binds them
 * by name, preserving repeated/out-of-order references without rewriting SQL.
 * Transactions must contain database work only, never provider/network calls.
 * SQLite access is serialized across the entire async transaction; PostgreSQL
 * uses one checked-out client. Neither engine permits nested transactions.
 */
export class DB {
  constructor({
    env = process.env,
    type = env.DB_TYPE || 'sqlite',
    sqlitePath = env.SQLITE_DB_PATH || 'data/aio.db',
    poolFactory = (options) => new Pool(options),
    sqliteFactory = (filename) => new Database(filename),
    retryDelay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {}) {
    if (!['sqlite', 'postgres'].includes(type)) throw new Error('Unsupported DB_TYPE')
    this.type = type
    this.sqlitePath = sqlitePath
    this.env = { ...env }
    this.poolFactory = poolFactory
    this.sqliteFactory = sqliteFactory
    this.retryDelay = retryDelay
    this.client = null
    this.pool = null
    this.isHealthy = false
    this.initializing = null
    this.closing = false
    this.closePromise = null
    this.queue = Promise.resolve()
    this.context = new AsyncLocalStorage()
  }

  async init() {
    if (this.closing) throw new Error('Database is closing')
    if (this.initializing) return this.initializing
    if (this.client || this.pool) return
    this.initializing = this.initialize()
    try {
      await this.initializing
    } finally {
      this.initializing = null
    }
  }

  async initialize() {
    if (this.type === 'sqlite') {
      this.client = this.sqliteFactory(this.sqlitePath)
      try {
        this.client.pragma('foreign_keys = ON')
        this.client.pragma('busy_timeout = 5000')
        this.isHealthy = true
      } catch (error) {
        this.client.close()
        this.client = null
        throw error
      }
      return
    }
    this.pool = this.poolFactory(postgresOptions(this.env))
    this.pool.on('error', () => {
      this.isHealthy = false
    })
    const attempts = positiveInteger(this.env.DB_MAX_RETRIES, 5)
    try {
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const client = await this.pool.connect()
          try {
            await client.query('SELECT 1')
          } finally {
            client.release()
          }
          this.isHealthy = true
          return
        } catch {
          if (attempt === attempts) throw new Error('Unable to connect to PostgreSQL')
          await this.retryDelay(2 ** (attempt - 1) * 1000)
        }
      }
    } catch (error) {
      await this.pool.end()
      this.pool = null
      throw error
    }
  }

  exclusive(operation) {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  assertOpen() {
    if (this.closing || !(this.type === 'sqlite' ? this.client : this.pool)) {
      throw new Error('Database is not open')
    }
  }

  async withConnection(operation) {
    const transaction = this.context.getStore()
    if (transaction) {
      if (!transaction.active) throw new Error('Transaction is no longer active')
      return operation(transaction.connection)
    }
    this.assertOpen()
    if (this.type === 'sqlite') return this.exclusive(() => operation(this.client))
    return operation(this.pool)
  }

  async statement(connection, method, sql, params) {
    if (!Array.isArray(params)) throw new TypeError('SQL parameters must be an array')
    if (this.type === 'postgres') {
      const result = await connection.query(sql, params)
      if (method === 'get') return result.rows[0]
      if (method === 'run') return { changes: result.rowCount }
      return result.rows
    }
    const prepared = connection.prepare(sql)
    const bindings = Object.fromEntries(params.map((value, index) => [String(index + 1), value]))
    const result = params.length ? prepared[method](bindings) : prepared[method]()
    return method === 'run' ? { changes: result.changes } : result
  }

  query(sql, params = []) {
    return this.withConnection((connection) => this.statement(connection, 'all', sql, params))
  }

  get(sql, params = []) {
    return this.withConnection((connection) => this.statement(connection, 'get', sql, params))
  }

  run(sql, params = []) {
    return this.withConnection((connection) => this.statement(connection, 'run', sql, params))
  }

  exec(sql) {
    return this.withConnection((connection) =>
      this.type === 'sqlite' ? connection.exec(sql) : connection.query(sql)
    )
  }

  pragma(sql) {
    return this.withConnection((connection) =>
      this.type === 'sqlite' ? connection.pragma(sql) : null
    )
  }

  async transaction(callback) {
    if (this.context.getStore()) throw new Error('Nested transactions are not supported')
    this.assertOpen()
    const execute = async (connection) => {
      const state = { connection, active: true }
      let rollbackFailed = false
      const guarded =
        (operation) =>
        async (...args) => {
          if (!state.active) throw new Error('Transaction is no longer active')
          return operation(...args)
        }
      const transaction = Object.freeze({
        type: this.type,
        query: guarded((sql, params = []) => this.statement(connection, 'all', sql, params)),
        get: guarded((sql, params = []) => this.statement(connection, 'get', sql, params)),
        run: guarded((sql, params = []) => this.statement(connection, 'run', sql, params)),
        exec: guarded((sql) =>
          this.type === 'sqlite' ? connection.exec(sql) : connection.query(sql)
        ),
      })
      try {
        await (this.type === 'sqlite'
          ? connection.exec('BEGIN IMMEDIATE')
          : connection.query('BEGIN'))
        try {
          const result = await this.context.run(state, () => callback(transaction))
          state.active = false
          await (this.type === 'sqlite' ? connection.exec('COMMIT') : connection.query('COMMIT'))
          return result
        } catch (error) {
          state.active = false
          try {
            await (this.type === 'sqlite'
              ? connection.exec('ROLLBACK')
              : connection.query('ROLLBACK'))
          } catch {
            rollbackFailed = true
            this.isHealthy = false
            if (this.type === 'sqlite') {
              connection.close()
              this.client = null
            }
          }
          throw error
        }
      } finally {
        state.active = false
        if (this.type === 'postgres') connection.release(rollbackFailed)
      }
    }
    if (this.type === 'sqlite') return this.exclusive(() => execute(this.client))
    return execute(await this.pool.connect())
  }

  async healthCheck() {
    try {
      await this.get('SELECT 1')
      this.isHealthy = true
      return true
    } catch {
      this.isHealthy = false
      return false
    }
  }

  async close() {
    if (this.context.getStore()) throw new Error('Cannot close during a transaction')
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      if (this.initializing) {
        try {
          await this.initializing
        } catch {
          /* already cleaned up */
        }
      }
      if (this.type === 'postgres') {
        if (this.pool) await this.pool.end()
        this.pool = null
      } else {
        await this.exclusive(() => {
          if (this.client) this.client.close()
          this.client = null
        })
      }
      this.isHealthy = false
    })()
    return this.closePromise
  }
}

export default new DB()
