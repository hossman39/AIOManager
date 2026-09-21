import { useParams } from 'react-router-dom'
import { ManagedAccountsPage } from './ManagedAccountsPage'

export function AccountDetailPage() {
  const { accountId } = useParams<{ accountId: string }>()
  return <ManagedAccountsPage focusAccountId={accountId} />
}
