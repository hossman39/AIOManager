import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  const [mode, setMode] = useState<'managed' | 'login'>('managed')
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState('')
  const [search, setSearch] = useState('')
  const [preview, setPreview] = useState<HistoryPreview | null>(null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    const failed = (e: unknown) => {
      if (!controller.signal.aborted)
        setError(e instanceof ManagedApiError ? e.message : 'Could not load accounts.')
    }
    void api
      .historyProfiles(account.id, controller.signal)
      .then(({ profiles }) => {
        if (!controller.signal.aborted) setProfiles(profiles)
      })
      .catch(failed)
    return () => controller.abort()
  }, [api, account.id])
  useEffect(() => {
    if (mode !== 'managed') return
    const controller = new AbortController()
    void stremioSources(api, controller.signal)
      .then((all) => {
        if (controller.signal.aborted) return
        setSources(all)
        setSource(all.find((a) => a.email.toLowerCase() === account.email.toLowerCase())?.id ?? '')
        if (!all.length) setMode('login')
      })
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof ManagedApiError ? e.message : 'Could not load Stremio accounts.')
      })
    return () => controller.abort()
  }, [api, mode, account.email])
  function reset() {
    setPreview(null)
    setResult('')
    setError('')
  }
  async function submit() {
    if (busy) return
    setBusy(true)
    setError('')
    setResult('')
    try {
      if (!preview) {
        setPreview(
          await api.historyPreview(
            account.id,
            mode === 'managed' ? source : { email: email.trim(), password },
            profile
          )
        )
        setPassword('')
      } else {
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
      <fieldset disabled={busy} className="space-y-2">
        <legend className="mb-2 text-sm font-medium">Stremio source</legend>
        <div className="flex flex-wrap gap-2">
          {(['managed', 'login'] as const).map((value) => (
            <Button
              key={value}
              aria-pressed={mode === value}
              variant={mode === value ? 'secondary' : 'outline'}
              onClick={() => {
                if (mode !== value) {
                  reset()
                  setPassword('')
                  setMode(value)
                }
              }}
            >
              {value === 'managed' ? 'Managed account' : 'Use another login'}
            </Button>
          ))}
        </div>
        {mode === 'managed' ? (
          <>
            <Input
              aria-label="Find Stremio source"
              placeholder="Find by name or email"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
              {sources
                .filter(
                  (s) =>
                    s.id === source ||
                    (s.name + ' ' + s.email).toLowerCase().includes(search.trim().toLowerCase())
                )
                .map((s) => (
                  <Button
                    key={s.id}
                    variant={source === s.id ? 'secondary' : 'outline'}
                    aria-pressed={source === s.id}
                    onClick={() => {
                      reset()
                      setSource(s.id)
                    }}
                  >
                    {s.name && s.name !== s.email ? s.name + ' · ' : ''}
                    {s.email}
                  </Button>
                ))}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Use this login once to read history. It won’t be added to Accounts.
            </p>
            <label className="block text-sm">
              Stremio email
              <Input
                type="email"
                autoComplete="off"
                maxLength={254}
                value={email}
                onChange={(e) => {
                  reset()
                  setEmail(e.target.value)
                }}
              />
            </label>
            {!preview && (
              <label className="block text-sm">
                Stremio password
                <Input
                  type="password"
                  autoComplete="off"
                  maxLength={4096}
                  value={password}
                  onChange={(e) => {
                    reset()
                    setPassword(e.target.value)
                  }}
                />
              </label>
            )}
          </>
        )}
      </fieldset>
      <fieldset disabled={busy} className="flex flex-wrap gap-2">
        <legend className="mb-2 text-sm font-medium">Destination profile on {account.email}</legend>
        {profiles.map((p) => (
          <Button
            key={p.id}
            variant={profile === p.id ? 'secondary' : 'outline'}
            aria-pressed={profile === p.id}
            onClick={() => {
              if (profile !== p.id) {
                reset()
                setProfile(p.id)
              }
            }}
          >
            {p.name}
          </Button>
        ))}
      </fieldset>
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
          (!preview && (mode === 'managed' ? !source : !email.trim() || !password)) ||
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
