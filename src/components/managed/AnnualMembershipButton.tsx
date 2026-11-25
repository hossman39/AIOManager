import type { BulkMembership, ManagedAccount } from '@/api/managed'
import { Button } from '@/components/ui/button'

export function AnnualMembershipButton({
  account,
  onSave,
}: {
  account: ManagedAccount
  onSave: (membership: BulkMembership) => void
}) {
  const lifetime = account.membershipType === 'lifetime'
  return (
    <div className="space-y-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={account.state === 'offboarding'}
        aria-describedby="annual-membership-help"
        onClick={() => onSave({ mode: lifetime ? 'start-year' : 'add-year' })}
      >
        Add 12 months
      </Button>
      <p id="annual-membership-help" className="text-xs text-muted-foreground">
        {lifetime
          ? 'One click replaces Lifetime with a 12-month membership starting today.'
          : 'Adds a year to the saved expiry, or starts today for a new or expired membership.'}
      </p>
    </div>
  )
}
