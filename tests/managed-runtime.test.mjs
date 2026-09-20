import { DB } from '../server/db.js'
import { prepareManagedFixture } from './managed-contract.mjs'
import { managedRuntimeContract } from './managed-runtime-contract.mjs'

managedRuntimeContract('SQLite managed lifecycle', {}, async (t) => {
  const db = new DB({ env: {}, sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db)
})
