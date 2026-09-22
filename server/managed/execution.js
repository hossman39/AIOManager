import { equalSecret } from './crypto.js'
import { ManagedError } from './errors.js'
import { checkedCollection } from './projection.js'
import { readAccountSetup } from './account-setup.js'
import { emptyAccountOverrides } from '../../shared/account-addons.js'
import { readExpiryNotice, expiryNoticeAddon } from './expiry-notice.js'

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
    revision = null,
    accountOverrides = emptyAccountOverrides(),
    individual = !account.group_id,
    expirySetupAvailable = false
  if (target === 'active' || target === 'suspended') {
    try {
      if (individual && !account.addons_initialized) throw new ManagedError('INVALID_STATE')
      const setup = await readAccountSetup(tx, account, crypto, { publishedOnly: true })
      ;({ group, personal, safeMode, revision, accountOverrides } = setup)
      expirySetupAvailable = true
    } catch (error) {
      // An unreadable setup must still allow expiry to remove access. Never
      // infer permission to keep addons from a damaged or unpublished policy.
      if (target !== 'suspended' || !['INVALID_STATE', 'DATA_UNREADABLE'].includes(error.code))
        throw error
    }
  }
  const expiryNotice = expiryNoticeAddon(
    readExpiryNotice(
      await tx.get('SELECT * FROM managed_owners WHERE owner_id = $1', [account.owner_id]),
      crypto
    )
  )
  const stamp = crypto.fingerprint(
    {
      provider,
      group,
      personal,
      safeMode,
      revision,
      groupId: account.group_id,
      accountOverrides,
      individual,
      expiryNotice,
      expirySetupAvailable,
    },
    binding('execution-policy')
  )
  return {
    provider,
    group,
    personal,
    saved,
    safeMode,
    target,
    stamp,
    accountOverrides,
    individual,
    expiryNotice,
    expirySetupAvailable,
  }
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
