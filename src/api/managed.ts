import { z } from 'zod'
import { deriveSyncToken } from '@/lib/crypto'
import type { CredentialUpload } from '@/lib/managed/prepare-import'

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
const accountSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  state: z.enum(['staged', 'active', 'offboarding']),
  groupId: z.string().nullable(),
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
  appliedVersion: z.number().int().nullable(),
  appliedTarget: z.enum(['active', 'suspended', 'offboard']).nullable(),
  verifiedAt: z.number().int().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
const accountsSchema = z.object({
  accounts: z.array(accountSchema),
  nextCursor: z.uuid().nullable(),
})
const statusSchema = z.object({
  capabilities: z.object({ passiveImport: z.boolean(), providerWrites: z.boolean() }),
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

export type ManagedImportPreview = z.infer<typeof previewSchema>
export type ManagedImportBatch = z.infer<typeof batchSchema>
export type ManagedAccount = z.infer<typeof accountSchema>
export type ManagedStatus = z.infer<typeof statusSchema>

const errorMessages = {
  UNAUTHORIZED: 'Your manager session could not be verified. Sign in again.',
  NOT_FOUND: 'This managed record was not found.',
  INVALID_INPUT: 'The request could not be accepted. Check the selected file or values.',
  IDEMPOTENCY_KEY_REQUIRED:
    'The import request is missing its retry identifier. Select the file again.',
  IDEMPOTENCY_CONFLICT:
    'This retry identifier was used for a different import. Select the file again.',
  VERSION_CONFLICT: 'The record changed. Refresh it before trying again.',
  DATA_UNREADABLE: 'The server cannot decrypt managed data. Restore its matching encryption key.',
  FILE_TOO_LARGE: 'The import file exceeds 10 MiB.',
  UNSUPPORTED_VERSION: 'This export version is not supported.',
  UNSUPPORTED_FORMAT: 'Select an AIOManager Settings export or account list.',
  TOO_MANY_ACCOUNTS: 'The export exceeds 10,000 account rows.',
  INVALID_RESPONSE:
    'The server returned an unexpected response. Check that the fork backend is running.',
  NETWORK_ERROR:
    'The server could not be reached. A submitted import may already be saved; retrying it is safe.',
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
    return parsed.href.replace(/\/+$/, '')
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
    previewImport: (upload: CredentialUpload, signal?: AbortSignal) =>
      request('/imports/preview', previewSchema, { body: upload, signal }),
    stageImport: (upload: CredentialUpload, key: string, signal?: AbortSignal) =>
      request('/imports', batchSchema, { body: upload, key, signal }),
  }
}
