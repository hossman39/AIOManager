import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { stremioSources } from '@/lib/managed/stremio-sources'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type HistoryPreview,
} from '@/api/managed'

type Api = ReturnType<typeof createManagedApi>
export function NuvioHistory({ api, account }: { api: Api; account: ManagedAccount }) {
  const [opened, setOpened] = useState(false)
  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h3 className="font-semibold">Watch history</h3>
      {opened ? (
        <ImportForm api={api} account={account} />
      ) : (
        <Button variant="outline" onClick={() => setOpened(true)}>
          Import watch history from Stremio
        </Button>
      )}
    </section>
  )
}
function ImportForm({ api, account }: { api: Api; account: ManagedAccount }) {
  const [sources, setSources] = useState<ManagedAccount[]>([])
  const [profiles, setProfiles] = useState<Awaited<ReturnType<Api['historyProfiles']>>['profiles']>(
    []
  )
  const [source, setSource] = useState(''),
    [profile, setProfile] = useState(account.profileId ?? 1)
  const [preview, setPreview] = useState<HistoryPreview | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      const all = await stremioSources(api, controller.signal)
      const data = await api.historyProfiles(account.id, controller.signal)
      if (!controller.signal.aborted) {
        setSources(all)
        setProfiles(data.profiles)
        setSource(all.find((a) => a.email.toLowerCase() === account.email.toLowerCase())?.id ?? '')
      }
    }
    void load().catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof ManagedApiError ? e.message : 'Could not load accounts.')
    })
    return () => controller.abort()
  }, [api, account.id, account.email])
  function reset() {
    setPreview(null)
    setResult('')
    setError('')
  }
  async function submit() {
    if (!source || busy) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      if (!preview) setPreview(await api.historyPreview(account.id, source, profile))
      else {
        const r = await api.importHistory(account.id, preview.preview)
        setResult(
          `Confirmed on Nuvio: ${r.watched} watched items, ${r.progress} resume points. ${r.preserved ? r.preserved + ' newer Nuvio entries preserved. ' : ''}${r.unconfirmed ? r.unconfirmed + ' entries could not be confirmed. Preview again to retry.' : ''}`
        )
        setPreview(null)
      }
    } catch (e) {
      setError(e instanceof ManagedApiError ? e.message : 'Import could not be confirmed.')
      if (e instanceof ManagedApiError && e.code === 'PREVIEW_STALE') setPreview(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Copy watched titles and resume points once. Existing newer Nuvio progress takes priority.
      </p>
      <label className="block">
        Stremio source
        <select
          className="mt-1 w-full rounded border bg-background p-2"
          value={source}
          disabled={busy}
          onChange={(e) => {
            reset()
            setSource(e.target.value)
          }}
        >
          <option value="">Choose a managed Stremio account</option>
          {sources.map((s) => (
            <option value={s.id} key={s.id}>
              {s.name} ({s.email})
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        Destination profile on {account.email}
        <select
          className="mt-1 w-full rounded border bg-background p-2"
          value={profile}
          disabled={busy}
          onChange={(e) => {
            reset()
            setProfile(Number(e.target.value))
          }}
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {preview && (
        <div role="status">
          <p>
            {preview.watched} watched items and {preview.progress} resume points to import.
          </p>
          {preview.skippedCount > 0 && (
            <p>
              Unmatched titles ({preview.skippedCount}): {preview.skipped.join(', ')}
            </p>
          )}
        </div>
      )}
      {result && <p role="status">{result}</p>}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <Button
        variant="outline"
        disabled={
          busy ||
          !source ||
          !profiles.length ||
          (!!preview && !preview.watched && !preview.progress)
        }
        onClick={() => void submit()}
      >
        {busy ? 'Working…' : preview ? 'Confirm import' : 'Preview import'}
      </Button>
    </div>
  )
}
