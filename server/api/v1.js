import { createHash } from 'node:crypto'
import { authenticateApiKey } from '../managed/api-keys.js'
import { ManagedError } from '../managed/errors.js'
import { ProviderFailure } from '../managed/worker.js'
import { apiDocument } from './v1-schema.js'

const read = ['read']
const write = ['read', 'accounts:write']
const configRead = ['read', 'configuration:read']
const groupWrite = ['read', 'groups:write', 'configuration:read']
const sync = ['read', 'sync:write']
// Names also identify durable receipts; changing these is a contract change.
export const apiActions = Object.freeze({
  create: { scope: 'api.accounts.create', scopes: write },
  link: { scope: 'api.accounts.link', scopes: write },
  name: { scope: 'accounts.name', scopes: write },
  membership: { scope: 'accounts.membership', scopes: write },
  'bulk-membership': { scope: 'accounts.bulk-membership', scopes: write },
  'assign-group': { scope: 'accounts.assign-group', scopes: write },
  addons: { scope: 'accounts.addons', scopes: [...write, 'configuration:read'] },
  sync: { scope: 'accounts.sync', scopes: sync },
  'bulk-sync': { scope: 'accounts.bulk-sync', scopes: sync },
  activate: { scope: 'accounts.activate', scopes: sync },
  reconnect: { scope: 'accounts.reconnect', scopes: [...write, 'sync:write'] },
  offboard: { scope: 'accounts.offboard', scopes: ['read', 'accounts:remove'] },
  'create-group': { scope: 'groups.create', scopes: groupWrite },
  'publish-group': { scope: 'groups.publish-changes', scopes: groupWrite },
})

export async function registerIntegrationRoutes(app, repository, db, { version, instanceId }) {
  const buckets = new Map()
  function limit(key, maximum, reply) {
    const now = Date.now()
    let bucket = buckets.get(key)
    if (!bucket || bucket.until <= now) {
      if (buckets.size >= 4096) {
        for (const [id, item] of buckets) if (item.until <= now) buckets.delete(id)
        if (buckets.size >= 4096) {
          reply.header('Retry-After', '60')
          throw new ManagedError('RATE_LIMITED')
        }
      }
      bucket = { until: now + 60_000, count: 0 }
      buckets.set(key, bucket)
    }
    if (++bucket.count > maximum) {
      reply.header('Retry-After', String(Math.max(1, Math.ceil((bucket.until - now) / 1000))))
      throw new ManagedError('RATE_LIMITED')
    }
  }
  await app.register(
    async (routes) => {
      routes.decorateRequest('integrationAuth', null)
      routes.decorateRequest('integrationKey', null)
      routes.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store')
        reply.header('Pragma', 'no-cache')
        reply.header('X-Request-Id', request.id)
        limit(`ip:${request.ip}`, 600, reply)
        const bearer = request.headers.authorization
        if (typeof bearer !== 'string' || !bearer.startsWith('Bearer '))
          throw new ManagedError('UNAUTHORIZED')
        const requiredScopes = request.routeOptions.config.apiScopes ?? read
        const auth = { apiKey: bearer.slice(7), requiredScopes }
        const identity = await authenticateApiKey(db, auth)
        const fingerprint = createHash('sha256').update(identity.key.id).digest('hex')
        limit(`key:${fingerprint}`, 120, reply)
        if (request.method !== 'GET' && request.method !== 'HEAD')
          limit(`write:${fingerprint}`, 30, reply)
        request.integrationAuth = auth
        request.integrationKey = identity
        if (identity.key.lastUsedAt === null || Date.now() - identity.key.lastUsedAt > 60_000)
          await db.run('UPDATE managed_api_keys SET last_used_at = $1 WHERE id = $2', [
            Date.now(),
            identity.key.id,
          ])
      })
      routes.setErrorHandler((failure, request, reply) => {
        let error = failure
        if (failure instanceof ProviderFailure)
          error = new ManagedError(
            failure.code === 'INVALID_CREDENTIALS' ? 'INVALID_CREDENTIALS' : 'PROVIDER_FAILURE'
          )
        if (error instanceof ManagedError) {
          if (error.statusCode === 401) reply.header('WWW-Authenticate', 'Bearer')
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message, requestId: request.id } })
        }
        const code =
          error.statusCode === 413
            ? 413
            : error.statusCode >= 400 && error.statusCode < 500
              ? 400
              : 500
        if (code === 500)
          request.log.error(
            { category: 'Integration', requestId: request.id },
            'Integration request failed'
          )
        return reply.code(code).send({
          error: {
            code:
              code === 413
                ? 'REQUEST_TOO_LARGE'
                : code === 400
                  ? 'INVALID_INPUT'
                  : 'INTERNAL_ERROR',
            message:
              code === 500
                ? 'Check the operation or retry the same request key to confirm its outcome.'
                : 'The API request is invalid or exceeds its size limit.',
            requestId: request.id,
          },
        })
      })
      const get = (path, scopes, handler) =>
        routes.get(path, { config: { apiScopes: scopes } }, handler)
      const post = (path, action, handler, bodyLimit = 64 * 1024) =>
        routes.post(
          path,
          {
            config: { apiScopes: apiActions[action].scopes },
            bodyLimit,
            preHandler: async (request) => {
              if (!/^[A-Za-z0-9_-]{16,128}$/.test(request.headers['idempotency-key'] ?? ''))
                throw new ManagedError('IDEMPOTENCY_KEY_REQUIRED')
            },
          },
          handler
        )
      const auth = (request) => request.integrationAuth
      const key = (request) => request.headers['idempotency-key']
      const page = (request) => ({
        ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
        ...(request.query.after === undefined ? {} : { after: request.query.after }),
      })
      get('/me', read, (request) => ({
        apiVersion: '1',
        applicationVersion: version,
        instanceId,
        ownerId: request.integrationKey.owner,
        key: request.integrationKey.key,
        capabilities: {
          managedAccounts: true,
          groups: true,
          memberships: true,
          operations: true,
          externalReferences: true,
          providerRegistration: false,
          billing: false,
          iptv: false,
        },
      }))
      get('/openapi.json', read, () => apiDocument(version, apiActions))
      get('/status', read, (request) => repository.status(auth(request)))
      get('/accounts', read, (request) =>
        repository.listAccounts(auth(request), {
          ...page(request),
          ...(request.query.view === undefined ? {} : { view: request.query.view }),
        })
      )
      get('/accounts/:id', read, (request) =>
        repository.getAccount(auth(request), request.params.id)
      )
      get('/accounts/:id/execution', read, (request) =>
        repository.accountExecution(auth(request), request.params.id)
      )
      get('/accounts/:id/credentials', ['read', 'credentials:read'], (request) =>
        repository.integrationCredentials(auth(request), request.params.id)
      )
      get('/accounts/:id/addons', configRead, (request) =>
        repository.getAccountAddons(auth(request), request.params.id, { live: false })
      )
      get('/account-references/:ref', read, (request) =>
        repository.integrationAccount(auth(request), request.params.ref)
      )
      post('/accounts', 'create', (request) =>
        repository.createIntegrationAccount(auth(request), request.body, key(request))
      )
      post('/account-references', 'link', (request) =>
        repository.linkIntegrationAccount(auth(request), request.body, key(request))
      )
      post('/accounts/:id/name', 'name', (request) =>
        repository.updateAccountName(auth(request), request.params.id, request.body, key(request))
      )
      post('/accounts/:id/membership', 'membership', (request) =>
        repository.setMembership(auth(request), request.params.id, request.body, key(request))
      )
      post('/accounts/bulk-membership', 'bulk-membership', (request) =>
        repository.setAccountsMembership(auth(request), request.body, key(request))
      )
      post('/accounts/assign-group', 'assign-group', (request) =>
        repository.assignGroup(auth(request), request.body, key(request))
      )
      post(
        '/accounts/:id/addons',
        'addons',
        (request) =>
          repository.setAccountAddons(auth(request), request.params.id, request.body, key(request)),
        3 * 1024 * 1024
      )
      post('/accounts/:id/sync', 'sync', (request) =>
        repository.requestSync(auth(request), request.params.id, request.body, key(request))
      )
      post('/accounts/bulk-sync', 'bulk-sync', (request) =>
        repository.requestAccountsSync(auth(request), request.body, key(request))
      )
      routes.post(
        '/accounts/:id/activation-preview',
        { config: { apiScopes: sync }, bodyLimit: 4096 },
        (request) => repository.previewActivation(auth(request), request.params.id, request.body)
      )
      post('/accounts/:id/activate', 'activate', (request) =>
        repository.activateAccount(auth(request), request.params.id, request.body, key(request))
      )
      post('/accounts/:id/reconnect', 'reconnect', (request) =>
        repository.reconnectAccount(auth(request), request.params.id, request.body, key(request))
      )
      post('/accounts/:id/offboard', 'offboard', (request) =>
        repository.requestSync(auth(request), request.params.id, request.body, key(request), true)
      )
      get('/groups', read, (request) => repository.listGroups(auth(request), page(request)))
      get('/groups/:id', configRead, (request) =>
        repository.getGroup(auth(request), request.params.id)
      )
      get('/groups/:id/deployment', read, (request) =>
        repository.getGroupDeployment(auth(request), request.params.id)
      )
      post(
        '/groups',
        'create-group',
        (request) => repository.createGroup(auth(request), request.body, key(request)),
        2 * 1024 * 1024 + 4096
      )
      post(
        '/groups/:id/publish',
        'publish-group',
        (request) =>
          repository.publishGroupChanges(
            auth(request),
            request.params.id,
            request.body,
            key(request)
          ),
        2 * 1024 * 1024 + 4096
      )
      get('/operations/:id', read, (request) =>
        repository.integrationOperation(auth(request), request.params.id)
      )
      get('/receipts/:action/:key', read, async (request) => {
        const action = Object.hasOwn(apiActions, request.params.action)
          ? apiActions[request.params.action]
          : null
        if (!action) throw new ManagedError('NOT_FOUND')
        const receiptAuth = { ...auth(request), requiredScopes: action.scopes }
        return repository.integrationReceipt(receiptAuth, action.scope, request.params.key)
      })
    },
    { prefix: '/api/v1' }
  )
}
