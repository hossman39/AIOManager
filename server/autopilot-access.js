import { decrypt } from './crypto.js'
import { equalSecret } from './managed/crypto.js'

const denied = () => Object.assign(new Error('Account access denied'), { statusCode: 403 })

// Owner binding is immutable. Existing installations can prove ownership with the
// provider credential already held by the unlocked client and stored on the rules.
export async function authorizeAutopilotAccount(tx, owner, account, proof, create) {
  const { accountId, keys } = account
  if (typeof accountId !== 'string' || !accountId || accountId.length > 256) throw denied()
  const binding = await tx.get(
    'SELECT owner_id FROM autopilot_account_owners WHERE account_id = $1',
    [accountId]
  )
  if (binding) {
    if (binding.owner_id !== owner) throw denied()
    return true
  }
  const rules = await tx.query('SELECT auth_key FROM autopilot_rules WHERE account_id = $1', [
    accountId,
  ])
  if (rules.length) {
    if (!proof || !rules.every((row) => equalSecret(decrypt(row.auth_key, keys), proof)))
      throw denied()
  } else {
    if (
      await tx.get('SELECT 1 AS present FROM failover_history WHERE account_id = $1 LIMIT 1', [
        accountId,
      ])
    )
      throw denied()
    if (!create) return false
  }
  await tx.run(
    'INSERT INTO autopilot_account_owners (account_id, owner_id) VALUES ($1,$2) ON CONFLICT (account_id) DO NOTHING',
    [accountId, owner]
  )
  const saved = await tx.get(
    'SELECT owner_id FROM autopilot_account_owners WHERE account_id = $1',
    [accountId]
  )
  if (saved?.owner_id !== owner) throw denied()
  return true
}
