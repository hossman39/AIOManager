import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, Check, KeyRound, UserRoundPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type ManagedStatus,
} from '@/api/managed'
import { stremioSources } from '@/lib/managed/stremio-sources'
import { membershipLabel } from './account-labels'

type Api = ReturnType<typeof createManagedApi>
const actions = [
  { id: 'connect', label: 'Connect existing', icon: KeyRound },
  { id: 'register', label: 'Create new', icon: UserRoundPlus },
] as const
const choiceStyle =
  'flex cursor-pointer items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition-colors hover:border-primary/50 peer-checked:border-primary peer-checked:bg-primary/10 peer-checked:text-primary peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-default peer-disabled:opacity-50'
const message = (error: unknown) =>
  error instanceof ManagedApiError
    ? error.message
    : 'The request could not be completed. Please try again.'

export function NuvioConnect({
  api,
  onConnected,
  onBack,
}: {
  api: Api
  onConnected: (id: string) => void
  onBack: () => void
}) {
  const [mode, setMode] = useState<'connect' | 'register'>('connect')
  const [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [name, setName] = useState('')
  const [profiles, setProfiles] = useState<
    Awaited<ReturnType<Api['nuvioProfiles']>>['profiles'] | null
  >(null)
  const [profileId, setProfileId] = useState(1)
  const [copy, setCopy] = useState(false)
  const [sources, setSources] = useState<ManagedAccount[] | null>(null)
  const [source, setSource] = useState<ManagedAccount | null>(null)
  const [sourceError, setSourceError] = useState('')
  const [sourceRevision, setSourceRevision] = useState(0)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState<ManagedStatus | null>(null)
  const [statusError, setStatusError] = useState(''),
    [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const [key] = useState(() => crypto.randomUUID())
  const lifetime = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!copy) return
    const controller = new AbortController()
    setSources(null)
    setSource(null)
    setSourceError('')
    void stremioSources(api, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setSources(rows)
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setSourceError(message(failure))
      })
    return () => controller.abort()
  }, [api, copy, sourceRevision])

  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setStatus(null)
    setStatusError('')
    void api
      .status(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value)
      })
      .catch((error) => {
        if (!controller.signal.aborted) setStatusError(message(error))
      })
    return () => controller.abort()
  }, [api, revision])

  const registering = !profiles && mode === 'register'
  const blocked = !status
    ? statusError
    : !status.capabilities.providerWrites
      ? 'This server has managed writes disabled. Set MANAGED_WRITES_ENABLED=true on the AIOManager server and restart it.'
      : registering && !status.writerReady
        ? 'The sync writer is starting or recovering. Check again in a moment.'
        : registering && status.writePaused && !status.ownerWritePaused
          ? 'Writes are paused on the server. Check again once the server resumes.'
          : ''
  const needsResume = registering && status?.ownerWritePaused && !blocked

  async function submit(event: FormEvent) {
    event.preventDefault()
    const signal = lifetime.current?.signal
    if (busy || !status || blocked || !signal || signal.aborted || (copy && !source)) return
    setBusy(true)
    setError('')
    try {
      if (profiles) {
        const result = await api.connectNuvio(
          {
            email: email.trim(),
            password,
            name: name.trim(),
            profileId,
            ...(copy && source && { copyFrom: { id: source.id, expectedVersion: source.version } }),
          },
          key,
          signal
        )
        if (!signal.aborted) onConnected(result.account.id)
        return
      }
      if (needsResume) {
        const saved = await api.saveSettings(
          { expectedVersion: status.version, writePaused: false, safeMode: status.safeMode },
          crypto.randomUUID(),
          signal
        )
        if (signal.aborted) return
        setStatus({
          ...status,
          ownerWritePaused: false,
          writePaused: false,
          version: saved.version,
        })
      }
      const result = await api.nuvioProfiles(email.trim(), password, registering, signal)
      if (signal.aborted) return
      setProfileId(result.profiles.find((p) => !p.inherits)?.id ?? 1)
      setProfiles(result.profiles)
    } catch (failure) {
      if (signal.aborted) return
      if (
        profiles &&
        copy &&
        failure instanceof ManagedApiError &&
        ['VERSION_CONFLICT', 'NOT_FOUND', 'INVALID_STATE'].includes(failure.code)
      ) {
        setSourceRevision((v) => v + 1)
        setError('The source account changed. Select it again to copy its current settings.')
      } else if (
        failure instanceof ManagedApiError &&
        ['WRITE_PAUSED', 'VERSION_CONFLICT', 'WRITER_UNAVAILABLE'].includes(failure.code)
      ) {
        setRevision((value) => value + 1)
        setError('Sync settings changed. Review the current status and try again.')
      } else {
        setError(message(failure))
        if (failure instanceof ManagedApiError && failure.code === 'NUVIO_CONFIRM_EMAIL')
          setMode('connect')
      }
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }

  return (
    <DialogContent
      role="dialog"
      aria-modal="true"
      aria-labelledby="nuvio-enroll-title"
      className="max-h-[90dvh] overflow-y-auto"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onBack}
        disabled={busy}
        className="w-fit -ml-2 text-muted-foreground"
      >
        <ArrowLeft /> Apps
      </Button>
      <DialogHeader>
        <DialogTitle id="nuvio-enroll-title">
          {profiles ? 'Choose a Nuvio profile' : 'Add Nuvio account'}
        </DialogTitle>
        {profiles && <DialogDescription>{email}</DialogDescription>}
      </DialogHeader>
      <form onSubmit={submit} className="space-y-4">
        {profiles ? (
          <>
            <fieldset disabled={busy}>
              <legend className="mb-2 text-sm font-medium">Managed profile</legend>
              <div className="grid grid-cols-2 gap-2">
                {profiles.map((p) => (
                  <label key={p.id}>
                    <input
                      type="radio"
                      name="nuvio-profile"
                      className="peer sr-only"
                      value={p.id}
                      checked={profileId === p.id}
                      disabled={p.inherits}
                      onChange={() => setProfileId(p.id)}
                    />
                    <span className={choiceStyle + ' h-full flex-col text-center'}>
                      <span className="flex items-center gap-1">
                        {p.id === profileId && <Check size={16} aria-hidden="true" />}
                        {p.name}
                      </span>
                      {p.inherits && <small>Shares primary addons</small>}
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Display name (optional)</span>
              <Input
                value={name}
                maxLength={120}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="space-y-2">
              <label className="flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-sm">
                <input
                  type="checkbox"
                  checked={copy}
                  disabled={busy}
                  onChange={(event) => {
                    setSource(null)
                    setCopy(event.target.checked)
                    setError('')
                  }}
                />
                Copy membership and group from Stremio
              </label>
              {copy && (
                <fieldset disabled={busy} className="space-y-2">
                  <legend className="sr-only">Source Stremio account</legend>
                  <p className="text-xs text-muted-foreground">
                    Copies the membership date, any access override and the assigned group once. A
                    published group syncs when membership is set.
                  </p>
                  {sourceError ? (
                    <>
                      <p role="alert">{sourceError}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => setSourceRevision((v) => v + 1)}
                      >
                        Reload accounts
                      </Button>
                    </>
                  ) : !sources ? (
                    <p role="status">Loading accounts…</p>
                  ) : !sources.length ? (
                    <p role="status">No managed Stremio accounts available.</p>
                  ) : (
                    <>
                      <Input
                        aria-label="Filter Stremio accounts"
                        placeholder="Find by name or email"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                      />
                      <div className="max-h-40 space-y-1 overflow-y-auto">
                        {sources
                          .filter(
                            (a) =>
                              (a.name + ' ' + a.email)
                                .toLowerCase()
                                .includes(filter.trim().toLowerCase()) || a.id === source?.id
                          )
                          .map((a) => (
                            <label key={a.id} className="block">
                              <input
                                type="radio"
                                name="stremio-source"
                                className="peer sr-only"
                                checked={source?.id === a.id}
                                onChange={() => setSource(a)}
                              />
                              <span className={choiceStyle + ' flex-col items-start gap-0.5'}>
                                <span>
                                  {a.name && a.name !== a.email ? a.name + ' · ' : ''}
                                  {a.email}
                                </span>
                                <small>
                                  {membershipLabel(a)}
                                  {a.accessOverride === 'active'
                                    ? ' · Kept active'
                                    : a.accessOverride === 'suspended'
                                      ? ' · Manually expired'
                                      : ''}
                                  {!a.groupId && ' · No group'}
                                </small>
                              </span>
                            </label>
                          ))}
                      </div>
                    </>
                  )}
                </fieldset>
              )}
            </div>
          </>
        ) : (
          <>
            <fieldset disabled={busy} className="grid grid-cols-2 gap-2">
              <legend className="sr-only">Account action</legend>
              {actions.map(({ id, label, icon: Icon }) => (
                <label key={id}>
                  <input
                    type="radio"
                    name="nuvio-action"
                    className="peer sr-only"
                    checked={mode === id}
                    value={id}
                    onChange={() => {
                      setMode(id)
                      setError('')
                    }}
                  />
                  <span className={choiceStyle}>
                    <Icon size={16} aria-hidden="true" />
                    {label}
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Email</span>
              <Input
                required
                type="email"
                autoComplete="username"
                maxLength={254}
                value={email}
                disabled={busy}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium">Password</span>
              <Input
                required
                type="password"
                autoComplete={registering ? 'new-password' : 'current-password'}
                value={password}
                disabled={busy}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </>
        )}
        {blocked && (
          <div role="status" className="space-y-2 rounded-xl border bg-muted/40 p-3 text-sm">
            <p>{blocked}</p>
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => setRevision((value) => value + 1)}
            >
              Check again
            </Button>
          </div>
        )}
        {needsResume && (
          <p
            className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
            role="status"
          >
            Managed sync is paused. Resuming allows queued changes for your managed accounts to run.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button disabled={busy || !status || !!blocked || (copy && !source)}>
            {busy
              ? 'Working…'
              : profiles
                ? 'Add managed profile'
                : registering
                  ? needsResume
                    ? 'Resume sync and create account'
                    : 'Create Nuvio account'
                  : 'Find profiles'}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  )
}
