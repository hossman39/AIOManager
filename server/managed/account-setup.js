import { checkedCollection } from './projection.js'
import { emptyAccountOverrides, parseAccountOverrides } from '../../shared/account-addons.js'
import { ManagedError } from './errors.js'
import { equalSecret } from './crypto.js'

/** Read the account's saved layers; a group is optional. No provider IO. */
export async function readAccountSetup(tx, account, crypto, { publishedOnly = false } = {}) {
  const binding = (purpose) => ({ owner: account.owner_id, id: account.id, purpose })
  const personal = checkedCollection(crypto.open(account.personal_enc, binding('personal-addons')))
  const saved = checkedCollection(crypto.open(account.configuration_enc, binding('configuration')))
  const parsed = parseAccountOverrides(
    account.addon_overrides_enc
      ? crypto.open(account.addon_overrides_enc, binding('account-addon-overrides'))
      : emptyAccountOverrides()
  )
  if (!parsed.ok) throw new ManagedError('DATA_UNREADABLE')
  let group = [],
    groupRow = null,
    revision = null
  if (account.group_id) {
    groupRow = await tx.get('SELECT * FROM managed_groups WHERE owner_id = $1 AND id = $2', [
      account.owner_id,
      account.group_id,
    ])
    if (!groupRow || groupRow.archived) throw new ManagedError('INVALID_STATE')
    revision = groupRow.published_revision
    if (revision === null) {
      if (publishedOnly || account.state !== 'staged') throw new ManagedError('INVALID_STATE')
      group = checkedCollection(
        crypto.open(groupRow.draft_enc, {
          owner: account.owner_id,
          id: groupRow.id,
          purpose: 'group-draft',
        })
      )
    } else {
      const published = await tx.get(
        'SELECT * FROM managed_group_revisions WHERE owner_id = $1 AND group_id = $2 AND revision = $3',
        [account.owner_id, groupRow.id, revision]
      )
      if (!published) throw new ManagedError('DATA_UNREADABLE')
      group = checkedCollection(
        crypto.open(published.config_enc, {
          owner: account.owner_id,
          id: groupRow.id,
          purpose: 'group-revision:' + revision,
        })
      )
      if (
        !equalSecret(
          published.payload_digest,
          crypto.fingerprint(group, {
            owner: account.owner_id,
            id: groupRow.id,
            purpose: 'group-payload',
          })
        ) ||
        (!group.some((addon) => addon.flags?.enabled !== false) && published.explicit_empty !== 1)
      )
        throw new ManagedError('DATA_UNREADABLE')
    }
  }
  const owner = await tx.get('SELECT safe_mode FROM managed_owners WHERE owner_id = $1', [
    account.owner_id,
  ])
  if (!owner) throw new ManagedError('DATA_UNREADABLE')
  return {
    group,
    personal,
    saved,
    accountOverrides: parsed.overrides,
    individual: !groupRow,
    safeMode: (account.safe_mode ?? groupRow?.safe_mode ?? owner.safe_mode) === 1,
    revision,
    groupVersion: groupRow?.version ?? null,
    groupName: groupRow
      ? crypto.open(groupRow.name_enc, {
          owner: account.owner_id,
          id: groupRow.id,
          purpose: 'group-name',
        })
      : null,
  }
}
