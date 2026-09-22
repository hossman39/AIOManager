import { useManagedApi } from '@/components/managed/useManagedApi'
import { ManagedGroupsPanel } from '@/components/managed/ManagedGroupsPanel'

export function GroupsPage() {
  const { api, ownerKey } = useManagedApi()
  return (
    <div className="space-y-6 pb-6">
      <div>
        <h2 className="text-2xl font-semibold">Groups</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Share an addon setup across accounts. Individual account customizations stay with that
          account.
        </p>
      </div>
      <ManagedGroupsPanel key={ownerKey} api={api} onAccountsChanged={() => {}} />
    </div>
  )
}
