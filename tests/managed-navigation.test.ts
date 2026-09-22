import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryRouter } from 'react-router-dom'
import { createUnsavedWorkRegistry } from '../src/lib/managed/unsaved-work'

test('one navigation guard aggregates independent dirty editors and idempotent cleanup', () => {
  const registry = createUnsavedWorkRegistry()
  const changes: boolean[] = []
  const unsubscribe = registry.subscribe(() => changes.push(registry.getSnapshot()))
  const group = registry.register()
  const personal = registry.register()
  assert.equal(registry.getSnapshot(), true)
  group()
  group()
  assert.equal(registry.getSnapshot(), true)
  personal()
  assert.equal(registry.getSnapshot(), false)
  assert.deepEqual(changes, [true, false])
  // StrictMode setup/cleanup/setup must not leak a blocker.
  registry.register()()
  const remounted = registry.register()
  assert.equal(registry.getSnapshot(), true)
  unsubscribe()
  remounted()
  assert.equal(registry.getSnapshot(), false)
  assert.deepEqual(changes, [true, false, true, false, true])
})

test('installed router blocks links/replaces and lets an explicit choice retain or discard work', async () => {
  const registry = createUnsavedWorkRegistry()
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/managed'],
  })
  try {
    router.getBlocker('managed-work', registry.getSnapshot)
    const clearGroup = registry.register()
    const clearPersonal = registry.register()
    await router.navigate('/settings')
    assert.equal(router.state.location.pathname, '/managed')
    assert.equal(router.state.blockers.get('managed-work')?.state, 'blocked')
    router.state.blockers.get('managed-work')?.reset?.()
    clearGroup()
    await router.navigate('/faq', { replace: true })
    assert.equal(router.state.location.pathname, '/managed')
    const finished = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe((state) => {
        if (state.location.pathname === '/faq') {
          unsubscribe()
          resolve()
        }
      })
    })
    router.state.blockers.get('managed-work')?.proceed?.()
    await finished
    assert.equal(router.state.location.pathname, '/faq')
    clearPersonal()
    await router.navigate('/managed')
    assert.equal(router.state.blockers.get('managed-work')?.state, 'unblocked')
  } finally {
    router.dispose()
  }
})

test('installed router restores blocked Back/Forward and honors explicit proceed', async () => {
  const registry = createUnsavedWorkRegistry()
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/', '/managed', '/settings'],
    initialIndex: 1,
  })
  const settled = (expected: string) =>
    new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe((state) => {
        if (state.location.pathname === expected && state.navigation.state === 'idle') {
          unsubscribe()
          resolve()
        }
      })
    })
  try {
    router.getBlocker('managed-work', registry.getSnapshot)
    const release = registry.register()
    await router.navigate(-1)
    assert.equal(router.state.location.pathname, '/managed')
    router.state.blockers.get('managed-work')?.reset?.()
    await router.navigate(1)
    assert.equal(router.state.location.pathname, '/managed')
    const forward = settled('/settings')
    router.state.blockers.get('managed-work')?.proceed?.()
    await forward
    assert.equal(router.state.location.pathname, '/settings')
    release()
    const back = settled('/managed')
    await router.navigate(-1)
    await back
    assert.equal(router.state.location.pathname, '/managed')
  } finally {
    router.dispose()
  }
})
