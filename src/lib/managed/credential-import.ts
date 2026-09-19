import { z } from 'zod'

// Accept only serialized exports, never arbitrary objects with executable getters.
export const MAX_CREDENTIAL_IMPORT_BYTES = 10 * 1024 * 1024
export const MAX_CREDENTIAL_IMPORT_ROWS = 10_000

export interface ImportedCredential {
  email: string
  password: string
  name: string
  sourceRows: number[]
}

const issueMessages = {
  INVALID_RECORD: 'Expected an account object.',
  INVALID_EMAIL: 'A valid email address is required.',
  MISSING_PASSWORD: 'No saved password. Supply it before activation.',
  INVALID_PASSWORD: 'Password must be a nonempty string.',
  DUPLICATE_ROW: 'Repeated email and password; one staged account is sufficient.',
  CONFLICTING_PASSWORD: 'Conflicting passwords for this email. Resolve before staging.',
} as const

export interface CredentialImportIssue {
  row: number
  code: keyof typeof issueMessages
  message: string
}

const errorMessages = {
  INVALID_INPUT: 'Expected a JSON export file.',
  FILE_TOO_LARGE: 'Export exceeds the 10 MiB import limit.',
  INVALID_JSON: 'Export is not valid JSON.',
  UNSUPPORTED_FORMAT: 'Expected an AIOManager account export or an account list.',
  UNSUPPORTED_VERSION: 'Export version is not supported. A reviewed adapter is required.',
  TOO_MANY_ACCOUNTS: 'Export exceeds the 10,000 account import limit.',
} as const

export type CredentialImportResult =
  | {
      ok: true
      sourceFormat: 'aiomanager-2.0.0' | 'legacy-account-list'
      totalRows: number
      accounts: ImportedCredential[]
      issues: CredentialImportIssue[]
    }
  | {
      ok: false
      error: { code: keyof typeof errorMessages; message: string }
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failure(code: keyof typeof errorMessages): CredentialImportResult {
  return { ok: false, error: { code, message: errorMessages[code] } }
}

const emailSchema = z.email()

/**
 * Passive email/password extraction. No storage, authentication, manifest fetch,
 * registration, or provider write. The caller must encrypt credentials before
 * staging and must never log this result: successful accounts contain passwords.
 * Issues contain only row numbers and fixed messages, never raw export values.
 */
export function parseCredentialImport(json: string): CredentialImportResult {
  if (typeof json !== 'string') return failure('INVALID_INPUT')
  if (
    json.length > MAX_CREDENTIAL_IMPORT_BYTES ||
    new TextEncoder().encode(json).byteLength > MAX_CREDENTIAL_IMPORT_BYTES
  ) {
    return failure('FILE_TOO_LARGE')
  }

  let data: unknown
  try {
    data = JSON.parse(json.replace(/^\uFEFF/, ''))
  } catch {
    // JSON.parse error messages can include credentials from the input.
    return failure('INVALID_JSON')
  }

  let rows: unknown[]
  let sourceFormat: 'aiomanager-2.0.0' | 'legacy-account-list' = 'legacy-account-list'
  if (Array.isArray(data)) {
    rows = data
  } else if (isRecord(data) && Array.isArray(data.accounts)) {
    if (Object.prototype.hasOwnProperty.call(data, 'version')) {
      if (data.version !== '2.0.0') return failure('UNSUPPORTED_VERSION')
      sourceFormat = 'aiomanager-2.0.0'
    }
    rows = data.accounts
  } else {
    return failure('UNSUPPORTED_FORMAT')
  }

  if (rows.length > MAX_CREDENTIAL_IMPORT_ROWS) return failure('TOO_MANY_ACCOUNTS')

  const issues: CredentialImportIssue[] = []
  const candidates = new Map<string, { account: ImportedCredential; conflict: boolean }>()
  const addIssue = (row: number, code: keyof typeof issueMessages) => {
    issues.push({ row, code, message: issueMessages[code] })
  }

  rows.forEach((value, index) => {
    const row = index + 1
    if (!isRecord(value)) {
      addIssue(row, 'INVALID_RECORD')
      return
    }
    const email = typeof value.email === 'string' ? value.email.trim() : ''
    if (!emailSchema.safeParse(email).success) {
      addIssue(row, 'INVALID_EMAIL')
      return
    }
    if (value.password === undefined || value.password === null || value.password === '') {
      addIssue(row, 'MISSING_PASSWORD')
      return
    }
    if (typeof value.password !== 'string') {
      addIssue(row, 'INVALID_PASSWORD')
      return
    }

    // Conservative duplicate detection only; this is not verified provider identity.
    // Preserve email case for login and preserve every password character.
    const key = email.toLowerCase()
    const existing = candidates.get(key)
    if (existing) {
      existing.account.sourceRows.push(row)
      existing.conflict ||= existing.account.password !== value.password
    } else {
      candidates.set(key, {
        account: { email, password: value.password, name: email, sourceRows: [row] },
        conflict: false,
      })
    }
  })

  const accounts: ImportedCredential[] = []
  for (const { account, conflict } of candidates.values()) {
    if (conflict) {
      account.sourceRows.forEach((row) => addIssue(row, 'CONFLICTING_PASSWORD'))
    } else {
      accounts.push(account)
      account.sourceRows.slice(1).forEach((row) => addIssue(row, 'DUPLICATE_ROW'))
    }
  }

  return {
    ok: true,
    sourceFormat,
    totalRows: rows.length,
    accounts,
    issues: issues.sort((a, b) => a.row - b.row),
  }
}
