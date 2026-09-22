import assert from 'node:assert/strict'
import { test } from 'node:test'
import './helpers'
import { connectAccountCache } from '../src/lib/managed/connect-accounts'
import { encrypt } from '../src/lib/crypto'
import type { StremioAccount } from '../src/types/account'
import type { AccountConnectionInput } from '../src/api/managed'

const cacheAccount = (id: string, password?: string): StremioAccount => ({
  id,
  name: 'Test account',
  email: 'test@example.invalid',
  password,
  authKey: 'encrypted-token-not-to-be-sent',
  addons: [],
  status: 'active',
  lastSync: new Date(),
})
const key = () =>
  crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

test('normal account setup sends exact saved credentials without an export, token, or addon upload', async () => {
  const encryptionKey = await key()
  const password = '  Synthetic password\t🔑'
  const account = cacheAccount('local-id', await encrypt(password, encryptionKey))
  let sent: AccountConnectionInput[] = []
  await connectAccountCache(
    [account],
    encryptionKey,
    {
      connectAccounts: async (input) => {
        sent = input
        return {
          connections: [{ localId: account.id, status: 'needs_credentials', account: null }],
        }
      },
    },
    new AbortController().signal
  )
  assert.deepEqual(sent, [
    { localId: 'local-id', email: 'test@example.invalid', name: 'Test account', password },
  ])
  assert.notEqual(account.password, password)
})

test('auth-key accounts and unreadable saved passwords can be completed without overwriting them', async () => {
  const accounts = [cacheAccount('no-password'), cacheAccount('wrong-key', 'unreadable-ciphertext')]
  const sent: AccountConnectionInput[] = []
  await connectAccountCache(
    accounts,
    await key(),
    {
      connectAccounts: async (input) => {
        sent.push(...input)
        return {
          connections: input.map((row) => ({
            localId: row.localId,
            status: 'needs_credentials',
            account: null,
          })),
        }
      },
    },
    new AbortController().signal
  )
  assert.ok(sent.every((row) => !('password' in row)))
  assert.equal(accounts[1].password, 'unreadable-ciphertext')
})

test('large local caches are connected in bounded batches and cancellation stops subsequent uploads', async () => {
  const accounts = Array.from({ length: 201 }, (_, index) => cacheAccount(`local-${index}`))
  const controller = new AbortController()
  const sizes: number[] = []
  await assert.rejects(
    connectAccountCache(
      accounts,
      await key(),
      {
        connectAccounts: async (input) => {
          sizes.push(input.length)
          controller.abort()
          return { connections: [] }
        },
      },
      controller.signal
    ),
    { name: 'AbortError' }
  )
  assert.deepEqual(sizes, [100])
})
