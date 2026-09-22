import { useCallback, useEffect, useState } from 'react'
import { ManagedApiError, type IntegrationKey } from '@/api/managed'
import { useManagedApi } from '@/components/managed/useManagedApi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUnsavedWarning } from '@/components/managed/useManagedSubmission'

const scopes: Record<string, string> = {
  read: 'View accounts, groups, and operation status',
  'accounts:write': 'Add accounts, edit memberships, and assign groups',
  'groups:write': 'Create and publish groups',
  'sync:write': 'Start and request account sync',
  'configuration:read': 'Read addon configuration, including private addon URLs',
  'credentials:read': 'Read saved Stremio passwords for device setup',
  'accounts:remove': 'Clear addons and remove accounts',
}

export function IntegrationSettings() {
  const { api, ownerKey } = useManagedApi()
  return <KeySettings key={ownerKey} api={api} />
}

function KeySettings({ api }: { api: ReturnType<typeof useManagedApi>['api'] }) {
  const [keys, setKeys] = useState<IntegrationKey[]>([])
  const [name, setName] = useState('TV Box Manager')
  const [days, setDays] = useState(90)
  const [selected, setSelected] = useState(['read'])
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useUnsavedWarning(busy || Boolean(token))
  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const result = await api.apiKeys(signal)
        if (!signal?.aborted) setKeys(result.keys)
      } catch (failure) {
        if (!signal?.aborted)
          setError(
            failure instanceof ManagedApiError ? failure.message : 'API keys could not be loaded.'
          )
      }
    },
    [api]
  )
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])
  const create = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await api.createApiKey({ name, scopes: selected, expiresInDays: days })
      setToken(result.token)
      await load()
    } catch (failure) {
      setError(
        (failure instanceof ManagedApiError ? failure.message : 'The key could not be created.') +
          ' Refresh the list before trying again; revoke any unused key if its response was lost.'
      )
      await load()
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (id: string) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api.revokeApiKey(id)
      await load()
      setMessage('API key revoked.')
    } catch (failure) {
      setError(
        failure instanceof ManagedApiError
          ? failure.message
          : 'Revocation could not be confirmed. Refresh and retry.'
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h2 className="text-xl font-semibold">API integrations</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Connect TV Box Manager or another app using a separate access key. Choose what it can do.
          Remote connections use this installation’s HTTPS address followed by <code>/api/v1</code>.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {token ? (
        <section className="space-y-3 rounded-xl border p-4">
          <h3 className="font-medium">Save this key</h3>
          <p className="text-sm text-muted-foreground">
            This is the only time the complete key is shown. Store it in your connecting app’s
            secure credential storage.
          </p>
          <Input
            aria-label="New API key"
            type="password"
            readOnly
            value={token}
            onFocus={(event) => event.target.select()}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(token)
                  setMessage('API key copied.')
                } catch {
                  setError('Copy was unavailable. Select the key field and copy it manually.')
                }
              }}
            >
              Copy key
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                setToken('')
                setMessage('')
              }}
            >
              I saved the key
            </Button>
          </div>
        </section>
      ) : (
        <section className="space-y-4 rounded-xl border p-4">
          <h3 className="font-medium">Create an access key</h3>
          <label className="block space-y-2 text-sm">
            <span>Name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              disabled={busy}
            />
          </label>
          <label className="flex flex-wrap items-center gap-3 text-sm">
            Expires after
            <select
              aria-label="API key lifetime"
              className="rounded-md border bg-background p-2"
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
              disabled={busy}
            >
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
              <option value={365}>1 year</option>
            </select>
          </label>
          <fieldset className="space-y-3">
            <legend className="mb-2 text-sm font-medium">Permissions</legend>
            {Object.entries(scopes).map(([scope, label]) => (
              <label key={scope} className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.includes(scope)}
                  disabled={busy || scope === 'read'}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, scope]
                        : current.filter((item) => item !== scope)
                    )
                  }
                />
                {label}
              </label>
            ))}
          </fieldset>
          <Button
            disabled={
              busy ||
              !name.trim() ||
              (selected.includes('groups:write') && !selected.includes('configuration:read'))
            }
            onClick={() => void create()}
          >
            Create key
          </Button>
          {selected.includes('groups:write') && !selected.includes('configuration:read') && (
            <p className="text-sm text-muted-foreground">
              Group editing also requires permission to read addon configuration.
            </p>
          )}
        </section>
      )}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium">Existing keys</h3>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              setError('')
              void load()
            }}
          >
            Refresh
          </Button>
        </div>
        {keys.length === 0 && <p className="text-sm text-muted-foreground">No API keys yet.</p>}
        {keys.map((key) => (
          <article
            key={key.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4"
          >
            <div className="min-w-0 space-y-1">
              <p className="break-words font-medium">{key.name}</p>
              <p className="text-xs text-muted-foreground">
                {key.revokedAt
                  ? 'Revoked'
                  : key.expiresAt <= Date.now()
                    ? 'Expired'
                    : `Expires ${new Date(key.expiresAt).toLocaleDateString()}`}
              </p>
              <p className="text-xs text-muted-foreground">
                Last used: {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Never'}
              </p>
              <p className="break-all text-xs text-muted-foreground">{key.scopes.join(', ')}</p>
            </div>
            {!key.revokedAt && key.expiresAt > Date.now() && (
              <Button
                variant="outline"
                disabled={busy || Boolean(token)}
                onClick={() => void revoke(key.id)}
              >
                Revoke
              </Button>
            )}
          </article>
        ))}
      </section>
    </div>
  )
}
