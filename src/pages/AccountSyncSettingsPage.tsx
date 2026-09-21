import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ManagedApiError, type createManagedApi, type ManagedStatus } from '@/api/managed'
import { Button } from '@/components/ui/button'
import { useManagedApi } from '@/components/managed/useManagedApi'
import { ManagedRuntimeControls } from '@/components/managed/ManagedRuntimeControls'

export function AccountSyncSettingsPage() {
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
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="/" className="text-sm text-muted-foreground">
        ← Accounts
      </Link>
      <h2 className="text-2xl font-semibold">Account sync settings</h2>
      <p className="text-sm text-muted-foreground">
        These settings apply to all your accounts, including group members.
      </p>
      {error && <p role="alert">{error}</p>}
      {status ? (
        <ManagedRuntimeControls api={api} status={status} onChanged={() => void load()} />
      ) : (
        <Button variant="outline" onClick={() => void load()}>
          Reload settings
        </Button>
      )}
    </div>
  )
}
