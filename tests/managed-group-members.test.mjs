import { DB } from '../server/db.js'
import { prepareManagedFixture } from './managed-contract.mjs'
import { managedGroupMembersContract } from './managed-group-members-contract.mjs'

managedGroupMembersContract('SQLite group members', {}, async (t) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db)
})
