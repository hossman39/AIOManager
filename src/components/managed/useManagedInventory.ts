import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedAccount,
  type ManagedGroupSummary,
  type ManagedStatus,
} from '@/api/managed'

export function useManagedInventory(api: ReturnType<typeof createManagedApi>) {
  const [accounts, setAccounts] = useState<ManagedAccount[]>([])
  const [groups, setGroups] = useState<ManagedGroupSummary[]>([])
  const [status, setStatus] = useState<ManagedStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const abort = useRef<AbortController | null>(null)
  const refresh = useCallback(async () => {
    abort.current?.abort()
    const controller = new AbortController()
    abort.current = controller
    setLoading(true)
    setError('')
    try {
      const [summary, allAccounts, allGroups] = await Promise.all([
        api.status(controller.signal),
        (async () => {
          const rows: ManagedAccount[] = []
          let cursor = ''
          do {
            const page = await api.accounts(cursor, controller.signal)
            rows.push(...page.accounts)
            cursor = page.nextCursor ?? ''
          } while (cursor && !controller.signal.aborted)
          return rows
        })(),
        (async () => {
          const rows: ManagedGroupSummary[] = []
          let cursor = ''
          do {
            const page = await api.groups(cursor, controller.signal)
            rows.push(...page.groups)
            cursor = page.nextCursor ?? ''
          } while (cursor && !controller.signal.aborted)
          return rows
        })(),
      ])
      if (!controller.signal.aborted) {
        setStatus(summary)
        setAccounts(allAccounts)
        setGroups(allGroups)
      }
    } catch (failure) {
      if (!controller.signal.aborted)
        setError(
          failure instanceof ManagedApiError
            ? failure.message
            : 'Accounts could not be loaded. Please refresh.'
        )
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [api])
  useEffect(() => {
    void refresh()
    return () => abort.current?.abort()
  }, [refresh])
  return { accounts, groups, status, loading, error, refresh }
}
