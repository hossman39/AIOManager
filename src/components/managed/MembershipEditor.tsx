import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createManagedApi,
  ManagedApiError,
  type ManagedAccount,
  type MembershipChange,
} from '@/api/managed'
import { newYorkExpiryChoices, resolveNewYorkExpiry } from '../../../shared/new-york-expiry.js'
import { Button } from '@/components/ui/button'
import { useUnsavedWarning } from '@/components/common/UnsavedWorkGuard'

type Props = {
  account: ManagedAccount
  api: ReturnType<typeof createManagedApi>
  onSaved: (account: ManagedAccount) => void
  onReloaded: (account: ManagedAccount) => void
  onClose: () => void
}

/** A versioned editor: ambiguous saves retain their exact payload and retry key. */
export function MembershipEditor({ account, api, onSaved, onReloaded, onClose }: Props) {
  const [mode, setMode] = useState<'' | 'term' | 'lifetime'>(
    account.membershipType === 'unset' ? '' : account.membershipType
  )
  const [local, setLocal] = useState(account.expiry?.local ?? '')
  const [offset, setOffset] = useState<number | undefined>(account.expiry?.offset)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [stale, setStale] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const active = useRef(false)
  const abort = useRef<AbortController | null>(null)
  const pending = useRef<{ change: MembershipChange; key: string } | null>(null)
  const choices = useMemo(() => newYorkExpiryChoices(local), [local])
  const resolved = useMemo(() => resolveNewYorkExpiry(local, offset), [local, offset])
  const valid = mode === 'lifetime' || (mode === 'term' && resolved.ok)
  useUnsavedWarning(
    busy ||
      uncertain ||
      mode !== (account.membershipType === 'unset' ? '' : account.membershipType) ||
      (mode === 'term' &&
        (local !== (account.expiry?.local ?? '') || offset !== account.expiry?.offset))
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

  const save = async () => {
    if (busy || stale || (!uncertain && !valid)) return
    if (!pending.current) {
      if (mode === 'lifetime') {
        pending.current = {
          change: { mode, expectedVersion: account.version },
          key: crypto.randomUUID(),
        }
      } else if (mode === 'term' && resolved.ok) {
        pending.current = {
          change: { mode, expectedVersion: account.version, local, offset: resolved.expiry.offset },
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
      const result = await api.setMembership(
        account.id,
        request.change,
        request.key,
        controller.signal
      )
      // A replay is an acknowledgement of the original save, not necessarily
      // the latest record if a second admin tab edited it in the meantime.
      const saved = result.replayed
        ? await api.account(account.id, controller.signal)
        : result.account
      if (active.current) onSaved(saved)
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
      if (active.current) onReloaded(latest)
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
      <p className="text-sm text-muted-foreground">
        {account.state === 'staged'
          ? 'This user stays staged. Saving a membership does not activate the account or change addons.'
          : 'Changes apply through managed sync. Expiry disables addons but keeps their saved setup for renewal.'}{' '}
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
            Dated — exact New York cutoff
          </label>
          {mode === 'term' && (
            <div className="space-y-3">
              <label htmlFor="membership-cutoff" className="block text-sm font-medium">
                Expiry date and time (America/New_York)
              </label>
              <input
                id="membership-cutoff"
                type="datetime-local"
                step="60"
                min="1900-01-01T00:00"
                max="9999-12-31T23:59"
                required
                value={local}
                className="block w-full min-w-0 max-w-md rounded-md border bg-background px-3 py-2 text-sm"
                aria-describedby="membership-time-help"
                onChange={(event) => {
                  setLocal(event.target.value)
                  setOffset(undefined)
                }}
              />
              <p id="membership-time-help" className="text-sm text-muted-foreground">
                Uses New York time regardless of your device timezone, with no grace period.
              </p>
              {local && !choices.ok && (
                <p role="alert" className="text-sm text-destructive">
                  {choices.code === 'NONEXISTENT_EXPIRY'
                    ? 'That time does not exist in New York because the clocks move forward. Choose another time.'
                    : 'Enter a valid date and time.'}
                </p>
              )}
              {choices.ok && choices.choices.length > 1 && (
                <label className="block space-y-2 text-sm" htmlFor="membership-occurrence">
                  <span>This time occurs twice. Choose the intended occurrence.</span>
                  <select
                    id="membership-occurrence"
                    required
                    value={offset ?? ''}
                    className="block w-full rounded-md border bg-background px-3 py-2"
                    onChange={(event) =>
                      setOffset(event.target.value === '' ? undefined : Number(event.target.value))
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
                <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
                  This cutoff has already passed. Once managed sync is enabled, this membership
                  requires all addons to be disabled.
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
