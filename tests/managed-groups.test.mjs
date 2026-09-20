import { DB } from '../server/db.js'
import { prepareManagedFixture } from './managed-contract.mjs'
import { managedGroupsContract } from './managed-groups-contract.mjs'

managedGroupsContract('SQLite group configuration', {}, async (t) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db)
})
