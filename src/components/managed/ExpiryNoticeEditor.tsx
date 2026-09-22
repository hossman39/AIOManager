import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock3 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ManagedApiError, type createManagedApi, type ManagedExpiryNotice } from '@/api/managed'
import { defaultExpiryNotice, type ExpiryNoticeSettings } from '../../../shared/expiry-notice.js'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

type Api = ReturnType<typeof createManagedApi>
const field = 'w-full min-w-0 rounded-md border bg-background px-3 py-2 text-sm'
const initial = (settings: ExpiryNoticeSettings): ExpiryNoticeSettings => ({
  enabled: settings.enabled,
  baseUrl: settings.baseUrl || window.location.origin,
  message: settings.message,
  renewalUrl: settings.renewalUrl,
})
export function ExpiryNoticeEditor({ api, onChanged }: { api: Api; onChanged: () => void }) {
  const [saved, setSaved] = useState<ManagedExpiryNotice | null>(null)
  const [draft, setDraft] = useState(() => initial(defaultExpiryNotice))
  const [reading, setReading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const abort = useRef<AbortController | null>(null)
  const mutation = useManagedSubmission<
    Parameters<Api['saveExpiryNotice']>[0],
    Awaited<ReturnType<Api['saveExpiryNotice']>>
  >(
    (body, key, signal) => api.saveExpiryNotice(body, key, signal),
    (result) => {
      setSaved(result)
      setDraft(initial(result.settings))
      setNotice(
        result.settings.enabled
          ? `Expiry notice saved. ${result.queued} expired account${result.queued === 1 ? '' : 's'} queued for sync.`
          : 'Expiry notice turned off. Selected addons still remain disabled on expiry.'
      )
      onChanged()
    }
  )
  const load = useCallback(async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setReading(true)
    setError('')
    try {
      const result = await api.expiryNotice(controller.signal)
      if (!controller.signal.aborted) {
        setSaved(result)
        setDraft(initial(result.settings))
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof ManagedApiError
            ? failure.message
            : 'Expiry notice settings could not be loaded.'
        )
    } finally {
      if (!controller.signal.aborted) setReading(false)
    }
  }, [api])
  useEffect(() => {
    void load()
    return () => abort.current?.abort()
  }, [load])
  const dirty = saved !== null && JSON.stringify(draft) !== JSON.stringify(initial(saved.settings))
  const locked = reading || mutation.busy || mutation.uncertain || mutation.stale
  useUnsavedWarning(dirty || mutation.busy || mutation.uncertain)
  let localUrl = false
  try {
    localUrl =
      ['localhost', '[::1]'].includes(new URL(draft.baseUrl).hostname) ||
      new URL(draft.baseUrl).hostname.startsWith('127.')
  } catch {
    /* The form validates URL syntax. */
  }
  return (
    <section
      className="space-y-4 rounded-xl border bg-card p-4"
      aria-labelledby="expiry-notice-heading"
    >
      <div>
        <h3 id="expiry-notice-heading" className="font-semibold">
          Expiry notice in Stremio
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Show a renewal message in movie and episode sources for expired accounts. Keep a metadata
          addon available using the group’s expiry choices so shows still open. Renewal removes the
          notice and restores the saved setup.
        </p>
      </div>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (saved && !locked)
            void mutation.submit({ expectedVersion: saved.version, settings: draft })
        }}
      >
        <fieldset disabled={locked} className="min-w-0 space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />{' '}
            Show a membership expired card
          </label>
          <label className="block space-y-1 text-sm" htmlFor="notice-base-url">
            <span>AIOManager address reachable from Stremio</span>
            <input
              id="notice-base-url"
              className={field}
              type="url"
              required={draft.enabled}
              maxLength={2048}
              placeholder="https://manager.example.com"
              value={draft.baseUrl}
              onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Use the address of this installation. It must stay online and allow Stremio to reach the
            notice without a website login. HTTPS works across devices.
          </p>
          {localUrl && (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              This local address works only on this computer. For a TV or another device, use an
              address that device can reach.
            </p>
          )}
          <label className="block space-y-1 text-sm" htmlFor="notice-message">
            <span>Message to the user</span>
            <textarea
              id="notice-message"
              className={field}
              rows={3}
              required
              maxLength={600}
              value={draft.message}
              onChange={(event) => setDraft({ ...draft, message: event.target.value })}
            />
          </label>
          <label className="block space-y-1 text-sm" htmlFor="notice-renewal-url">
            <span>Renewal or contact link (optional)</span>
            <input
              id="notice-renewal-url"
              className={field}
              type="url"
              maxLength={2048}
              placeholder="https://example.com/renew"
              value={draft.renewalUrl}
              onChange={(event) => setDraft({ ...draft, renewalUrl: event.target.value })}
            />
          </label>
          <div
            className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
            aria-label="Expiry notice preview"
          >
            <Clock3 className="mb-2 h-6 w-6 text-amber-500" />
            <p className="font-semibold">Membership expired</p>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {draft.message}
            </p>
            {draft.renewalUrl && <p className="mt-2 text-sm font-medium">Renew membership</p>}
          </div>
          <Button type="submit" disabled={!saved || !dirty}>
            {mutation.busy ? 'Saving…' : 'Save expiry notice'}
          </Button>
        </fieldset>
      </form>
      {(error || mutation.message) && (
        <p role="alert" className="text-sm text-destructive">
          {error || mutation.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      {mutation.uncertain && (
        <Button disabled={mutation.busy} onClick={() => void mutation.retry()}>
          Confirm the same save
        </Button>
      )}
      {(error || mutation.stale || dirty) && (
        <Button
          variant="ghost"
          disabled={reading || mutation.busy || mutation.uncertain}
          onClick={() => {
            mutation.reset()
            void load()
          }}
        >
          Reload saved notice settings
        </Button>
      )}
    </section>
  )
}
