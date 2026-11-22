import type { createManagedApi, ManagedAccount } from '@/api/managed'

export async function stremioSources(
  api: ReturnType<typeof createManagedApi>,
  signal: AbortSignal
) {
  const sources: ManagedAccount[] = []
  let cursor = ''
  do {
    const page = await api.accounts(cursor, signal)
    sources.push(
      ...page.accounts.filter((account) => !account.platform && account.state !== 'offboarding')
    )
    cursor = page.nextCursor ?? ''
  } while (cursor)
  return sources
}
