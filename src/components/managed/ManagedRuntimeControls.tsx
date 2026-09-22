import { Button } from '@/components/ui/button'
import type { createManagedApi, ManagedSettings, ManagedStatus } from '@/api/managed'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'
import { backupAttention } from '@/lib/managed/account-health'

export function ManagedRuntimeControls({
  api,
  status,
  onChanged,
}: {
  api: ReturnType<typeof createManagedApi>
  status: ManagedStatus
  onChanged: () => void
}) {
  const mutation = useManagedSubmission<ManagedSettings, unknown>(
    (body, key, signal) => api.saveSettings(body, key, signal),
    onChanged
  )
  useUnsavedWarning(mutation.busy || mutation.uncertain)
  const locked = mutation.busy || mutation.uncertain || mutation.stale
  const save = (writePaused: boolean, safeMode: boolean) =>
    void mutation.submit({
      expectedVersion: status.version,
      writePaused,
      safeMode,
    })
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4" aria-label="Managed sync controls">
      <p className="font-medium">
        {!status.capabilities.providerWrites
          ? 'Managed sync disabled on this server'
          : !status.writerReady
            ? 'Sync writer starting or recovering'
            : status.ownerWritePaused
              ? 'Managed sync paused'
              : 'Managed sync running'}
      </p>
      <p className="text-sm text-muted-foreground">
        {status.capabilities.providerWrites
          ? 'Pause stops new writes, including expiry and removal. Pending work resumes when you resume sync.'
          : 'This server supports staging and group preparation. Enable managed sync in the test server configuration to activate users.'}
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Button
          variant="outline"
          disabled={locked || !status.capabilities.providerWrites || !status.writerReady}
          onClick={() => save(!status.ownerWritePaused, status.safeMode)}
        >
          {status.ownerWritePaused ? 'Resume managed sync' : 'Pause managed sync'}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={status.safeMode}
            disabled={locked}
            onChange={(event) => save(status.ownerWritePaused, event.target.checked)}
          />
          Safe mode by default
        </label>
      </div>
      <p className="text-xs text-muted-foreground">
        Safe mode protects default and protected addons. Group and account overrides apply; changes
        take effect on the next sync.
      </p>
      <p className="text-xs text-muted-foreground">
        Last expiry scan:{' '}
        {status.lastScanAt ? new Date(status.lastScanAt).toLocaleString() : 'Not yet recorded'}.{' '}
        Last encrypted backup:{' '}
        {status.lastBackupAt ? new Date(status.lastBackupAt).toLocaleString() : 'Not yet recorded'}.
      </p>
      {backupAttention(status) && (
        <p role="alert" className="text-sm text-amber-600 dark:text-amber-400">
          {backupAttention(status)}
        </p>
      )}
      {mutation.message && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.message}
        </p>
      )}
      {mutation.uncertain && (
        <Button disabled={mutation.busy} onClick={() => void mutation.retry()}>
          Retry same request
        </Button>
      )}
      {mutation.stale && (
        <Button
          variant="outline"
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
