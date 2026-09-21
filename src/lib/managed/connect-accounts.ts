import type { StremioAccount } from '@/types/account'
import type { AccountConnection, AccountConnectionInput, createManagedApi } from '@/api/managed'
import { decrypt } from '@/lib/crypto'

/** Existing account credentials are sent directly to the same manager's server.
 * No exported file, token, addon configuration, or extra browser persistence.
 */
export async function connectAccountCache(
  accounts: StremioAccount[],
  key: CryptoKey,
  api: Pick<ReturnType<typeof createManagedApi>, 'connectAccounts'>,
  signal: AbortSignal
) {
  const connections: AccountConnection[] = []
  for (let offset = 0; offset < accounts.length; offset += 100) {
    signal.throwIfAborted()
    const input: AccountConnectionInput[] = await Promise.all(
      accounts.slice(offset, offset + 100).map(async (account) => {
        let password: string | undefined
        if (account.password) {
          try {
            password = await decrypt(account.password, key)
          } catch {
            /* Request a saved login in the UI. */
          }
        }
        return {
          localId: account.id,
          ...(account.email ? { email: account.email.trim() } : {}),
          name: account.name.slice(0, 120),
          ...(password ? { password } : {}),
        }
      })
    )
    signal.throwIfAborted()
    const result = await api.connectAccounts(input, signal)
    connections.push(...result.connections)
  }
  return connections
}
