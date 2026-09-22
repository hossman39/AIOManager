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
import {
  expiryChoices,
  resolveExpiry,
  MEMBERSHIP_TIMEZONE,
} from '../../../shared/membership-expiry.js'
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

export function GroupBulkUpdate({
  api,
  group,
  accounts,
  onClose,
  onSaved,
  onReload,
}: {
  api: Api
  group: ManagedGroup
  accounts: ManagedAccount[]
  onClose: () => void
  onSaved: (notice: string) => void
  onReload: () => void
}) {
  const [kind, setKind] = useState<Action['kind']>('membership')
  const [mode, setMode] = useState<'term' | 'lifetime'>('term')
  const [local, setLocal] = useState('')
  const [timezone, setTimezone] = useState<string>(MEMBERSHIP_TIMEZONE)
  const [offset, setOffset] = useState<number | undefined>()
  const [destination, setDestination] = useState('')
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
  const choices = useMemo(() => expiryChoices(local, timezone), [local, timezone])
  const resolved = useMemo(() => resolveExpiry(local, offset, timezone), [local, offset, timezone])
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
          setGroups(available.filter((item) => item.id !== group.id && !item.archived))
      } catch (error) {
        if (!controller.signal.aborted)
          setGroupError(error instanceof ManagedApiError ? error.message : 'Could not load groups.')
      } finally {
        if (!controller.signal.aborted) setLoadingGroups(false)
      }
    })()
    return () => controller.abort()
  }, [api, group.id, kind, groupRead])
  const mutation = useManagedSubmission<Action, Result>(
    async (value, key, signal) => {
      const result =
        value.kind === 'membership'
          ? await api.setGroupMembership(
              group.id,
              { accounts: value.accounts, membership: value.membership },
              key,
              signal
            )
          : value.kind === 'sync'
            ? await api.requestGroupSync(group.id, { accounts: value.accounts }, key, signal)
            : await api.assignGroup(
                {
                  sourceGroupId: group.id,
                  groupId: value.kind === 'move' ? value.groupId : null,
                  useGroupAddons: true,
                  accounts: value.accounts,
                },
                key,
                signal
              )
      return { ...result, kind: value.kind, skipped: accounts.length - value.accounts.length }
    },
    (result) => {
      const count = result.accounts.length
      const target = countLabel(count, 'member')
      onSaved(
        result.kind === 'membership'
          ? `Membership updated for ${target}.`
          : result.kind === 'move'
            ? `${target} moved to the selected group.`
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
        ? Boolean(eligibleDestination) && !loadingGroups && !groupError
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
        membership:
          mode === 'lifetime'
            ? { mode }
            : { mode, local, timezone, offset: resolved.ok ? resolved.expiry.offset : undefined },
      })
    } else if (kind === 'move')
      void mutation.submit({ kind, accounts: selection, groupId: destination })
    else void mutation.submit({ kind, accounts: selection })
  }
  return (
    <GroupMemberDialog
      title="Bulk update members"
      description={`${accounts.length} selected in ${group.name}. Choose the change to apply to this selection.`}
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
          <label className="block space-y-1 text-sm" htmlFor="member-bulk-action">
            <span>Update</span>
            <select
              id="member-bulk-action"
              className={field}
              value={kind}
              onChange={(event) => setKind(event.target.value as Action['kind'])}
            >
              <option value="membership">Membership / expiry</option>
              <option value="move">Move to another group</option>
              <option value="remove">Remove from this group</option>
              <option value="sync">Sync addons now</option>
            </select>
          </label>
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
                  <option value="term">Expiry date and time</option>
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
                      onChange={(event) => {
                        setTimezone(event.target.value)
                        setOffset(undefined)
                      }}
                    />
                    <datalist id="member-bulk-timezones">
                      {zones.map((zone) => (
                        <option key={zone} value={zone} />
                      ))}
                    </datalist>
                  </label>
                  <label className="block space-y-1 text-sm" htmlFor="member-bulk-cutoff">
                    <span>Expiry date and time</span>
                    <input
                      id="member-bulk-cutoff"
                      className={field}
                      type="datetime-local"
                      step="60"
                      min="1900-01-01T00:00"
                      max="9999-12-31T23:59"
                      value={local}
                      required
                      onChange={(event) => {
                        setLocal(event.target.value)
                        setOffset(undefined)
                      }}
                    />
                  </label>
                  <p className="text-xs text-muted-foreground">
                    All selected members get this cutoff in the chosen timezone.
                  </p>
                  {local && !choices.ok && (
                    <p role="alert" className="text-sm text-destructive">
                      {choices.code === 'NONEXISTENT_EXPIRY'
                        ? 'This time does not exist because the clocks move forward. Choose another time.'
                        : choices.code === 'INVALID_TIMEZONE'
                          ? 'Enter a valid named timezone.'
                          : 'Enter a valid date and time.'}
                    </p>
                  )}
                  {choices.ok && choices.choices.length > 1 && (
                    <label className="block space-y-1 text-sm" htmlFor="member-bulk-occurrence">
                      <span>This time occurs twice. Choose an occurrence.</span>
                      <select
                        id="member-bulk-occurrence"
                        className={field}
                        required
                        value={offset ?? ''}
                        onChange={(event) =>
                          setOffset(
                            event.target.value === '' ? undefined : Number(event.target.value)
                          )
                        }
                      >
                        <option value="">Choose an occurrence</option>
                        {choices.choices.map((choice) => (
                          <option key={choice.offset} value={choice.offset}>
                            {choice.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {resolved.ok && resolved.expiry.at <= Date.now() && (
                    <p role="status" className="text-sm text-amber-500">
                      This date has passed. These members will use the group's expiry setup when
                      sync runs.
                    </p>
                  )}
                </>
              )}
              <p className="text-sm text-muted-foreground">
                Accounts whose sync has not started stay inactive. Other accounts sync the updated
                membership automatically.
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
                The new group supplies shared addon settings. Account-only addons stay.
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
              These members become individual accounts. Their addon setups, customizations and
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
              Reload members
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
                : kind === 'sync'
                  ? `Sync ${countLabel(active.length, 'account')}`
                  : kind === 'remove'
                    ? `Remove ${accounts.length} from group`
                    : kind === 'move'
                      ? `Move ${countLabel(accounts.length, 'member')}`
                      : `Update ${countLabel(accounts.length, 'member')}`}
            </Button>
          )}
        </div>
      </form>
    </GroupMemberDialog>
  )
}
