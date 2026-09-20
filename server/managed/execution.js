import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { checkedCollection } from './projection.js'

export const providerIdentityKey = (crypto, id) =>
  crypto.fingerprint(id, {
    owner: 'deployment',
    id: 'stremio',
    purpose: 'provider-identity',
  })

/** Internal only: secrets and a policy stamp never leave the execution service. */
export async function readExecutionPolicy(tx, account, crypto, target) {
  const binding = (purpose) => ({ owner: account.owner_id, id: account.id, purpose })
  const provider = crypto.open(account.provider_enc, binding('provider-session'))
  if (
    !provider ||
    typeof provider.id !== 'string' ||
    !provider.id ||
    provider.id.length > 256 ||
    typeof provider.authKey !== 'string' ||
    !provider.authKey ||
    provider.authKey.length > 16_384 ||
    !equalSecret(account.provider_key, providerIdentityKey(crypto, provider.id))
  )
    throw new ManagedError('DATA_UNREADABLE')
  const saved = checkedCollection(crypto.open(account.configuration_enc, binding('configuration')))
  let group = [],
    personal = [],
    safeMode = true,
    revision = null
  if (target === 'active') {
    if (!account.group_id) throw new ManagedError('INVALID_STATE')
    const row = await tx.get('SELECT * FROM managed_groups WHERE owner_id = $1 AND id = $2', [
      account.owner_id,
      account.group_id,
    ])
    if (!row || row.archived || row.published_revision === null)
      throw new ManagedError('INVALID_STATE')
    revision = row.published_revision
    const published = await tx.get(
      'SELECT * FROM managed_group_revisions WHERE owner_id = $1 AND group_id = $2 AND revision = $3',
      [account.owner_id, row.id, revision]
    )
    if (!published) throw new ManagedError('DATA_UNREADABLE')
    group = checkedCollection(
      crypto.open(published.config_enc, {
        owner: account.owner_id,
        id: row.id,
        purpose: `group-revision:${revision}`,
      })
    )
    if (
      !equalSecret(
        published.payload_digest,
        crypto.fingerprint(group, {
          owner: account.owner_id,
          id: row.id,
          purpose: 'group-payload',
        })
      ) ||
      (!group.some((addon) => addon.flags?.enabled !== false) && published.explicit_empty !== 1)
    )
      throw new ManagedError('DATA_UNREADABLE')
    personal = checkedCollection(crypto.open(account.personal_enc, binding('personal-addons')))
    const owner = await tx.get('SELECT safe_mode FROM managed_owners WHERE owner_id = $1', [
      account.owner_id,
    ])
    if (!owner) throw new ManagedError('DATA_UNREADABLE')
    safeMode = (account.safe_mode ?? row.safe_mode ?? owner.safe_mode) === 1
  }
  const stamp = crypto.fingerprint(
    { provider, group, personal, safeMode, revision, groupId: account.group_id },
    binding('execution-policy')
  )
  return { provider, group, personal, saved, safeMode, target, stamp }
}

export function checkedExecutionPlan(plan) {
  if (!plan || typeof plan.stamp !== 'string' || !/^[a-f0-9]{64}$/.test(plan.stamp))
    throw new ManagedError('DATA_UNREADABLE')
  return {
    stamp: plan.stamp,
    configuration: checkedCollection(plan.configuration),
    expected: checkedCollection(plan.expected),
  }
}
