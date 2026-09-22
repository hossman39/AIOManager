import { DB } from '../server/db.js'
import { managedStorageContract, prepareManagedFixture } from './managed-contract.mjs'

managedStorageContract('SQLite managed storage', {}, async (t) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db)
})
