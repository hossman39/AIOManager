import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type ManagedGroup,
  type ManagedGroupSummary,
  type BulkMembership,
  type GroupMemberSelection,
} from '@/api/managed'
import { resolveExpiryDate, MEMBERSHIP_TIMEZONE } from '../../../shared/membership-expiry.js'
import { GroupMemberDialog } from './GroupMemberDialog'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

type Api = ReturnType<typeof createManagedApi>
type Action =
  | { kind: 'membership'; accounts: GroupMemberSelection; membership: BulkMembership }
  | { kind: 'move'; accounts: GroupMemberSelection; groupId: string }
  | { kind: 'remove' | 'sync'; accounts: GroupMemberSelection }
type Result = Awaited<ReturnType<Api['assignGroup']>> & { kind: Action['kind']; skipped: number }
const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm'
const countLabel = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

export function ManagedBulkUpdate({
  api,
  group,
  accounts,
  onClose,
  onSaved,
  onReload,
  edit,
}: {
  api: Api
  group?: ManagedGroup
  accounts: ManagedAccount[]
  onClose: () => void
  onSaved: (notice: string) => void
  onReload: () => void
  edit?: 'membership' | 'move'
}) {
  const original = edit ? accounts[0] : undefined
  const [kind, setKind] = useState<Action['kind']>(edit ?? 'membership')
  const [mode, setMode] = useState<'term' | 'lifetime'>(
    original?.membershipType === 'lifetime' ? 'lifetime' : 'term'
  )
  const [local, setLocal] = useState(original?.expiry?.local.slice(0, 10) ?? '')
  const [timezone, setTimezone] = useState<string>(
    original?.expiry?.timezone ?? MEMBERSHIP_TIMEZONE
  )
  const [destination, setDestination] = useState(
    edit === 'move' ? (original?.groupId ?? 'individual') : ''
  )
  const [groups, setGroups] = useState<ManagedGroupSummary[]>([])
  const [loadingGroups, setLoadingGroups] = useState(false)
  const [groupError, setGroupError] = useState('')
  const [groupRead, setGroupRead] = useState(0)
  const zones = useMemo(() => {
    const supported =
      (
        Intl as typeof Intl & { supportedValuesOf?: (kind: 'timeZone') => string[] }
      ).supportedValuesOf?.('timeZone') ?? []
    return [...new Set([MEMBERSHIP_TIMEZONE, 'UTC', timezone, ...supported])].sort()
  }, [timezone])
  const resolved = useMemo(() => resolveExpiryDate(local, timezone), [local, timezone])
  const active = accounts.filter((account) => account.state === 'active')
  useEffect(() => {
    if (kind !== 'move') return
    const controller = new AbortController()
    setLoadingGroups(true)
    setGroupError('')
    void (async () => {
      try {
        const available: ManagedGroupSummary[] = []
        let after = ''
        do {
          const page = await api.groups(after, controller.signal)
          available.push(...page.groups)
          after = page.nextCursor ?? ''
        } while (after && !controller.signal.aborted)
        if (!controller.signal.aborted)
          setGroups(available.filter((item) => item.id !== group?.id && !item.archived))
      } catch (error) {
        if (!controller.signal.aborted)
          setGroupError(error instanceof ManagedApiError ? error.message : 'Could not load groups.')
      } finally {
        if (!controller.signal.aborted) setLoadingGroups(false)
      }
    })()
    return () => controller.abort()
  }, [api, group?.id, kind, groupRead])
  const mutation = useManagedSubmission<Action, Result>(
    async (value, key, signal) => {
      const result =
        value.kind === 'membership'
          ? group
            ? await api.setGroupMembership(
                group.id,
                { accounts: value.accounts, membership: value.membership },
                key,
                signal
              )
            : await api.setAccountsMembership(
                { accounts: value.accounts, membership: value.membership },
                key,
                signal
              )
          : value.kind === 'sync'
            ? group
              ? await api.requestGroupSync(group.id, { accounts: value.accounts }, key, signal)
              : await api.requestAccountsSync({ accounts: value.accounts }, key, signal)
            : await api.assignGroup(
                {
                  ...(group ? { sourceGroupId: group.id } : {}),
                  groupId: value.kind === 'move' ? value.groupId : null,
                  useGroupAddons: true,
                  startSync: value.kind === 'move',
                  accounts: value.accounts,
                },
                key,
                signal
              )
      return { ...result, kind: value.kind, skipped: accounts.length - value.accounts.length }
    },
    (result) => {
      const count = result.accounts.length
      const target = countLabel(count, group ? 'member' : 'account')
      onSaved(
        result.kind === 'membership'
          ? `Membership updated for ${target}.`
          : result.kind === 'move'
            ? `Group saved for ${target}. ${countLabel(result.accounts.filter((item) => item.jobId).length, 'account')} queued for sync.`
            : result.kind === 'remove'
              ? `${target} removed from the group and kept as individual accounts.`
              : `Sync queued for ${target}.${result.skipped ? ` ${countLabel(result.skipped, 'account')} whose sync has not started ${result.skipped === 1 ? 'was' : 'were'} skipped.` : ''}`
      )
    }
  )
  const blocked = mutation.busy || mutation.uncertain
  const locked = blocked || mutation.stale
  useUnsavedWarning(true)
  const eligibleDestination = groups.find(
    (item) => item.id === destination && (item.publishedRevision !== null || !active.length)
  )
  const valid =
    kind === 'membership'
      ? mode === 'lifetime' || resolved.ok
      : kind === 'move'
        ? (Boolean(eligibleDestination) || (Boolean(edit) && destination === 'individual')) &&
          !loadingGroups &&
          !groupError
        : kind === 'sync'
          ? active.length > 0
          : true
  const submit = () => {
    if (locked || !valid) return
    const selection = (kind === 'sync' ? active : accounts).map((account) => ({
      id: account.id,
      expectedVersion: account.version,
    }))
    if (kind === 'membership') {
      if (mode === 'term' && !resolved.ok) return
      void mutation.submit({
        kind,
        accounts: selection,
        membership: mode === 'lifetime' ? { mode } : { mode, local, timezone },
      })
    } else if (kind === 'move')
      if (edit && destination === 'individual')
        void mutation.submit({ kind: 'remove', accounts: selection })
      else void mutation.submit({ kind, accounts: selection, groupId: destination })
    else void mutation.submit({ kind, accounts: selection })
  }
  return (
    <GroupMemberDialog
      title={
        edit
          ? edit === 'membership'
            ? 'Edit membership'
            : 'Edit group'
          : group
            ? 'Bulk update members'
            : 'Bulk update accounts'
      }
      description={
        edit
          ? original!.name || original!.email
          : `${accounts.length} selected${group ? ` in ${group.name}` : ''}. Choose the change to apply to this selection.`
      }
      blocked={blocked}
      onClose={onClose}
    >
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <fieldset disabled={locked} className="space-y-4">
          {!edit && (
            <label className="block space-y-1 text-sm" htmlFor="member-bulk-action">
              <span>Update</span>
              <select
                id="member-bulk-action"
                className={field}
                value={kind}
                onChange={(event) => setKind(event.target.value as Action['kind'])}
              >
                <option value="membership">Membership / expiry</option>
                <option value="move">{group ? 'Move to another group' : 'Assign group'}</option>
                <option value="remove">
                  {group ? 'Remove from this group' : 'Remove from groups'}
                </option>
                <option value="sync">Sync addons now</option>
              </select>
            </label>
          )}
          {kind === 'membership' && (
            <>
              <label className="block space-y-1 text-sm" htmlFor="member-bulk-mode">
                <span>Membership type</span>
                <select
                  id="member-bulk-mode"
                  className={field}
                  value={mode}
                  onChange={(event) => setMode(event.target.value as typeof mode)}
                >
                  <option value="term">Expiry date</option>
                  <option value="lifetime">Lifetime</option>
                </select>
              </label>
              {mode === 'term' && (
                <>
                  <label className="block space-y-1 text-sm" htmlFor="member-bulk-timezone">
                    <span>Timezone</span>
                    <input
                      id="member-bulk-timezone"
                      className={field}
                      list="member-bulk-timezones"
                      value={timezone}
                      required
                      onChange={(event) => setTimezone(event.target.value)}
                    />
                    <datalist id="member-bulk-timezones">
                      {zones.map((zone) => (
                        <option key={zone} value={zone} />
                      ))}
                    </datalist>
                  </label>
                  <label className="block space-y-1 text-sm" htmlFor="member-bulk-cutoff">
                    <span>Expiry date</span>
                    <input
                      id="member-bulk-cutoff"
                      className={field}
                      type="date"
                      min="1900-01-01"
                      max="9999-12-31"
                      value={local}
                      required
                      onChange={(event) => setLocal(event.target.value)}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    Membership stays active through the end of this date in the selected timezone.
                  </p>
                  {local && !resolved.ok && (
                    <p role="alert" className="text-sm text-destructive">
                      {resolved.code === 'NONEXISTENT_EXPIRY'
                        ? 'This date does not exist in the selected timezone.'
                        : resolved.code === 'INVALID_TIMEZONE'
                          ? 'Enter a valid named timezone.'
                          : 'Enter a valid date.'}
                    </p>
                  )}
                  {resolved.ok && resolved.expiry.at <= Date.now() && (
                    <p role="status" className="text-sm text-amber-500">
                      This date has passed. These accounts will use their expiry setup when sync
                      runs.
                    </p>
                  )}
                </>
              )}
              <p className="text-sm text-muted-foreground">
                Saving membership starts sync for accounts assigned to a published group through
                Save group. Accounts already syncing apply the updated membership automatically.
              </p>
            </>
          )}
          {kind === 'move' && (
            <>
              <label className="block space-y-1 text-sm" htmlFor="member-bulk-destination">
                <span>Destination group</span>
                <select
                  id="member-bulk-destination"
                  className={field}
                  value={destination}
                  required
                  disabled={loadingGroups}
                  onChange={(event) => setDestination(event.target.value)}
                >
                  <option value="">{loadingGroups ? 'Loading groups…' : 'Choose a group'}</option>
                  {edit && <option value="individual">No group — individual setup</option>}
                  {groups.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={active.length > 0 && item.publishedRevision === null}
                    >
                      {item.name}
                      {item.publishedRevision === null ? ' (not published)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-sm text-muted-foreground">
                {destination === 'individual'
                  ? 'The complete addon setup and customizations stay with this account.'
                  : 'Saving syncs the published group addons automatically once a membership is set. Account-only addons stay.'}
              </p>
              {groupError && (
                <>
                  <p role="alert" className="text-sm text-destructive">
                    {groupError}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setGroupRead((value) => value + 1)}
                  >
                    Reload groups
                  </Button>
                </>
              )}
            </>
          )}
          {kind === 'remove' && (
            <p className="text-sm">
              These accounts become individually managed. Their addon setups, customizations and
              memberships are kept.
            </p>
          )}
          {kind === 'sync' && (
            <p className="text-sm">
              {countLabel(active.length, 'account')} will sync their current setup. Expired accounts
              keep the expiry rules.
              {accounts.length > active.length
                ? ` ${countLabel(accounts.length - active.length, 'account')} whose sync has not started will be skipped.`
                : ''}{' '}
              Paused sync waits until resumed.
            </p>
          )}
        </fieldset>
        {mutation.message && (
          <p role="alert" className="text-sm text-destructive">
            {mutation.message}
          </p>
        )}
        {mutation.uncertain && (
          <p className="text-sm">
            This update may already be saved. Retry the same selection to confirm it without
            repeating changes.
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" disabled={blocked} onClick={onClose}>
            Cancel
          </Button>
          {mutation.stale && (
            <Button type="button" variant="outline" onClick={onReload}>
              Reload accounts
            </Button>
          )}
          {mutation.uncertain ? (
            <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
              Retry bulk update
            </Button>
          ) : (
            <Button type="submit" disabled={locked || !valid}>
              {mutation.busy
                ? 'Applying…'
                : edit
                  ? edit === 'membership'
                    ? 'Save membership'
                    : 'Save group'
                  : kind === 'sync'
                    ? `Sync ${countLabel(active.length, 'account')}`
                    : kind === 'remove'
                      ? `Remove ${accounts.length} from group`
                      : kind === 'move'
                        ? `Move ${countLabel(accounts.length, group ? 'member' : 'account')}`
                        : `Update ${countLabel(accounts.length, group ? 'member' : 'account')}`}
            </Button>
          )}
        </div>
      </form>
    </GroupMemberDialog>
  )
}
