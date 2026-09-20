import { useEffect, useRef, useState } from 'react'
import { captureManagedSubmission, managedFailure } from '@/lib/managed/submission'
export { useUnsavedWarning } from '@/components/common/UnsavedWorkGuard'

export function useManagedSubmission<T, R>(
  perform: (value: T, key: string, signal: AbortSignal) => Promise<R>,
  onSuccess: (result: R) => void
) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState({ message: '', uncertain: false, stale: false })
  const alive = useRef(false)
  const running = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const pending = useRef<{ value: T; key: string; perform: typeof perform } | null>(null)
  const success = useRef(onSuccess)
  success.current = onSuccess
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      controller.current?.abort()
      pending.current = null
    }
  }, [])

  const send = async () => {
    const ticket = pending.current
    if (running.current || !ticket) return
    running.current = true
    setBusy(true)
    setFailure({ message: '', uncertain: false, stale: false })
    const abort = new AbortController()
    controller.current = abort
    try {
      const result = await ticket.perform(ticket.value, ticket.key, abort.signal)
      if (alive.current) {
        pending.current = null
        success.current(result)
      }
    } catch (error) {
      if (alive.current) {
        const failed = managedFailure(error)
        setFailure(failed)
        if (!failed.uncertain) pending.current = null
      }
    } finally {
      running.current = false
      if (alive.current) setBusy(false)
    }
  }
  return {
    busy,
    ...failure,
    pending: pending.current?.value ?? null,
    submit: async (value: T) => {
      if (running.current || failure.stale || pending.current) return
      pending.current = { ...captureManagedSubmission(value), perform }
      await send()
    },
    retry: send,
    reset: () => {
      if (running.current || pending.current) return
      setFailure({ message: '', uncertain: false, stale: false })
    },
  }
}
