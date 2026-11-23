import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createManagedApi,
  ManagedApiError,
  type ManagedAccount,
  type MembershipChange,
  type AccessOverride,
} from '@/api/managed'
import { resolveExpiryDate, MEMBERSHIP_TIMEZONE } from '../../../shared/membership-expiry.js'
import { Button } from '@/components/ui/button'
import { useUnsavedWarning } from '@/components/common/UnsavedWorkGuard'

type Props = {
  account: ManagedAccount
  api: ReturnType<typeof createManagedApi>
  onSaved: (account: ManagedAccount) => void
  onReloaded: (account: ManagedAccount) => void
  onClose: () => void
}

const accessChoices = [
  ['automatic', 'Follow membership'],
  ['active', 'Keep active'],
  ['suspended', 'Expire now'],
] as const
type OverrideChange = { override: AccessOverride; expectedVersion: number }

/** A versioned editor: ambiguous saves retain their exact payload and retry key. */
export function MembershipEditor({ account, api, onSaved, onReloaded, onClose }: Props) {
  const [mode, setMode] = useState<'' | 'term' | 'lifetime'>(
    account.membershipType === 'unset' ? '' : account.membershipType
  )
  const [local, setLocal] = useState(account.expiry?.local.slice(0, 10) ?? '')
  const [timezone, setTimezone] = useState(account.expiry?.timezone ?? MEMBERSHIP_TIMEZONE)
  const timezones = useMemo(() => {
    const supported =
      (
        Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
      ).supportedValuesOf?.('timeZone') ?? []
    return [...new Set([MEMBERSHIP_TIMEZONE, 'UTC', timezone, ...supported])].sort()
  }, [timezone])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [stale, setStale] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const active = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const pending = useRef<{ change: MembershipChange | OverrideChange; key: string } | null>(null)
  const selectedOverride = account.accessOverride ?? 'automatic'
  const resolved = useMemo(() => resolveExpiryDate(local, timezone), [local, timezone])
  const valid = mode === 'lifetime' || (mode === 'term' && resolved.ok)
  useUnsavedWarning(
    busy ||
      uncertain ||
      mode !== (account.membershipType === 'unset' ? '' : account.membershipType) ||
      (mode === 'term' &&
        (local !== (account.expiry?.local.slice(0, 10) ?? '') ||
          timezone !== (account.expiry?.timezone ?? MEMBERSHIP_TIMEZONE)))
  )

  useEffect(() => {
    active.current = true
    heading.current?.focus()
    return () => {
      active.current = false
      abort.current?.abort()
      pending.current = null
    }
  }, [])

  const save = async (override?: AccessOverride) => {
    if (busy || stale || account.state === 'offboarding' || (!uncertain && !override && !valid))
      return
    if (!pending.current) {
      if (override) {
        pending.current = {
          change: { override, expectedVersion: account.version },
          key: crypto.randomUUID(),
        }
      } else if (mode === 'lifetime') {
        pending.current = {
          change: { mode, expectedVersion: account.version },
          key: crypto.randomUUID(),
        }
      } else if (mode === 'term' && resolved.ok) {
        pending.current = {
          change: {
            mode,
            expectedVersion: account.version,
            local,
            timezone,
          },
          key: crypto.randomUUID(),
        }
      } else return
    }
    const request = pending.current
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setError('')
    try {
      const result =
        'override' in request.change
          ? await api.setAccessOverride(account.id, request.change, request.key, controller.signal)
          : await api.setMembership(account.id, request.change, request.key, controller.signal)
      // A replay is an acknowledgement of the original save, not necessarily
      // the latest record if a second admin tab edited it in the meantime.
      const saved = result.replayed
        ? await api.account(account.id, controller.signal)
        : result.account
      if (active.current) {
        pending.current = null
        setUncertain(false)
        if ('override' in request.change) onReloaded(saved)
        else onSaved(saved)
      }
    } catch (failure) {
      if (!active.current) return
      const code = failure instanceof ManagedApiError ? failure.code : 'NETWORK_ERROR'
      setError(
        failure instanceof ManagedApiError
          ? failure.message
          : 'No save has been confirmed. Retry the same request.'
      )
      const ambiguous = [
        'NETWORK_ERROR',
        'INVALID_RESPONSE',
        'REQUEST_FAILED',
        'CANCELLED',
      ].includes(code)
      setUncertain(ambiguous)
      setStale(['VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_STATE'].includes(code))
      if (!ambiguous) pending.current = null
    } finally {
      if (active.current) setBusy(false)
    }
  }

  const reload = async () => {
    if (busy) return
    const controller = new AbortController()
    abort.current = controller
    setBusy(true)
    setError('')
    try {
      const latest = await api.account(account.id, controller.signal)
      if (active.current) {
        pending.current = null
        setUncertain(false)
        setStale(false)
        setMode(latest.membershipType === 'unset' ? '' : latest.membershipType)
        setLocal(latest.expiry?.local.slice(0, 10) ?? '')
        setTimezone(latest.expiry?.timezone ?? MEMBERSHIP_TIMEZONE)
        onReloaded(latest)
      }
    } catch (failure) {
      if (active.current)
        setError(
          failure instanceof ManagedApiError
            ? failure.message
            : 'The saved membership could not be loaded.'
        )
    } finally {
      if (active.current) setBusy(false)
    }
  }

  return (
    <section
      id="managed-membership-editor"
      className="space-y-4 rounded-lg border bg-muted/20 p-4"
      aria-labelledby="membership-heading"
    >
      <h4
        id="membership-heading"
        ref={heading}
        tabIndex={-1}
        className="break-all font-semibold focus-visible:outline focus-visible:outline-2"
      >
        Membership for {account.email}
      </h4>
      <fieldset
        className="space-y-2"
        disabled={busy || uncertain || stale || account.state === 'offboarding'}
      >
        <legend className="mb-1 text-sm font-semibold">Account access</legend>
        <div className="flex flex-wrap gap-2">
          {accessChoices.map(([value, label]) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={selectedOverride === value ? 'default' : 'outline'}
              aria-pressed={selectedOverride === value}
              onClick={() => {
                if (value !== selectedOverride) void save(value)
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <p role="status" className="text-sm text-muted-foreground">
          {selectedOverride === 'automatic'
            ? 'Access follows the saved membership. Choose an override to apply it in one click.'
            : selectedOverride === 'active'
              ? 'The saved addons stay active past expiry. Choose Follow membership to use the saved date again.'
              : 'The expiry addon setup applies until you choose Follow membership or Keep active.'}
        </p>
      </fieldset>
      <p className="text-sm text-muted-foreground">
        {account.groupSyncRequested
          ? 'Saving a membership starts sync with the published group addons.'
          : account.state === 'staged'
            ? 'Start sync to apply membership changes to the installed addons.'
            : 'Changes apply through managed sync. Expiry disables the selected addons and keeps their saved setup for renewal.'}{' '}
        Lifetime has no automatic cutoff. An unset expiry is not a lifetime membership.
      </p>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <fieldset
          disabled={busy || uncertain || stale || account.state === 'offboarding'}
          className="space-y-3"
        >
          <legend className="mb-2 text-sm font-medium">Membership type</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="membership-mode"
              value="lifetime"
              checked={mode === 'lifetime'}
              onChange={() => setMode('lifetime')}
            />
            Lifetime — no automatic expiry
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="membership-mode"
              value="term"
              checked={mode === 'term'}
              onChange={() => setMode('term')}
            />
            Dated membership
          </label>
          {mode === 'term' && (
            <div className="space-y-3">
              <label htmlFor="membership-timezone" className="block text-sm font-medium">
                Timezone
              </label>
              <input
                id="membership-timezone"
                list="membership-timezones"
                required
                value={timezone}
                className="block w-full min-w-0 max-w-md rounded-md border bg-background px-3 py-2 text-sm"
                onChange={(event) => setTimezone(event.target.value)}
              />
              <datalist id="membership-timezones">
                {timezones.map((zone) => (
                  <option key={zone} value={zone} />
                ))}
              </datalist>
              <label htmlFor="membership-cutoff" className="block text-sm font-medium">
                Expiry date
              </label>
              <input
                id="membership-cutoff"
                type="date"
                min="1900-01-01"
                max="9999-12-31"
                required
                value={local}
                className="block w-full min-w-0 max-w-md rounded-md border bg-background px-3 py-2 text-sm"
                aria-describedby="membership-time-help"
                onChange={(event) => setLocal(event.target.value)}
              />
              <p id="membership-time-help" className="text-sm text-muted-foreground">
                Membership stays active through the end of this date in the selected timezone.
              </p>
              {local && !resolved.ok && (
                <p role="alert" className="text-sm text-destructive">
                  {resolved.code === 'NONEXISTENT_EXPIRY'
                    ? 'This date does not exist in the selected timezone.'
                    : resolved.code === 'INVALID_TIMEZONE'
                      ? 'Select a valid timezone from the list or enter a named timezone.'
                      : 'Enter a valid date.'}
                </p>
              )}
              {selectedOverride === 'automatic' &&
                resolved.ok &&
                resolved.expiry.at <= Date.now() && (
                  <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
                    This cutoff has already passed. Once managed sync is enabled, this membership
                    uses the selected expiry setup. Unchecked addons and the enabled expiry notice
                    remain available.
                  </p>
                )}
            </div>
          )}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {uncertain && (
          <p className="text-sm">
            The request may already be saved. Retry confirms the same change without submitting a
            second one. Closing this editor does not undo a submitted change.
          </p>
        )}
        {account.state === 'offboarding' && (
          <p role="alert" className="text-sm">
            Offboarding is in progress. A membership change cannot cancel account removal.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={busy || stale || account.state === 'offboarding' || (!uncertain && !valid)}
          >
            {busy ? 'Working…' : uncertain ? 'Retry same save' : 'Save membership'}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Close editor
          </Button>
          {(error || stale || uncertain) && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void reload()
              }}
            >
              Reload saved values (discards edits)
            </Button>
          )}
        </div>
      </form>
    </section>
  )
}
