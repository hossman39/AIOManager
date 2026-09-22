import { useCallback, useEffect, useRef, useState } from 'react'
import { ManagedApiError, type AccountConnection, type createManagedApi } from '@/api/managed'
import { useAccountStore } from '@/store/accountStore'
import { useAuthStore } from '@/store/authStore'
import { useSyncStore } from '@/store/syncStore'
import { connectAccountCache } from '@/lib/managed/connect-accounts'

export function useAccountConnections(
  api: ReturnType<typeof createManagedApi>,
  onChanged: () => void
) {
  const localAccounts = useAccountStore((state) => state.accounts)
  const key = useAuthStore((state) => state.encryptionKey)
  const initialSyncCompleted = useSyncStore((state) => state.isInitialSyncCompleted)
  const [connections, setConnections] = useState<AccountConnection[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const changed = useRef(onChanged)
  changed.current = onChanged
  const cache = useRef(localAccounts)
  cache.current = localAccounts
  // Addon reads update lastSync frequently; they are not account identity edits.
  const signature = JSON.stringify(
    localAccounts.map((account) => [account.id, account.email, account.name, account.password])
  )
  const refresh = useCallback(() => setRevision((value) => value + 1), [])

  useEffect(() => {
    const currentAccounts = cache.current
    if (!initialSyncCompleted || !key || currentAccounts.length === 0) {
      setBusy(false)
      if (currentAccounts.length === 0) setConnections([])
      return
    }
    const controller = new AbortController()
    setBusy(true)
    setError('')
    void connectAccountCache(currentAccounts, key, api, controller.signal)
      .then(async (result) => {
        if (controller.signal.aborted) return
        setConnections(result)
        changed.current()
        // Removal was already verified by the server. Discard stale local copies,
        // including their old Autopilot rules, instead of re-enrolling them.
        for (const connection of result) {
          if (controller.signal.aborted) return
          if (connection.status === 'removed')
            await useAccountStore.getState().removeAccount(connection.localId)
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof ManagedApiError
              ? failure.message
              : 'Account setup could not finish. Retry to keep using the same accounts.'
          )
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false)
      })
    return () => controller.abort()
  }, [api, key, initialSyncCompleted, signature, revision])

  return { localAccounts, connections, busy, error, refresh, waiting: !initialSyncCompleted }
}
