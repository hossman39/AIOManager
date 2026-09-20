/** Aggregate independent editors into the router's single blocker. No draft data. */
export function createUnsavedWorkRegistry() {
  const entries = new Set<symbol>()
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((listener) => listener())
  return {
    getSnapshot: () => entries.size > 0,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    register: () => {
      const token = Symbol()
      const wasEmpty = entries.size === 0
      entries.add(token)
      if (wasEmpty) notify()
      return () => {
        if (entries.delete(token) && entries.size === 0) notify()
      }
    },
  }
}
