import { DB } from '../server/db.js'
import { prepareManagedFixture } from './managed-contract.mjs'
import { integrationContract } from './integration-contract.mjs'

integrationContract('SQLite integration access', {}, async (t) => {
  const db = new DB({ env: {}, sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db)
})
