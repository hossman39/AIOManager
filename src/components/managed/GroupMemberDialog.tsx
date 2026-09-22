import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

export function GroupMemberDialog({
  title,
  description,
  blocked,
  onClose,
  children,
}: {
  title: string
  description: string
  blocked: boolean
  onClose: () => void
  children: ReactNode
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !blocked) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-3xl -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-xl border bg-card p-5 shadow-xl">
          <div className="space-y-2 pr-8">
            <Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              {description}
            </Dialog.Description>
          </div>
          <Dialog.Close
            disabled={blocked}
            className="absolute right-4 top-4 rounded p-1 disabled:opacity-50"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </Dialog.Close>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
