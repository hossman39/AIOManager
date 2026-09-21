import assert from 'node:assert/strict'
import { afterEach, beforeEach, mock, test } from 'node:test'
import localforage from 'localforage'
import './helpers'
import { decrypt, encrypt, generateSalt, loadSalt, saveSalt } from '../src/lib/crypto'

function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, String(value))
    },
  }
}

Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true })
Object.defineProperty(globalThis, 'sessionStorage', { value: memoryStorage(), configurable: true })
// These stores also subscribe to each other; exercise the real integration.
const { useAuthStore } = await import('../src/store/authStore')
const { useSyncStore } = await import('../src/store/syncStore')
const { useAccountStore } = await import('../src/store/accountStore')
const { useAddonStore } = await import('../src/store/addonStore')
const { useVaultStore } = await import('../src/store/vaultStore')
const { stremioClient } = await import('../src/api/stremio-client')
const stored = new Map<string, unknown>()
const password = 'Synthetic-manager-password!'
const id = '00000000-0000-4000-8000-000000000001'

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] })
  localStorage.clear()
  sessionStorage.clear()
  stored.clear()
  mock.method(
    localforage,
    'getItem',
    async <T>(key: string) => (stored.get(key) ?? null) as T | null
  )
  mock.method(localforage, 'setItem', async <T>(key: string, value: T) => {
    stored.set(key, value)
    return value
  })
  mock.method(localforage, 'removeItem', async (key: string) => {
    stored.delete(key)
  })
  mock.method(localforage, 'clear', async () => {
    stored.clear()
  })
  useAuthStore.setState({ encryptionKey: null, isLocked: true })
  useSyncStore.setState({
    auth: { id: '', password: '', name: '', isAuthenticated: false },
    lastSyncedAt: null,
    isSyncing: false,
    isInitialSyncCompleted: false,
    serverUrl: '',
    _syncDebounceTimer: null,
  })
  useAccountStore.setState({ accounts: [], loading: false, error: null })
  useAddonStore.setState({ library: {} })
  useVaultStore.setState({ keys: [], isLocked: true })
})

afterEach(() => mock.timers.reset())

test('an empty browser stays locked until an encryption key exists', async () => {
  useAuthStore.setState({ isLocked: false })
  await useAuthStore.getState().initialize()
  assert.equal(useAuthStore.getState().isLocked, true)
  assert.equal(useAuthStore.getState().encryptionKey, null)
})

test('a short new password is rejected before registering or changing local data', async (t) => {
  const salt = generateSalt()
  saveSalt(salt)
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  await assert.rejects(useSyncStore.getState().register('short'), /at least 8/)
  assert.equal(fetch.mock.callCount(), 0)
  assert.deepEqual(loadSalt(), salt)
  assert.equal(useSyncStore.getState().auth.isAuthenticated, false)
})

test('registration publishes the actual vault salt and works in a fresh browser', async (t) => {
  let initialState: Record<string, unknown> = {}
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: string | URL | Request, options?: RequestInit) => {
      initialState = JSON.parse(options?.body as string)
      return Response.json({})
    }
  )
  await useSyncStore.getState().register(password)
  const owner = useSyncStore.getState().auth.id
  const originalKey = useAuthStore.getState().encryptionKey!
  assert.ok(originalKey)
  assert.equal(initialState.salt, btoa(String.fromCharCode(...loadSalt()!)))
  const secret = await encrypt('Synthetic saved credential', originalKey)

  localStorage.clear()
  sessionStorage.clear()
  stored.clear()
  useAuthStore.setState({ encryptionKey: null, isLocked: true })
  useSyncStore.setState({ lastSyncedAt: null })
  t.mock.method(globalThis, 'fetch', async () => Response.json(initialState))
  await useSyncStore.getState().login(owner, password)
  assert.equal(
    await decrypt(secret, useAuthStore.getState().encryptionKey!),
    'Synthetic saved credential'
  )
  assert.equal(useAuthStore.getState().isLocked, false)

  useAuthStore.setState({ encryptionKey: null, isLocked: true })
  await useAuthStore.getState().initialize()
  assert.equal(
    await decrypt(secret, useAuthStore.getState().encryptionKey!),
    'Synthetic saved credential'
  )
})

test('registration does not report success when local vault setup fails', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  t.mock.method(useAuthStore.getState(), 'setupMasterPassword', async () => {
    throw new Error('Storage unavailable')
  })
  await assert.rejects(useSyncStore.getState().register(password), /Storage unavailable/)
  assert.equal(useSyncStore.getState().auth.isAuthenticated, false)
  assert.equal(useAuthStore.getState().encryptionKey, null)
})

test('existing saltless identity recovers without a reset and can add an encrypted Stremio account', async (t) => {
  localStorage.setItem('existing-preference', 'preserved')
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ accounts: [] }))
  // Existing identities created by the old form can still use their original password.
  await useSyncStore.getState().login(id, 'short')
  assert.equal(fetch.mock.callCount(), 1)
  assert.equal(useSyncStore.getState().auth.id, id)
  assert.equal(localStorage.getItem('existing-preference'), 'preserved')
  const key = useAuthStore.getState().encryptionKey!
  assert.ok(key)
  const salt = loadSalt()
  assert.equal(salt?.length, 16)
  assert.equal(useAuthStore.getState().isLocked, false)
  assert.equal(useSyncStore.getState().isInitialSyncCompleted, true)

  t.mock.method(stremioClient, 'login', async () => ({
    authKey: 'Synthetic-token',
    user: { _id: 'test-user', email: 'user@example.invalid' },
  }))
  t.mock.method(stremioClient, 'getAddonCollection', async () => [])
  await useAccountStore
    .getState()
    .addAccountByCredentials('user@example.invalid', 'Synthetic-Stremio-password', 'Test account')
  const account = useAccountStore.getState().accounts[0]
  assert.notEqual(account.authKey, 'Synthetic-token')
  assert.equal(await decrypt(account.authKey, key), 'Synthetic-token')
  assert.equal(await decrypt(account.password!, key), 'Synthetic-Stremio-password')
  assert.equal((stored.get('stremio-manager:accounts') as unknown[]).length, 1)

  // A repeat login uses the recovered salt; already saved secrets stay decryptable.
  await useSyncStore.getState().login(id, 'short', true)
  assert.deepEqual(loadSalt(), salt)
  assert.equal(
    await decrypt(account.authKey, useAuthStore.getState().encryptionKey!),
    'Synthetic-token'
  )
})

for (const [key, value] of [
  ['stremio-manager:accounts', [{ authKey: 'existing-ciphertext' }]],
  ['stremio-manager:key-vault', 'existing-encrypted-vault'],
] as const) {
  test(`salt recovery preserves existing encrypted data in ${key}`, async (t) => {
    stored.set(key, value)
    t.mock.method(globalThis, 'fetch', async () => Response.json({ accounts: [] }))
    await assert.rejects(
      useSyncStore.getState().login(id, password),
      /Encryption metadata is missing/
    )
    assert.deepEqual(stored.get(key), value)
    assert.equal(loadSalt(), null)
    assert.equal(useSyncStore.getState().auth.isAuthenticated, false)
  })
}

test('an incorrect server password cannot initialize a replacement vault', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 401 }))
  await assert.rejects(useSyncStore.getState().login(id, password), /Incorrect Password/)
  assert.equal(loadSalt(), null)
  assert.equal(useAuthStore.getState().encryptionKey, null)
})

test('silent login also propagates vault unlock failures', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ accounts: [], salt: btoa(String.fromCharCode(...generateSalt())) })
  )
  t.mock.method(useAuthStore.getState(), 'unlockFromSync', async () => {
    throw new Error('Encryption unavailable')
  })
  await assert.rejects(useSyncStore.getState().login(id, password, true), /Encryption unavailable/)
  assert.equal(useSyncStore.getState().auth.isAuthenticated, false)
  assert.equal(stored.size, 0)
})

test('completing an auth-key account persists its verified email and exact encrypted password', async (t) => {
  await useAuthStore.getState().setupMasterPassword(password)
  const key = useAuthStore.getState().encryptionKey!
  useAccountStore.setState({
    accounts: [
      {
        id: 'existing-cache-id',
        name: 'Auth-key account',
        authKey: await encrypt('Old-token', key),
        addons: [],
        lastSync: new Date(),
        status: 'active',
      },
    ],
  })
  const exactPassword = ' Synthetic-client-密碼!\n'
  const login = t.mock.method(stremioClient, 'login', async (email: string, supplied: string) => {
    assert.equal(email, 'saved@example.invalid')
    assert.equal(supplied, exactPassword)
    return { authKey: 'New-token', user: { _id: 'test-user', email } }
  })
  t.mock.method(stremioClient, 'getAddonCollection', async () => [])
  t.mock.method(useSyncStore.getState(), 'syncToRemote', async () => {})
  await useAccountStore.getState().updateAccount('existing-cache-id', {
    name: 'Completed account',
    email: 'saved@example.invalid',
    password: exactPassword,
  })
  const account = useAccountStore.getState().accounts[0]
  assert.equal(account.id, 'existing-cache-id')
  assert.equal(account.email, 'saved@example.invalid')
  assert.equal(await decrypt(account.password!, key), exactPassword)
  assert.equal(await decrypt(account.authKey, key), 'New-token')
  assert.equal(
    JSON.stringify(stored.get('stremio-manager:accounts')).includes(exactPassword),
    false
  )
  assert.deepEqual(stored.get('stremio-manager:accounts'), [account])

  await useAccountStore.getState().updateAccount(account.id, { name: 'Renamed only' })
  assert.equal(login.mock.callCount(), 1)
  assert.equal(useAccountStore.getState().accounts[0].password, account.password)
  assert.equal(useAccountStore.getState().accounts.length, 1)
})

test('a failed saved-login completion preserves the original account and stored credentials', async (t) => {
  await useAuthStore.getState().setupMasterPassword(password)
  const key = useAuthStore.getState().encryptionKey!
  const account = {
    id: 'existing-cache-id',
    name: 'Original',
    email: 'original@example.invalid',
    authKey: await encrypt('Old-token', key),
    password: await encrypt('Old-password', key),
    addons: [],
    lastSync: new Date(),
    status: 'active' as const,
  }
  useAccountStore.setState({ accounts: [account] })
  stored.set('stremio-manager:accounts', [account])
  t.mock.method(stremioClient, 'login', async () => {
    throw new Error('Invalid login')
  })
  const sync = t.mock.method(useSyncStore.getState(), 'syncToRemote', async () => {})
  await assert.rejects(
    useAccountStore.getState().updateAccount(account.id, {
      name: 'Failed edit',
      email: 'other@example.invalid',
      password: 'Wrong-password',
    }),
    /Invalid login/
  )
  assert.deepEqual(useAccountStore.getState().accounts, [account])
  assert.deepEqual(stored.get('stremio-manager:accounts'), [account])
  assert.equal(sync.mock.callCount(), 0)
})
