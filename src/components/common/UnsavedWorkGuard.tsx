import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { useBlocker } from 'react-router-dom'
import { createUnsavedWorkRegistry } from '@/lib/managed/unsaved-work'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

type Guard = {
  registry: ReturnType<typeof createUnsavedWorkRegistry>
  leave: (action: () => void) => void
}
const Context = createContext<Guard | null>(null)

function useGuard() {
  const guard = useContext(Context)
  if (!guard) throw new Error('Unsaved work requires the navigation guard')
  return guard
}

export function useUnsavedWarning(unsaved: boolean) {
  const { registry } = useGuard()
  useEffect(() => {
    if (unsaved) return registry.register()
  }, [registry, unsaved])
}

/** For explicit non-route exits (logout). Never use this to postpone security locks. */
export function useGuardedLeave() {
  return useGuard().leave
}

export function UnsavedWorkGuard({ children }: { children: ReactNode }) {
  const [registry] = useState(createUnsavedWorkRegistry)
  const unsaved = useSyncExternalStore(registry.subscribe, registry.getSnapshot)
  // Read the aggregate at navigation time, including programmatic and POP navigation.
  const blocker = useBlocker(registry.getSnapshot)
  const [exit, setExit] = useState<{ run: () => void } | null>(null)
  const leave = useCallback(
    (action: () => void) => {
      if (registry.getSnapshot()) setExit((previous) => previous ?? { run: action })
      else action()
    },
    [registry]
  )
  const context = useMemo(() => ({ registry, leave }), [registry, leave])
  useEffect(() => {
    if (!unsaved) return
    const warn = (event: BeforeUnloadEvent) => {
      if (!registry.getSnapshot()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [registry, unsaved])

  const stay = () => {
    setExit(null)
    if (blocker.state === 'blocked') blocker.reset()
  }
  const proceed = () => {
    if (exit) {
      const run = exit.run
      setExit(null)
      if (blocker.state === 'blocked') blocker.reset()
      run()
    } else if (blocker.state === 'blocked') blocker.proceed()
  }
  return (
    <Context.Provider value={context}>
      {children}
      <AlertDialog
        open={Boolean(exit) || blocker.state === 'blocked'}
        onOpenChange={(open) => {
          if (!open) stay()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave unfinished managed work?</AlertDialogTitle>
            <AlertDialogDescription>
              Unsaved edits will be lost. A submitted request may already have reached the server;
              leaving does not undo it. Stay to save or retry an unconfirmed request, or leave and
              check the saved state when you return.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Stay and keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault()
                proceed()
              }}
            >
              Leave this work
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Context.Provider>
  )
}
