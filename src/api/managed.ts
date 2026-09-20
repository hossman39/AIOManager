import { z } from 'zod'
import { deriveSyncToken } from '@/lib/crypto'
import type { CredentialUpload } from '@/lib/managed/prepare-import'
import { parseAddonConfiguration, type ManagedAddon } from '../../shared/addon-config.js'

const issueSchema = z.object({
  row: z.number().int().positive(),
  code: z.enum([
    'INVALID_RECORD',
    'INVALID_EMAIL',
    'MISSING_PASSWORD',
    'INVALID_PASSWORD',
    'DUPLICATE_ROW',
    'CONFLICTING_PASSWORD',
    'EXISTING_PASSWORD_CONFLICT',
  ]),
  message: z.string(),
})
const candidateSchema = z.object({
  id: z.uuid().optional(),
  email: z.email(),
  name: z.string(),
  sourceRows: z.array(z.number().int().positive()),
  status: z.enum(['ready', 'existing', 'conflict', 'staged']),
})
const previewSchema = z.object({
  sourceFormat: z.enum(['aiomanager-2.0.0', 'legacy-account-list']),
  totalRows: z.number().int().nonnegative(),
  accounts: z.array(candidateSchema),
  issues: z.array(issueSchema),
})
const batchSchema = previewSchema.extend({
  batchId: z.uuid(),
  createdAt: z.number().int(),
  candidateAccounts: z.number().int().nonnegative(),
  created: z.number().int().nonnegative(),
  existing: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  replayed: z.boolean(),
})
const accountSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    name: z.string(),
    state: z.enum(['staged', 'active', 'offboarding']),
    groupId: z.string().nullable(),
    membershipType: z.enum(['unset', 'term', 'lifetime']),
    version: z.number().int().positive(),
    policyVersion: z.number().int().positive(),
    expiry: z
      .object({
        at: z.number().int(),
        local: z.string(),
        offset: z.number().int(),
        timezone: z.literal('America/New_York'),
      })
      .nullable(),
    safeMode: z.boolean().nullable(),
    suspendedAt: z.number().int().nonnegative().nullable().default(null),
    appliedVersion: z.number().int().nullable(),
    appliedTarget: z.enum(['active', 'suspended', 'offboard']).nullable(),
    verifiedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .refine((account) => (account.membershipType === 'term') === (account.expiry !== null))
const accountsSchema = z.object({
  accounts: z.array(accountSchema),
  nextCursor: z.uuid().nullable(),
})
const membershipResultSchema = z.object({
  account: accountSchema,
  jobId: z.uuid().nullable(),
  replayed: z.boolean(),
})
const statusSchema = z.object({
  capabilities: z.object({
    passiveImport: z.boolean(),
    providerWrites: z.boolean(),
    groupPublication: z.boolean().default(false),
  }),
  writePaused: z.boolean(),
  ownerWritePaused: z.boolean(),
  safeMode: z.boolean(),
  version: z.number().int().nullable(),
  accounts: z.object({
    staged: z.number().int(),
    active: z.number().int(),
    offboarding: z.number().int(),
  }),
})

const addonsSchema = z.unknown().transform((value, ctx) => {
  const parsed = parseAddonConfiguration(value)
  if (!parsed.ok) {
    ctx.addIssue({ code: 'custom', message: 'Invalid managed addon configuration' })
    return z.NEVER
  }
  return parsed.addons
})
const groupSummarySchema = z.object({
  id: z.uuid(),
  name: z.string().min(1).max(120),
  version: z.number().int().positive(),
  publishedRevision: z.number().int().positive().nullable(),
  archived: z.boolean(),
  safeMode: z.boolean().nullable(),
  effectiveSafeMode: z.boolean(),
  addonCount: z.number().int().min(0).max(200),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
const groupSchema = groupSummarySchema
  .extend({ draft: addonsSchema })
  .refine((group) => group.draft.length === group.addonCount)
const groupResultSchema = z.object({ group: groupSchema, replayed: z.boolean() })
const groupsSchema = z.object({
  groups: z.array(groupSummarySchema).max(200),
  nextCursor: z.uuid().nullable(),
})
const personalSchema = z.object({ account: accountSchema, addons: addonsSchema })
const personalResultSchema = personalSchema.extend({
  jobId: z.uuid().nullable(),
  replayed: z.boolean(),
})
const assignmentResultSchema = z.object({
  accounts: z.array(z.object({ account: accountSchema, jobId: z.uuid().nullable() })).max(200),
  replayed: z.boolean(),
})
const cohortCount = z.number().int().min(0).max(1000)
const publicationPreviewSchema = z
  .object({
    groupId: z.uuid(),
    version: z.number().int().positive(),
    publishedRevision: z.number().int().positive().nullable(),
    counts: z.object({
      active: cohortCount,
      suspended: cohortCount,
      staged: cohortCount,
      offboarding: cohortCount,
    }),
    changes: z.object({
      added: z.number().int().min(0).max(200),
      removed: z.number().int().min(0).max(200),
      changed: z.number().int().min(0).max(200),
      reordered: z.boolean(),
    }),
    empty: z.boolean(),
    unchanged: z.boolean(),
    expiresAt: z.number().int(),
    receipt: z.string().min(1).max(8192),
  })
  .refine(
    (preview) => Object.values(preview.counts).reduce((total, count) => total + count, 0) <= 1000
  )
const publicationResultSchema = z
  .object({
    group: groupSchema,
    deploymentId: z.uuid(),
    revision: z.number().int().positive(),
    queued: cohortCount,
    unchanged: z.boolean(),
    replayed: z.boolean(),
  })
  .refine(
    (result) =>
      result.group.publishedRevision === result.revision &&
      (!result.unchanged || result.queued === 0)
  )
const deploymentSchema = z
  .object({
    id: z.uuid(),
    groupId: z.uuid(),
    revision: z.number().int().positive(),
    createdAt: z.number().int(),
    counts: z.object({
      pending: cohortCount,
      running: cohortCount,
      retrying: cohortCount,
      verified: cohortCount,
      failed: cohortCount,
      superseded: cohortCount,
    }),
    skipped: z.object({ staged: cohortCount, offboarding: cohortCount }),
    members: z
      .array(
        z.object({
          accountId: z.uuid(),
          jobId: z.uuid(),
          policyVersion: z.number().int().positive(),
          target: z.enum(['active', 'suspended']),
          status: z.enum(['pending', 'running', 'retrying', 'verified', 'failed', 'superseded']),
          errorCode: z
            .enum([
              'LEASE_EXPIRED',
              'NETWORK_ERROR',
              'RATE_LIMITED',
              'PROVIDER_UNAVAILABLE',
              'OUTCOME_UNKNOWN',
              'INVALID_CREDENTIALS',
              'VERIFICATION_MISMATCH',
              'MANIFEST_UNAVAILABLE',
              'DATA_UNREADABLE',
            ])
            .nullable(),
        })
      )
      .max(1000),
  })
  .refine(
    (deployment) =>
      new Set(deployment.members.map((member) => member.jobId)).size ===
        deployment.members.length &&
      Object.entries(deployment.counts).every(
        ([status, count]) =>
          deployment.members.filter((member) => member.status === status).length === count
      )
  )
const manifestResultSchema = z.object({ manifest: z.unknown() }).transform((value, ctx) => {
  const parsed = parseAddonConfiguration([
    { transportUrl: 'https://validation.invalid/manifest.json', manifest: value.manifest },
  ])
  if (!parsed.ok) {
    ctx.addIssue({ code: 'custom', message: 'Invalid managed manifest response' })
    return z.NEVER
  }
  return { manifest: parsed.addons[0].manifest }
})

export type ManagedImportPreview = z.infer<typeof previewSchema>
export type ManagedImportBatch = z.infer<typeof batchSchema>
export type ManagedAccount = z.infer<typeof accountSchema>
export type ManagedStatus = z.infer<typeof statusSchema>
export type ManagedGroup = z.infer<typeof groupSchema>
export type ManagedGroupSummary = z.infer<typeof groupSummarySchema>
export type ManagedPublicationPreview = z.infer<typeof publicationPreviewSchema>
export type ManagedDeployment = z.infer<typeof deploymentSchema>
export type ManagedGroupDraft = { name: string; addons: ManagedAddon[]; safeMode: boolean | null }
export type ManagedPublication = { expectedVersion: number; receipt: string; allowEmpty: boolean }
export type MembershipChange =
  | { mode: 'lifetime'; expectedVersion: number }
  | { mode: 'term'; expectedVersion: number; local: string; offset?: number }

const errorMessages = {
  UNAUTHORIZED: 'Your manager session could not be verified. Sign in again.',
  NOT_FOUND: 'This managed record was not found.',
  INVALID_INPUT: 'The request could not be accepted. Check the selected file or values.',
  IDEMPOTENCY_KEY_REQUIRED:
    'The request is missing its retry identifier. Reload before trying again.',
  IDEMPOTENCY_CONFLICT:
    'This retry identifier was used for a different change. Reload the saved values.',
  VERSION_CONFLICT: 'The record changed. Refresh it before trying again.',
  INVALID_STATE: 'This account cannot be changed in its current management state.',
  INVALID_ADDON_CONFIG: 'Provide a complete, valid addon configuration.',
  ADDON_CONFIG_TOO_LARGE: 'An addon list exceeds 200 entries or 2 MiB.',
  DUPLICATE_ADDON_URL: 'An addon URL appears more than once. Keep only the intended entry.',
  ADDON_LAYER_CONFLICT:
    'An addon URL appears in both the group and personal setup. Resolve the duplicate explicitly.',
  GROUP_NOT_PUBLISHED: 'Publish the destination group before assigning active users.',
  GROUP_TOO_LARGE: 'This publication exceeds the 1,000-member limit.',
  PUBLICATION_UNAVAILABLE: 'Group publication is not available on this backend.',
  PREVIEW_STALE: 'This preview expired or the group or its members changed. Prepare a new preview.',
  EMPTY_PUBLICATION_CONFIRMATION:
    'Confirm the intentionally empty or entirely disabled group setup before publishing.',
  MANIFEST_UNAVAILABLE:
    'A required manifest could not be reached or validated. No publication was saved.',
  MANIFEST_UNSAFE_URL:
    'Use a direct trusted manifest URL. Private services require an exact server-side origin allowance.',
  MANIFEST_INVALID: 'The manifest is incomplete, invalid, or larger than 2 MiB.',
  MANIFEST_CONFIGURATION_REQUIRED:
    'Configure the addon in its own app, then paste the configured manifest URL.',
  MANIFEST_ID_MISMATCH: 'The URL now serves a different addon. Review its saved configuration.',
  MANIFEST_TIMEOUT: 'Manifest validation timed out or was cancelled. Try the preview again.',
  MANIFEST_BUSY: 'Manifest validation is busy. Wait for the current checks to finish.',
  INVALID_EXPIRY: 'Choose a valid New York date and time.',
  NONEXISTENT_EXPIRY:
    'That New York time does not exist because the clocks move forward. Choose another time.',
  AMBIGUOUS_EXPIRY:
    'That New York time occurs twice. Choose the daylight or standard time occurrence.',
  DATA_UNREADABLE: 'The server cannot decrypt managed data. Restore its matching encryption key.',
  FILE_TOO_LARGE: 'The import file exceeds 10 MiB.',
  REQUEST_TOO_LARGE: 'The request exceeds the size limit for this operation.',
  UNSUPPORTED_VERSION: 'This export version is not supported.',
  UNSUPPORTED_FORMAT: 'Select an AIOManager Settings export or account list.',
  TOO_MANY_ACCOUNTS: 'The export exceeds 10,000 account rows.',
  INVALID_RESPONSE:
    'The server returned an unexpected response. Check that the fork backend is running.',
  NETWORK_ERROR:
    'The server could not be reached. A submitted change may already be saved; retry the same request to confirm.',
  REQUEST_FAILED: 'The operation could not be completed. No success has been confirmed.',
  CANCELLED: 'The request was cancelled.',
  INVALID_SERVER: 'Check the configured sync server URL before importing credentials.',
} as const

export class ManagedApiError extends Error {
  constructor(public readonly code: keyof typeof errorMessages) {
    super(errorMessages[code])
    this.name = 'ManagedApiError'
  }
}

function apiBase(serverUrl: string) {
  const value = serverUrl.trim() || '/api'
  if (/\s|\\|[?#]/.test(value)) throw new ManagedApiError('INVALID_SERVER')
  if (value.startsWith('/') && !value.startsWith('//')) return value.replace(/\/+$/, '')
  try {
    const parsed = new URL(value)
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
      throw new Error()
    // The existing sync store saves an absolute server root and appends /api.
    // Also tolerate an explicit /api URL without appending it twice.
    const base = parsed.href.replace(/\/+$/, '')
    return parsed.pathname.replace(/\/+$/, '').endsWith('/api') ? base : `${base}/api`
  } catch {
    throw new ManagedApiError('INVALID_SERVER')
  }
}

export function createManagedApi({
  managerId,
  password,
  serverUrl = '',
  fetch: transport = globalThis.fetch,
}: {
  managerId: string
  password: string
  serverUrl?: string
  fetch?: typeof fetch
}) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: { body?: unknown; key?: string; signal?: AbortSignal } = {}
  ): Promise<T> {
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(abort, 30_000)
    try {
      if (!managerId || !password) throw new ManagedApiError('UNAUTHORIZED')
      if (options.signal?.aborted) throw new ManagedApiError('CANCELLED')
      const base = apiBase(serverUrl)
      const token = await deriveSyncToken(password)
      if (controller.signal.aborted)
        throw new ManagedApiError(options.signal?.aborted ? 'CANCELLED' : 'NETWORK_ERROR')
      const response = await transport(`${base}/managed${path}`, {
        method: options.body === undefined ? 'GET' : 'POST',
        headers: {
          'x-manager-id': managerId,
          'x-sync-password': token,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.key ? { 'idempotency-key': options.key } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
      })
      let data: unknown
      try {
        data = await response.json()
      } catch {
        throw new ManagedApiError('INVALID_RESPONSE')
      }
      if (!response.ok) {
        const code = (data as { error?: { code?: unknown } } | null)?.error?.code
        const known =
          typeof code === 'string' && Object.prototype.hasOwnProperty.call(errorMessages, code)
        throw new ManagedApiError(known ? (code as keyof typeof errorMessages) : 'REQUEST_FAILED')
      }
      const parsed = schema.safeParse(data)
      if (!parsed.success) throw new ManagedApiError('INVALID_RESPONSE')
      return parsed.data
    } catch (error) {
      if (options.signal?.aborted) throw new ManagedApiError('CANCELLED')
      if (error instanceof ManagedApiError) throw error
      // Fetch/parse exceptions can contain URLs or data. Never surface their text.
      throw new ManagedApiError('NETWORK_ERROR')
    } finally {
      clearTimeout(timeout)
      options.signal?.removeEventListener('abort', abort)
    }
  }
  return {
    status: (signal?: AbortSignal) => request('/status', statusSchema, { signal }),
    accounts: (after = '', signal?: AbortSignal) =>
      request(
        `/accounts?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        accountsSchema,
        { signal }
      ),
    account: (id: string, signal?: AbortSignal) =>
      request(`/accounts/${encodeURIComponent(id)}`, accountSchema, { signal }),
    groups: (after = '', signal?: AbortSignal) =>
      request(
        `/groups?limit=100${after ? `&after=${encodeURIComponent(after)}` : ''}`,
        groupsSchema,
        { signal }
      ),
    group: (id: string, signal?: AbortSignal) =>
      request(`/groups/${encodeURIComponent(id)}`, groupSchema, { signal }),
    createGroup: (draft: ManagedGroupDraft, key: string, signal?: AbortSignal) =>
      request('/groups', groupResultSchema, { body: draft, key, signal }),
    saveGroupDraft: (
      id: string,
      draft: ManagedGroupDraft & { expectedVersion: number },
      key: string,
      signal?: AbortSignal
    ) =>
      request(`/groups/${encodeURIComponent(id)}/draft`, groupResultSchema, {
        body: draft,
        key,
        signal,
      }),
    personalAddons: (id: string, signal?: AbortSignal) =>
      request(`/accounts/${encodeURIComponent(id)}/personal-addons`, personalSchema, { signal }),
    setPersonalAddons: (
      id: string,
      body: { addons: ManagedAddon[]; expectedVersion: number },
      key: string,
      signal?: AbortSignal
    ) =>
      request(`/accounts/${encodeURIComponent(id)}/personal-addons`, personalResultSchema, {
        body,
        key,
        signal,
      }),
    assignGroup: (
      body: { groupId: string | null; accounts: { id: string; expectedVersion: number }[] },
      key: string,
      signal?: AbortSignal
    ) => request('/accounts/assign-group', assignmentResultSchema, { body, key, signal }),
    resolveManifest: (url: string, signal?: AbortSignal) =>
      request('/manifests/resolve', manifestResultSchema, { body: { url }, signal }),
    previewGroupPublication: (id: string, expectedVersion: number, signal?: AbortSignal) =>
      request(`/groups/${encodeURIComponent(id)}/preview`, publicationPreviewSchema, {
        body: { expectedVersion },
        signal,
      }),
    publishGroup: (id: string, body: ManagedPublication, key: string, signal?: AbortSignal) =>
      request(`/groups/${encodeURIComponent(id)}/publish`, publicationResultSchema, {
        body,
        key,
        signal,
      }),
    deployment: (id: string, signal?: AbortSignal) =>
      request(`/deployments/${encodeURIComponent(id)}`, deploymentSchema, { signal }),
    groupDeployment: async (id: string, signal?: AbortSignal) => {
      const result = await request(
        `/groups/${encodeURIComponent(id)}/deployment`,
        z.object({ deployment: deploymentSchema.nullable() }),
        { signal }
      )
      if (result.deployment && result.deployment.groupId !== id)
        throw new ManagedApiError('INVALID_RESPONSE')
      return result.deployment
    },
    setMembership: (id: string, change: MembershipChange, key: string, signal?: AbortSignal) =>
      request(`/accounts/${encodeURIComponent(id)}/membership`, membershipResultSchema, {
        body: change,
        key,
        signal,
      }),
    previewImport: (upload: CredentialUpload, signal?: AbortSignal) =>
      request('/imports/preview', previewSchema, { body: upload, signal }),
    stageImport: (upload: CredentialUpload, key: string, signal?: AbortSignal) =>
      request('/imports', batchSchema, { body: upload, key, signal }),
  }
}
