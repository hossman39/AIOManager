import { ChevronRight, Clapperboard, Tv } from 'lucide-react'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

const providers = [
  { id: 'stremio', name: 'Stremio', description: 'Email, OAuth or auth key', icon: Clapperboard },
  { id: 'nuvio', name: 'Nuvio', description: 'Connect or create an account', icon: Tv },
] as const

export type AccountProvider = (typeof providers)[number]['id']

export function AccountProviderPicker({
  onSelect,
}: {
  onSelect: (provider: AccountProvider) => void
}) {
  return (
    <DialogContent role="dialog" aria-modal="true" aria-labelledby="choose-account-title">
      <DialogHeader>
        <DialogTitle id="choose-account-title">Add account</DialogTitle>
        <DialogDescription>Choose your streaming app.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-3 min-[400px]:grid-cols-2">
        {providers.map(({ id, name, description, icon: Icon }) => (
          <button
            type="button"
            key={id}
            onClick={() => onSelect(id)}
            className="group flex flex-col gap-3 rounded-xl border bg-card p-4 text-left transition-colors hover:border-primary/60 hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex w-full items-center justify-between">
              <span className="rounded-lg bg-primary/10 p-2 text-primary">
                <Icon aria-hidden="true" size={20} />
              </span>
              <ChevronRight
                aria-hidden="true"
                size={16}
                className="text-muted-foreground group-hover:text-primary"
              />
            </span>
            <span>
              <span className="block font-semibold">{name}</span>
              <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
            </span>
          </button>
        ))}
      </div>
    </DialogContent>
  )
}
