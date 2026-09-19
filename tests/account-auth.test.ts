import assert from 'node:assert/strict'
import { test } from 'node:test'
import './helpers'
import { loginWithCredentials, registerAccount } from '../src/api/auth'

const email = 'synthetic@example.invalid'
const password = ' synthetic PaSSword \t'
const result = { authKey: 'synthetic-token', user: { _id: 'synthetic-user', email } }

test('existing login API preserves exact email/password and returns provider identity', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ result }))
  assert.deepEqual(await loginWithCredentials(email, password), result)
  assert.equal(fetchMock.mock.callCount(), 1)
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'https://api.strem.io/api/login')
  assert.equal(options?.method, 'POST')
  assert.deepEqual(JSON.parse(options?.body as string), { type: 'Auth', email, password })
})

test('existing Stremio registration API is preserved', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => Response.json({ result }))
  assert.deepEqual(await registerAccount(email, password), result)
  const [url, options] = fetchMock.mock.calls[0].arguments
  assert.equal(url, 'https://api.strem.io/api/register')
  assert.deepEqual(JSON.parse(options?.body as string), { type: 'Auth', email, password })
})

test('login exposes not-found code for the existing deliberate onboarding flow', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      error: { code: 'USER_NOT_FOUND', message: 'User not found' },
    })
  )
  await assert.rejects(loginWithCredentials(email, password), { code: 'USER_NOT_FOUND' })
  assert.equal(fetchMock.mock.callCount(), 1)
})

test('incorrect password is not silently converted to registration by login', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      error: { code: 'WRONG_PASSWORD', message: 'Invalid password' },
    })
  )
  await assert.rejects(loginWithCredentials(email, password), { code: 'WRONG_PASSWORD' })
  assert.equal(fetchMock.mock.callCount(), 1)
  assert.equal(fetchMock.mock.calls[0].arguments[0], 'https://api.strem.io/api/login')
})

for (const [name, operation] of [
  ['login', loginWithCredentials],
  ['registration', registerAccount],
] as const) {
  test(`${name} rejects missing authentication keys instead of recording success`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ result: { user: result.user } }))
    await assert.rejects(operation(email, password), /no auth key/)
  })
}

test('registration rejects provider-reported errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ error: { message: 'Account already exists' } })
  )
  await assert.rejects(registerAccount(email, password), /Account already exists/)
})
