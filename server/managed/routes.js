import { MAX_CREDENTIAL_IMPORT_BYTES } from '../../shared/credential-import.js'
import { ManagedError } from './errors.js'
import { parseImportBody } from './repository.js'

/** Encapsulation keeps strict managed error handling separate from legacy APIs. */
export async function registerManagedRoutes(app, repository) {
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
      routes.get('/accounts', (request) =>
        repository.listAccounts(request.managedAuth, {
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
