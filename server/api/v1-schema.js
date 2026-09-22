const text = { type: 'string' }
const uuid = { type: 'string', format: 'uuid' }
const integer = { type: 'integer' }
const version = { type: 'integer', minimum: 1 }
const nullable = (schema) => ({ anyOf: [schema, { type: 'null' }] })
const object = (properties, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const ref = (name) => ({ $ref: `#/components/schemas/${name}` })
const list = (items) => ({ type: 'array', items })
const selection = {
  ...list(object({ id: uuid, expectedVersion: version })),
  minItems: 1,
  maxItems: 200,
}
const descriptor = {
  type: 'object',
  required: ['manifest', 'transportUrl'],
  properties: {
    manifest: {
      type: 'object',
      required: ['id', 'version', 'name', 'resources', 'types'],
      additionalProperties: true,
    },
    transportUrl: { type: 'string', format: 'uri' },
  },
  additionalProperties: true,
}
const addons = { ...list(descriptor), maxItems: 200 }
const groupDraft = {
  name: { type: 'string', minLength: 1, maxLength: 120 },
  addons,
  safeMode: nullable({ type: 'boolean' }),
}
const term = {
  mode: { const: 'term' },
  local: { type: 'string', examples: ['2027-01-15T18:00'] },
  timezone: { type: 'string', examples: ['America/New_York'] },
  offset: {
    type: 'number',
    description: 'UTC offset in minutes; supply to disambiguate a repeated local time.',
  },
}
const membership = {
  oneOf: [object({ mode: { const: 'lifetime' } }), object(term, ['mode', 'local'])],
}
const schemas = {
  Account: {
    ...object({
      id: uuid,
      email: { type: 'string', format: 'email' },
      name: text,
      state: { enum: ['staged', 'active', 'offboarding'] },
      groupId: nullable(uuid),
      setupSaved: { type: 'boolean' },
      membershipType: { enum: ['unset', 'term', 'lifetime'] },
      version,
      policyVersion: version,
      expiry: nullable(
        object({ at: integer, local: text, offset: { type: 'number' }, timezone: text })
      ),
      expired: { type: 'boolean' },
      suspendedAt: nullable(integer),
      safeMode: nullable({ type: 'boolean' }),
      appliedVersion: nullable(version),
      appliedTarget: nullable({ enum: ['active', 'suspended', 'offboard'] }),
      verifiedAt: nullable(integer),
      createdAt: integer,
      updatedAt: integer,
    }),
    additionalProperties: true,
  },
  AccountResult: object({
    account: ref('Account'),
    jobId: nullable(uuid),
    replayed: { type: 'boolean' },
  }),
  CreateAccount: object(
    {
      externalRef: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' },
      email: { type: 'string', format: 'email', maxLength: 254 },
      password: { type: 'string', minLength: 1, maxLength: 4096, writeOnly: true },
      name: { type: 'string', minLength: 1, maxLength: 120 },
    },
    ['externalRef', 'email', 'password']
  ),
  LinkAccount: object({
    externalRef: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,128}$' },
    accountId: uuid,
  }),
  Version: object({ expectedVersion: version }),
  Membership: {
    oneOf: [
      object({ expectedVersion: version, mode: { const: 'lifetime' } }),
      object({ expectedVersion: version, ...term }, ['expectedVersion', 'mode', 'local']),
    ],
  },
  BulkMembership: object({ accounts: selection, membership }),
  Assignment: object(
    { groupId: nullable(uuid), accounts: selection, useGroupAddons: { type: 'boolean' } },
    ['groupId', 'accounts']
  ),
  AccountAddons: object(
    {
      expectedVersion: version,
      groupVersion: nullable(version),
      addons,
      allowEmpty: { type: 'boolean', default: false },
    },
    ['expectedVersion', 'groupVersion', 'addons']
  ),
  ActivationPreview: object({ expectedVersion: version, safeMode: nullable({ type: 'boolean' }) }),
  Activation: object(
    {
      expectedVersion: version,
      receipt: { type: 'string', minLength: 1, maxLength: 32768 },
      allowEmpty: { type: 'boolean', default: false },
    },
    ['expectedVersion', 'receipt']
  ),
  Group: object(groupDraft, ['name']),
  GroupPublication: object(
    { expectedVersion: version, ...groupDraft, allowEmpty: { type: 'boolean', default: false } },
    ['expectedVersion', 'name', 'addons', 'safeMode']
  ),
  Operation: object({
    id: uuid,
    accountId: uuid,
    policyVersion: version,
    target: { enum: ['active', 'suspended', 'offboard'] },
    state: { enum: ['pending', 'running', 'retrying', 'verified', 'failed', 'superseded'] },
    errorCode: nullable(text),
    updatedAt: integer,
  }),
  Error: object({ error: object({ code: text, message: text, requestId: text }) }),
}

export function apiDocument(applicationVersion, actions) {
  const paths = {}
  function add(
    method,
    path,
    summary,
    { action, scopes = ['read'], input, output = { type: 'object' }, pagination = false } = {}
  ) {
    const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
      name: match[1],
      in: 'path',
      required: true,
      schema: match[1] === 'id' ? uuid : text,
    }))
    if (action)
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}$' },
        description: `Durable receipt action: ${action}. Same key and intent replays; different content returns 409.`,
      })
    if (pagination)
      parameters.push(
        {
          name: 'limit',
          in: 'query',
          schema: { type: 'integer', minimum: 1, maximum: 200, default: 100 },
        },
        { name: 'after', in: 'query', schema: uuid }
      )
    paths[path] ??= {}
    paths[path][method] = {
      operationId: `${method}_${path.replace(/[^A-Za-z0-9]/g, '_')}`,
      summary,
      parameters,
      'x-required-scopes': action ? actions[action].scopes : scopes,
      ...(input
        ? { requestBody: { required: true, content: { 'application/json': { schema: input } } } }
        : {}),
      responses: {
        200: {
          description:
            'Saved or read successfully. A non-null jobId means provider work must be polled; this is not proof of sync completion.',
          content: { 'application/json': { schema: output } },
        },
        default: {
          description:
            'Sanitized error; 401 invalid/expired/revoked key, 403 missing scope, 409 conflicting state/request, 429 rate limit. An interrupted or 5xx mutation has an uncertain outcome: recover its receipt or retry the same key.',
          headers: { 'Retry-After': { schema: text } },
          content: { 'application/json': { schema: ref('Error') } },
        },
      },
    }
  }
  add('get', '/me', 'Instance, owner, API key scopes and supported capabilities')
  add('get', '/openapi.json', 'Download this OpenAPI document')
  add('get', '/status', 'Sync and application backup status')
  add('get', '/accounts', 'List managed accounts without passwords or addon URLs', {
    pagination: true,
    output: object({ accounts: list(ref('Account')), nextCursor: nullable(uuid) }),
  })
  paths['/accounts'].get.parameters.push({
    name: 'view',
    in: 'query',
    schema: { enum: ['all', 'expired'], default: 'all' },
  })
  add(
    'post',
    '/accounts',
    'Stage an existing Stremio login; does not register a Stremio account or activate sync',
    { action: 'create', input: ref('CreateAccount') }
  )
  add('get', '/accounts/{id}', 'Read account', { output: ref('Account') })
  add(
    'get',
    '/accounts/{id}/execution',
    'Read current account and latest job, or a removal tombstone'
  )
  add('get', '/accounts/{id}/credentials', 'Retrieve saved device login without rotation', {
    scopes: ['read', 'credentials:read'],
    output: object({ accountId: uuid, email: text, password: text }),
  })
  add('get', '/accounts/{id}/addons', 'Read saved addon configuration; URLs may contain secrets', {
    scopes: ['read', 'configuration:read'],
  })
  add(
    'get',
    '/account-references/{ref}',
    'Exact external-reference lookup, including removed-account reservations'
  )
  add(
    'post',
    '/account-references',
    'Explicitly link an existing account to an external reference',
    { action: 'link', input: ref('LinkAccount') }
  )
  add('post', '/accounts/{id}/name', 'Rename account', {
    action: 'name',
    input: object({
      expectedVersion: version,
      name: { type: 'string', minLength: 1, maxLength: 120 },
    }),
    output: ref('AccountResult'),
  })
  add(
    'post',
    '/accounts/{id}/membership',
    'Set dated or lifetime membership; a past cutoff expires the account',
    { action: 'membership', input: ref('Membership'), output: ref('AccountResult') }
  )
  add('post', '/accounts/bulk-membership', 'Set membership for a versioned account selection', {
    action: 'bulk-membership',
    input: ref('BulkMembership'),
  })
  add('post', '/accounts/assign-group', 'Assign or detach selected accounts', {
    action: 'assign-group',
    input: ref('Assignment'),
  })
  add('post', '/accounts/{id}/addons', 'Save individual addon configuration', {
    action: 'addons',
    input: ref('AccountAddons'),
  })
  add('post', '/accounts/{id}/sync', 'Queue sync for an activated account', {
    action: 'sync',
    input: ref('Version'),
    output: ref('AccountResult'),
  })
  add('post', '/accounts/bulk-sync', 'Queue sync for selected activated accounts', {
    action: 'bulk-sync',
    input: object({ accounts: selection }),
  })
  add('post', '/accounts/{id}/activation-preview', 'Read-only first-sync review against Stremio', {
    scopes: ['read', 'sync:write'],
    input: ref('ActivationPreview'),
  })
  add('post', '/accounts/{id}/activate', 'Accept first-sync review and queue activation', {
    action: 'activate',
    input: ref('Activation'),
    output: ref('AccountResult'),
  })
  add(
    'post',
    '/accounts/{id}/reconnect',
    'Verify and save a replacement password for the same provider identity',
    {
      action: 'reconnect',
      input: object({
        expectedVersion: version,
        password: { type: 'string', minLength: 1, maxLength: 4096, writeOnly: true },
      }),
      output: ref('AccountResult'),
    }
  )
  add(
    'post',
    '/accounts/{id}/offboard',
    'Clear provider addons, verify, then remove the local account',
    { action: 'offboard', input: ref('Version'), output: ref('AccountResult') }
  )
  add('get', '/groups', 'List group summaries', { pagination: true })
  add('get', '/groups/{id}', 'Read complete group draft and published configuration', {
    scopes: ['read', 'configuration:read'],
  })
  add('get', '/groups/{id}/deployment', 'Read rollout progress for a group')
  add('post', '/groups', 'Create group draft', { action: 'create-group', input: ref('Group') })
  add('post', '/groups/{id}/publish', 'Validate and publish edits, then queue eligible members', {
    action: 'publish-group',
    input: ref('GroupPublication'),
  })
  add('get', '/operations/{id}', 'Read a durable provider job, including offboarding history', {
    output: ref('Operation'),
  })
  add(
    'get',
    '/receipts/{action}/{key}',
    'Recover a committed response; requires the original action scopes'
  )
  paths['/receipts/{action}/{key}'].get.parameters[0].schema = { enum: Object.keys(actions) }
  const groupFields = {
    id: uuid,
    name: text,
    version,
    publishedRevision: nullable(version),
    archived: { type: 'boolean' },
    safeMode: nullable({ type: 'boolean' }),
    effectiveSafeMode: { type: 'boolean' },
    addonCount: integer,
    createdAt: integer,
    updatedAt: integer,
  }
  const jobStates = ['pending', 'running', 'retrying', 'verified', 'failed', 'superseded']
  const keySchema = object({
    id: uuid,
    name: text,
    scopes: list(text),
    createdAt: integer,
    expiresAt: integer,
    revokedAt: nullable(integer),
    lastUsedAt: nullable(integer),
  })
  const extendedSchemas = {
    ...schemas,
    GroupSummary: object(groupFields),
    GroupRecord: object({ ...groupFields, draft: addons }),
    GroupResult: object({ group: ref('GroupRecord'), replayed: { type: 'boolean' } }),
    ReferenceResult: object({
      account: nullable(ref('Account')),
      accountId: uuid,
      externalRef: text,
      removed: { type: 'boolean' },
    }),
    LinkedAccount: object({
      account: ref('Account'),
      externalRef: text,
      jobId: nullable(uuid),
      replayed: { type: 'boolean' },
    }),
    BulkResult: object({
      accounts: list(object({ account: ref('Account'), jobId: nullable(uuid) })),
      replayed: { type: 'boolean' },
    }),
    Execution: object({
      account: nullable(ref('Account')),
      removedAt: nullable(integer),
      job: nullable(
        object({
          id: uuid,
          state: { enum: jobStates },
          target: { enum: ['active', 'suspended', 'offboard'] },
          attempts: integer,
          errorCode: nullable(text),
          dueAt: integer,
          updatedAt: integer,
        })
      ),
    }),
    FirstSyncReview: object({
      accountId: uuid,
      version,
      safeMode: { type: 'boolean' },
      target: { enum: ['active', 'suspended'] },
      beforeCount: integer,
      afterCount: integer,
      addons: list(object({ name: text, id: text })),
      receipt: text,
      expiresAt: integer,
    }),
    PublicationResult: object({
      group: ref('GroupRecord'),
      deploymentId: uuid,
      revision: version,
      queued: integer,
      unchanged: { type: 'boolean' },
      replayed: { type: 'boolean' },
    }),
    Deployment: object({
      id: uuid,
      groupId: uuid,
      revision: version,
      createdAt: integer,
      counts: object(Object.fromEntries(jobStates.map((state) => [state, integer]))),
      skipped: object({ staged: integer, offboarding: integer }),
      members: list(
        object({
          accountId: uuid,
          jobId: uuid,
          policyVersion: version,
          target: { enum: ['active', 'suspended'] },
          status: { enum: jobStates },
          errorCode: nullable(text),
        })
      ),
    }),
    Connection: object({
      apiVersion: text,
      applicationVersion: text,
      instanceId: text,
      ownerId: text,
      key: keySchema,
      capabilities: { type: 'object', additionalProperties: { type: 'boolean' } },
    }),
    Status: object({
      capabilities: { type: 'object', additionalProperties: { type: 'boolean' } },
      writePaused: { type: 'boolean' },
      ownerWritePaused: { type: 'boolean' },
      writerReady: { type: 'boolean' },
      lastScanAt: nullable(integer),
      lastBackupAt: nullable(integer),
      safeMode: { type: 'boolean' },
      version: nullable(version),
      accounts: object({ staged: integer, active: integer, offboarding: integer }),
    }),
  }
  const outputs = [
    ['get', '/me', ref('Connection')],
    ['get', '/status', ref('Status')],
    ['post', '/accounts', ref('LinkedAccount')],
    ['post', '/account-references', ref('LinkedAccount')],
    ['get', '/account-references/{ref}', ref('ReferenceResult')],
    ['get', '/accounts/{id}/execution', ref('Execution')],
    ['post', '/accounts/{id}/activation-preview', ref('FirstSyncReview')],
    ['post', '/accounts/bulk-membership', ref('BulkResult')],
    ['post', '/accounts/bulk-sync', ref('BulkResult')],
    ['post', '/accounts/assign-group', ref('BulkResult')],
    ['get', '/groups', object({ groups: list(ref('GroupSummary')), nextCursor: nullable(uuid) })],
    ['get', '/groups/{id}', ref('GroupRecord')],
    ['post', '/groups', ref('GroupResult')],
    ['post', '/groups/{id}/publish', ref('PublicationResult')],
    ['get', '/groups/{id}/deployment', object({ deployment: nullable(ref('Deployment')) })],
  ]
  for (const [method, path, schema] of outputs)
    paths[path][method].responses['200'].content['application/json'].schema = schema
  return {
    openapi: '3.1.1',
    info: {
      title: 'AIOManager integration API',
      version: '1.0.0',
      description: `Application ${applicationVersion}. All timestamps are Unix milliseconds; membership also includes local wall time and IANA timezone. HTTPS is required for remote use. No billing or IPTV operations. Persist each mutation intent/key before sending. Poll jobs until verified; failed is not proof of no external effect.`,
    },
    servers: [{ url: '/api/v1' }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'AIOManager API key' },
      },
      schemas: extendedSchemas,
    },
    paths,
  }
}
