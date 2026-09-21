import { useMemo } from 'react'
import { createManagedApi } from '@/api/managed'
import { useSyncStore } from '@/store/syncStore'

export function useManagedApi() {
  const auth = useSyncStore((state) => state.auth)
  const serverUrl = useSyncStore((state) => state.serverUrl)
  const api = useMemo(
    () => createManagedApi({ managerId: auth.id, password: auth.password, serverUrl }),
    [auth.id, auth.password, serverUrl]
  )
  return { api, ownerKey: auth.id + ':' + serverUrl }
}
