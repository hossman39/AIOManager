import { decrypt, deriveSyncToken, loadSessionKey } from '@/lib/crypto'

export async function managerHeaders(accountId?: string): Promise<Record<string, string>> {
  const { useSyncStore } = await import('@/store/syncStore')
  const { auth } = useSyncStore.getState()
  if (!auth.isAuthenticated || !auth.id || !auth.password) throw new Error('Manager login required')
  const headers: Record<string, string> = {
    'x-manager-id': auth.id,
    'x-sync-password': await deriveSyncToken(auth.password),
  }
  if (accountId) {
    const { useAccountStore } = await import('@/store/accountStore')
    const account = useAccountStore.getState().accounts.find((entry) => entry.id === accountId)
    const session = account && (await loadSessionKey())
    if (account && session) headers['x-autopilot-proof'] = await decrypt(account.authKey, session)
  }
  return headers
}
