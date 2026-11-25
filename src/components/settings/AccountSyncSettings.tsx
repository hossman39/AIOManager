import { useCallback, useEffect, useRef, useState } from 'react'
import { ManagedApiError, type createManagedApi, type ManagedStatus } from '@/api/managed'
import { Button } from '@/components/ui/button'
import { toast } from '@/hooks/use-toast'
import { useManagedApi } from '@/components/managed/useManagedApi'
import { ManagedRuntimeControls } from '@/components/managed/ManagedRuntimeControls'
import { ExpiryNoticeEditor } from '@/components/managed/ExpiryNoticeEditor'
import { useManagedSubmission, useUnsavedWarning } from '@/components/managed/useManagedSubmission'
import { MEMBERSHIP_TIMEZONE, validMembershipTimezone } from '../../../shared/membership-expiry.js'

declare const __BUILD_TIMEZONES__: string[]

const timezones = [
  ...new Set([
    MEMBERSHIP_TIMEZONE,
    'UTC',
    ...((
      Intl as typeof Intl & { supportedValuesOf?: (key: 'timeZone') => string[] }
    ).supportedValuesOf?.('timeZone') ?? __BUILD_TIMEZONES__.filter(validMembershipTimezone)),
  ]),
].sort()

function MembershipTimezoneSettings({
  api,
  status,
  onChanged,
}: {
  api: ReturnType<typeof createManagedApi>
  status: ManagedStatus
  onChanged: () => void
}) {
  const [zone, setZone] = useState(status.membershipTimezone)
  const mutation = useManagedSubmission<Parameters<typeof api.saveSettings>[0], unknown>(
    (value, key, signal) => api.saveSettings(value, key, signal),
    () => {
      toast({ title: 'Membership timezone saved' })
      onChanged()
    }
  )
  const dirty = zone !== status.membershipTimezone
  const locked = mutation.busy || mutation.stale || mutation.uncertain
  useUnsavedWarning(dirty || mutation.busy || mutation.uncertain)
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4">
      <label htmlFor="settings-membership-timezone" className="block font-medium">
        Membership timezone
      </label>
      <p id="membership-zone-help" className="text-sm text-muted-foreground">
        Memberships expire at the end of their saved date in this timezone. Changing it keeps each
        client’s paid-through date and updates when access expires.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          id="settings-membership-timezone"
          className="min-w-0 w-full max-w-xs rounded-md border bg-background px-3 py-2 text-sm"
          value={zone}
          disabled={locked}
          aria-describedby="membership-zone-help"
          onChange={(event) => setZone(event.target.value)}
        >
          {!timezones.includes(status.membershipTimezone) && (
            <option value={status.membershipTimezone}>{status.membershipTimezone}</option>
          )}
          {timezones.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={!dirty || locked}
          onClick={() =>
            void mutation.submit({
              expectedVersion: status.version,
              membershipTimezone: zone,
            })
          }
        >
          Save timezone
        </Button>
      </div>
      {mutation.message && (
        <p role="alert" className="text-sm">
          {mutation.message}
        </p>
      )}
      {mutation.uncertain && (
        <Button disabled={mutation.busy} onClick={() => void mutation.retry()}>
          Retry same save
        </Button>
      )}
      {mutation.stale && (
        <Button
          onClick={() => {
            mutation.reset()
            onChanged()
          }}
        >
          Refresh settings
        </Button>
      )}
    </section>
  )
}

export function AccountSyncSettings() {
  const { api, ownerKey } = useManagedApi()
  return <SyncSettings key={ownerKey} api={api} />
}
function SyncSettings({ api }: { api: ReturnType<typeof createManagedApi> }) {
  const [status, setStatus] = useState<ManagedStatus | null>(null)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const load = useCallback(async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    try {
      const result = await api.status(controller.signal)
      if (!controller.signal.aborted) {
        setStatus(result)
        setError('')
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof ManagedApiError
            ? failure.message
            : 'Sync settings could not be loaded.'
        )
    }
  }, [api])
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])
  return (
    <div className="max-w-3xl space-y-5">
      <h2 className="text-xl font-semibold">Account sync settings</h2>
      <p className="text-sm text-muted-foreground">
        These settings apply to all your accounts, including group members.
      </p>
      {error && <p role="alert">{error}</p>}
      {status ? (
        <>
          <MembershipTimezoneSettings
            key={status.membershipTimezone}
            api={api}
            status={status}
            onChanged={() => void load()}
          />
          <ManagedRuntimeControls api={api} status={status} onChanged={() => void load()} />
          <Button variant="outline" onClick={() => void load()}>
            Refresh sync and backup status
          </Button>
        </>
      ) : (
        <Button variant="outline" onClick={() => void load()}>
          Reload settings
        </Button>
      )}
      <ExpiryNoticeEditor api={api} onChanged={() => void load()} />
    </div>
  )
}
