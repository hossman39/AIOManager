import { DB } from '../server/db.js'
import { prepareManagedFixture } from './managed-contract.mjs'
import { managedMembershipContract } from './managed-membership-contract.mjs'

managedMembershipContract('SQLite membership', {}, async (t, options) => {
  const db = new DB({ env: {}, type: 'sqlite', sqlitePath: ':memory:' })
  t.after(() => db.close())
  await db.init()
  return prepareManagedFixture(db, options)
})
