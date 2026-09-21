import { MAX_CREDENTIAL_IMPORT_BYTES } from '../../shared/credential-import.js'
import { MAX_ADDON_CONFIG_BYTES } from '../../shared/addon-config.js'
import { ManagedError } from './errors.js'
import { parseImportBody } from './repository.js'
import { z } from 'zod'
import { ProviderFailure } from './worker.js'

const manifestInput = z.strictObject({ url: z.string().min(1).max(65_536) })

async function cancelReadOnDisconnect(request, reply, work) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const closed = () => {
    if (!reply.raw.writableFinished) abort()
  }
  request.raw.once('aborted', abort)
  reply.raw.once('close', closed)
  try {
    if (request.raw.aborted) abort()
    return await work(controller.signal)
  } finally {
    request.raw.removeListener('aborted', abort)
    reply.raw.removeListener('close', closed)
  }
}

/** Encapsulation keeps strict managed error handling separate from legacy APIs. */
export async function registerManagedRoutes(app, repository, manifestService) {
  await app.register(
    async (routes) => {
      routes.decorateRequest('managedAuth', null)
      routes.addHook('onRequest', async (request, reply) => {
        reply.header('Cache-Control', 'no-store')
        reply.header('Pragma', 'no-cache')
        const auth = {
          owner: request.headers['x-manager-id'],
          token: request.headers['x-sync-password'],
        }
        await repository.authorize(auth)
        request.managedAuth = auth
      })
      routes.setErrorHandler((error, request, reply) => {
        if (error instanceof ProviderFailure)
          error = new ManagedError(
            error.code === 'INVALID_CREDENTIALS' ? 'INVALID_CREDENTIALS' : 'PROVIDER_FAILURE'
          )
        if (error instanceof ManagedError) {
          return reply
            .code(error.statusCode)
            .send({ error: { code: error.code, message: error.message } })
        }
        if (error.statusCode >= 400 && error.statusCode < 500) {
          const oversized = error.statusCode === 413
          const importLimit = request.routeOptions.bodyLimit === MAX_CREDENTIAL_IMPORT_BYTES
          return reply.code(oversized ? 413 : 400).send({
            error: {
              code: oversized
                ? importLimit
                  ? 'FILE_TOO_LARGE'
                  : 'REQUEST_TOO_LARGE'
                : 'INVALID_INPUT',
              message: oversized
                ? importLimit
                  ? 'Export exceeds the 10 MiB import limit.'
                  : 'The managed request exceeds its size limit.'
                : 'The managed request is invalid.',
            },
          })
        }
        request.log.error(
          { category: 'Managed', requestId: request.id },
          'Managed operation failed'
        )
        return reply.code(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'The operation could not be completed. No success has been recorded.',
          },
        })
      })
      routes.get('/status', (request) => repository.status(request.managedAuth))
      routes.post('/accounts/connect', { bodyLimit: 1024 * 1024 }, (request) =>
        repository.connectAccounts(request.managedAuth, request.body)
      )
      routes.post('/settings', { bodyLimit: 4096 }, (request) =>
        repository.setSettings(
          request.managedAuth,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.post('/accounts/:id/activation-preview', { bodyLimit: 4096 }, (request) =>
        repository.previewActivation(request.managedAuth, request.params.id, request.body)
      )
      routes.post('/accounts/:id/activate', { bodyLimit: 36 * 1024 }, (request) =>
        repository.activateAccount(
          request.managedAuth,
          request.params.id,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.get('/accounts/:id/execution', (request) =>
        repository.accountExecution(request.managedAuth, request.params.id)
      )
      routes.post('/accounts/:id/reconnect', { bodyLimit: 32 * 1024 }, (request) =>
        repository.reconnectAccount(
          request.managedAuth,
          request.params.id,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.post('/accounts/:id/sync', { bodyLimit: 4096 }, (request) =>
        repository.requestSync(
          request.managedAuth,
          request.params.id,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.post('/accounts/:id/offboard', { bodyLimit: 4096 }, (request) =>
        repository.requestSync(
          request.managedAuth,
          request.params.id,
          request.body,
          request.headers['idempotency-key'],
          true
        )
      )
      routes.post('/manifests/resolve', { bodyLimit: 65 * 1024 }, (request, reply) => {
        const parsed = manifestInput.safeParse(request.body)
        if (!parsed.success) throw new ManagedError('INVALID_INPUT')
        return cancelReadOnDisconnect(request, reply, async (signal) => ({
          manifest: await manifestService.fetchManifest(parsed.data.url, { signal }),
        }))
      })
      routes.get('/groups', (request) =>
        repository.listGroups(request.managedAuth, {
          ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
          ...(request.query.after === undefined ? {} : { after: request.query.after }),
        })
      )
      routes.get('/groups/:id', (request) =>
        repository.getGroup(request.managedAuth, request.params.id)
      )
      routes.get('/groups/:id/deployment', (request) =>
        repository.getGroupDeployment(request.managedAuth, request.params.id)
      )
      routes.post('/groups', { bodyLimit: MAX_ADDON_CONFIG_BYTES + 4096 }, (request) =>
        repository.createGroup(
          request.managedAuth,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.post('/groups/:id/draft', { bodyLimit: MAX_ADDON_CONFIG_BYTES + 4096 }, (request) =>
        repository.saveGroupDraft(
          request.managedAuth,
          request.params.id,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.post('/groups/:id/preview', { bodyLimit: 4096 }, (request, reply) =>
        cancelReadOnDisconnect(request, reply, (signal) =>
          repository.previewGroupPublication(request.managedAuth, request.params.id, request.body, {
            signal,
          })
        )
      )
      routes.post('/groups/:id/publish', { bodyLimit: 12 * 1024 }, async (request, reply) => {
        const result = await repository.publishGroup(
          request.managedAuth,
          request.params.id,
          request.body,
          request.headers['idempotency-key']
        )
        return reply.code(result.replayed || result.unchanged ? 200 : 201).send(result)
      })
      routes.get('/deployments/:id', (request) =>
        repository.getDeployment(request.managedAuth, request.params.id)
      )
      routes.post('/accounts/assign-group', { bodyLimit: 64 * 1024 }, (request) =>
        repository.assignGroup(
          request.managedAuth,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.get('/accounts/:id/personal-addons', (request) =>
        repository.getPersonalAddons(request.managedAuth, request.params.id)
      )
      routes.post(
        '/accounts/:id/personal-addons',
        { bodyLimit: MAX_ADDON_CONFIG_BYTES + 4096 },
        (request) =>
          repository.setPersonalAddons(
            request.managedAuth,
            request.params.id,
            request.body,
            request.headers['idempotency-key']
          )
      )
      routes.get('/accounts', (request) =>
        repository.listAccounts(request.managedAuth, {
          ...(request.query.view === undefined ? {} : { view: request.query.view }),
          ...(request.query.limit === undefined ? {} : { limit: Number(request.query.limit) }),
          ...(request.query.after === undefined ? {} : { after: request.query.after }),
        })
      )
      routes.get('/accounts/:id', (request) =>
        repository.getAccount(request.managedAuth, request.params.id)
      )
      routes.get('/imports/:id', (request) =>
        repository.getBatch(request.managedAuth, request.params.id)
      )
      routes.post('/accounts/:id/membership', { bodyLimit: 4096 }, (request) =>
        repository.setMembership(
          request.managedAuth,
          request.params.id,
          request.body,
          request.headers['idempotency-key']
        )
      )
      routes.post(
        '/imports/preview',
        { bodyLimit: MAX_CREDENTIAL_IMPORT_BYTES },
        async (request, reply) => {
          const parsed = parseImportBody(request.body)
          if (!parsed.ok) return reply.code(422).send({ error: parsed.error })
          return repository.previewImport(request.managedAuth, parsed)
        }
      )
      routes.post(
        '/imports',
        { bodyLimit: MAX_CREDENTIAL_IMPORT_BYTES },
        async (request, reply) => {
          const parsed = parseImportBody(request.body)
          if (!parsed.ok) return reply.code(422).send({ error: parsed.error })
          const result = await repository.stageImport(
            request.managedAuth,
            parsed,
            request.headers['idempotency-key']
          )
          return reply.code(result.replayed ? 200 : 201).send(result)
        }
      )
    },
    { prefix: '/api/managed' }
  )
}
