import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type ManagedActivation,
  type ManagedActivationPreview,
  type ManagedExecution,
} from '@/api/managed'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

type Action =
  | { kind: 'activate'; body: ManagedActivation }
  | { kind: 'sync' | 'offboard'; body: { expectedVersion: number } }
  | { kind: 'reconnect'; body: { expectedVersion: number; password: string } }
const failureText: Record<string, string> = {
  INVALID_CREDENTIALS: 'Stremio rejected the saved login. Update the saved password to reconnect.',
  IDENTITY_MISMATCH: 'The login belongs to a different Stremio account. Sync is stopped.',
  DATA_UNREADABLE: 'The saved setup could not be read. Check the server data and encryption key.',
  MANIFEST_UNAVAILABLE:
    'An addon manifest could not be validated. Check the configured URL, then retry.',
  VERIFICATION_MISMATCH:
    'Stremio did not return the expected addon setup. No success has been recorded.',
  WRITE_PAUSED: 'Writes are paused. Resume managed sync when ready.',
}
export function ManagedAccountOperations({
  api,
  account,
  enabled,
  paused,
  onUpdated,
  onRemoved,
  onClose,
}: {
  api: ReturnType<typeof createManagedApi>
  account: ManagedAccount
  enabled: boolean
  paused: boolean
  onUpdated: (value: ManagedAccount) => void
  onRemoved: () => void
  onClose: () => void
}) {
  const [execution, setExecution] = useState<ManagedExecution | null>(null)
  const [preview, setPreview] = useState<ManagedActivationPreview | null>(null)
  const [safeMode, setSafeMode] = useState('inherit')
  const [consent, setConsent] = useState(false)
  const [removeConsent, setRemoveConsent] = useState(false)
  const [reading, setReading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(false),
    readAbort = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const passwordInput = useRef<HTMLInputElement>(null)
  const updated = useRef(onUpdated),
    removed = useRef(onRemoved)
  updated.current = onUpdated
  removed.current = onRemoved
  const current = execution?.account ?? account
  const mutation = useManagedSubmission<Action, ManagedExecution>(
    async (action, key, signal) => {
      if (action.kind === 'activate') await api.activate(account.id, action.body, key, signal)
      else if (action.kind === 'reconnect')
        await api.reconnect(account.id, action.body, key, signal)
      else if (action.kind === 'offboard') await api.offboard(account.id, action.body, key, signal)
      else await api.requestSync(account.id, action.body, key, signal)
      return api.execution(account.id, signal)
    },
    (result) => {
      setExecution(result)
      setPreview(null)
      setConsent(false)
      setRemoveConsent(false)
      if (passwordInput.current) passwordInput.current.value = ''
      setNotice(
        result.removedAt
          ? 'Stremio cleanup verified. Local account removed.'
          : result.account?.state === 'staged'
            ? 'Login verified. This user remains staged.'
            : 'Request saved. Waiting for verified sync.'
      )
      if (result.account) updated.current(result.account)
      else removed.current()
    }
  )
  const locked = reading || mutation.busy || mutation.uncertain
  useUnsavedWarning(mutation.busy || mutation.uncertain)
  useEffect(() => {
    alive.current = true
    heading.current?.focus()
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const poll = async () => {
      try {
        const result = await api.execution(account.id, controller.signal)
        if (!alive.current) return
        setExecution(result)
        if (result.account) updated.current(result.account)
        else {
          removed.current()
          return
        }
      } catch (error) {
        if (alive.current)
          setError(
            error instanceof ManagedApiError ? error.message : 'Sync status could not be read.'
          )
      }
      if (alive.current) timer = setTimeout(poll, 5000)
    }
    void poll()
    return () => {
      alive.current = false
      clearTimeout(timer)
      controller.abort()
      readAbort.current?.abort()
    }
  }, [account.id, api])
  const prepare = async () => {
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    setReading(true)
    setError('')
    setPreview(null)
    setConsent(false)
    mutation.reset()
    try {
      const value = await api.activationPreview(
        account.id,
        {
          expectedVersion: current.version,
          safeMode: safeMode === 'inherit' ? null : safeMode === 'on',
        },
        controller.signal
      )
      if (alive.current) setPreview(value)
    } catch (error) {
      if (alive.current)
        setError(
          error instanceof ManagedApiError
            ? error.message
            : 'The activation preview could not be prepared.'
        )
    } finally {
      if (alive.current) setReading(false)
    }
  }
  const job = execution?.job
  return (
    <section
      className="space-y-4 rounded-lg border bg-muted/20 p-4"
      aria-labelledby="managed-operations-heading"
    >
      <h4
        id="managed-operations-heading"
        ref={heading}
        tabIndex={-1}
        className="break-all font-semibold"
      >
        Manage {account.email}
      </h4>
      {paused && (
        <p className="text-sm">
          Managed sync is paused. Saved requests will wait until you resume it.
        </p>
      )}
      {job && (
        <div className="space-y-1 text-sm" role="status">
          <p className="capitalize">
            {job.target === 'offboard'
              ? 'Removal'
              : job.target === 'suspended'
                ? 'Expiry suspension'
                : 'Addon sync'}
            : {job.state}
          </p>
          {job.state === 'verified' && (
            <p>Last verified: {new Date(job.updatedAt).toLocaleString()}</p>
          )}
          {job.errorCode && (
            <p>
              {failureText[job.errorCode] ??
                'Stremio could not confirm the change. The account and saved setup are retained.'}
            </p>
          )}
          {job.state === 'retrying' && <p>Next attempt: {new Date(job.dueAt).toLocaleString()}</p>}
        </div>
      )}
      {current.state === 'staged' ? (
        <div className="space-y-3">
          <p className="text-sm">
            Assign a published group and save a dated or lifetime membership first. Preview signs in
            to the existing Stremio account and reads its addons.
          </p>
          <label className="block space-y-1 text-sm">
            <span>Protection for this account</span>
            <select
              value={safeMode}
              disabled={locked || mutation.stale}
              className="block w-full rounded border bg-background p-2"
              onChange={(event) => {
                setSafeMode(event.target.value)
                setPreview(null)
                setConsent(false)
              }}
            >
              <option value="inherit">Use group / default safe mode</option>
              <option value="on">Safe mode on</option>
              <option value="off">Safe mode off</option>
            </select>
          </label>
          <Button
            variant="outline"
            disabled={locked || !enabled || !current.groupId || current.membershipType === 'unset'}
            onClick={() => void prepare()}
          >
            {reading ? 'Preparing preview…' : 'Preview first sync'}
          </Button>
          {preview && (
            <div className="space-y-3 rounded border p-3 text-sm">
              <p>
                {preview.beforeCount} currently installed → {preview.afterCount} after sync. Safe
                mode {preview.safeMode ? 'on' : 'off'}.
              </p>
              {preview.target === 'suspended' && (
                <p>
                  This membership has expired. Activation will disable all addons and retain the
                  saved setup.
                </p>
              )}
              {preview.addons.length > 0 && (
                <ul className="max-h-48 list-disc overflow-auto pl-5">
                  {preview.addons.map((addon, index) => (
                    <li key={index}>
                      {addon.name} ({addon.id})
                    </li>
                  ))}
                </ul>
              )}
              <p>
                Activation replaces the active addon list with the reviewed setup. Later group
                publications and expiry changes sync automatically.
              </p>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={locked}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  {preview.afterCount === 0
                    ? 'Activate with every addon disabled.'
                    : 'Activate this account with the setup above.'}
                </span>
              </label>
              <Button
                disabled={locked || mutation.stale || !consent}
                onClick={() =>
                  void mutation.submit({
                    kind: 'activate',
                    body: {
                      expectedVersion: preview.version,
                      receipt: preview.receipt,
                      allowEmpty: preview.afterCount === 0,
                    },
                  })
                }
              >
                Activate and queue first sync
              </Button>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <Button
            variant="outline"
            disabled={locked || mutation.stale || !enabled || job?.state === 'running'}
            onClick={() =>
              void mutation.submit({ kind: 'sync', body: { expectedVersion: current.version } })
            }
          >
            {current.state === 'offboarding' ? 'Retry removal' : 'Sync current setup / retry'}
          </Button>
          {current.state === 'active' && (
            <details className="rounded border p-3 text-sm">
              <summary className="cursor-pointer font-medium">Remove this managed user</summary>
              <p className="my-3">
                Removal disables all remote addons. The local account and credentials are deleted
                only after Stremio confirms the collection is empty. Failed cleanup stays visible
                here.
              </p>
              <label className="mb-3 flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={removeConsent}
                  disabled={locked}
                  onChange={(event) => setRemoveConsent(event.target.checked)}
                />
                <span>Clear addons and remove {account.email}.</span>
              </label>
              <Button
                variant="destructive"
                disabled={locked || mutation.stale || !enabled || !removeConsent}
                onClick={() =>
                  void mutation.submit({
                    kind: 'offboard',
                    body: { expectedVersion: current.version },
                  })
                }
              >
                Clear addons and remove user
              </Button>
            </details>
          )}
        </div>
      )}
      <details className="rounded border p-3 text-sm">
        <summary className="cursor-pointer font-medium">Repair saved login</summary>
        <p className="my-3">
          Verify a password for {account.email}. The server saves it encrypted only after Stremio
          confirms the login. Managed accounts must keep the same Stremio identity.
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            const password = passwordInput.current?.value
            if (password)
              void mutation.submit({
                kind: 'reconnect',
                body: { expectedVersion: current.version, password },
              })
          }}
        >
          <label className="block space-y-1">
            <span>Stremio password</span>
            <input
              ref={passwordInput}
              type="password"
              required
              maxLength={4096}
              autoComplete="new-password"
              disabled={locked || mutation.stale}
              className="block w-full rounded border bg-background p-2"
            />
          </label>
          <Button variant="outline" disabled={locked || mutation.stale || !enabled}>
            Verify and save login
          </Button>
        </form>
      </details>
      {(error || mutation.message) && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.message || error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {job?.state === 'verified' ? 'The latest sync request is verified.' : notice}
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
            setPreview(null)
            setError('')
          }}
        >
          Use refreshed account
        </Button>
      )}
      <Button variant="ghost" disabled={locked} onClick={onClose}>
        Close account controls
      </Button>
    </section>
  )
}
