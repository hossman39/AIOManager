import { z } from 'zod'

// Both browser preview and server staging use this passive, allowlisted parser.
export const MAX_CREDENTIAL_IMPORT_BYTES = 10 * 1024 * 1024
export const MAX_CREDENTIAL_IMPORT_ROWS = 10_000

const issueMessages = {
  INVALID_RECORD: 'Expected an account object.',
  INVALID_EMAIL: 'A valid email address is required.',
  MISSING_PASSWORD: 'No saved password. Supply it before activation.',
  INVALID_PASSWORD: 'Password must be a nonempty string.',
  DUPLICATE_ROW: 'Repeated email and password; one staged account is sufficient.',
  CONFLICTING_PASSWORD: 'Conflicting passwords for this email. Resolve before staging.',
}
const errorMessages = {
  INVALID_INPUT: 'Expected a JSON export file.',
  FILE_TOO_LARGE: 'Export exceeds the 10 MiB import limit.',
  INVALID_JSON: 'Export is not valid JSON.',
  UNSUPPORTED_FORMAT: 'Expected an AIOManager account export or an account list.',
  UNSUPPORTED_VERSION: 'Export version is not supported. A reviewed adapter is required.',
  TOO_MANY_ACCOUNTS: 'Export exceeds the 10,000 account import limit.',
}
const emailSchema = z.email()
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const failure = (code) => ({ ok: false, error: { code, message: errorMessages[code] } })

/**
 * No storage, login, manifest fetch, registration, or provider writes. Successful
 * results contain passwords and must never be logged. Issues contain fixed text.
 */
export function parseCredentialImport(json) {
  if (typeof json !== 'string') return failure('INVALID_INPUT')
  if (
    json.length > MAX_CREDENTIAL_IMPORT_BYTES ||
    new TextEncoder().encode(json).byteLength > MAX_CREDENTIAL_IMPORT_BYTES
  )
    return failure('FILE_TOO_LARGE')

  let data
  try {
    data = JSON.parse(json.replace(/^\uFEFF/, ''))
  } catch {
    return failure('INVALID_JSON')
  }
  let rows
  let sourceFormat = 'legacy-account-list'
  if (Array.isArray(data)) rows = data
  else if (isRecord(data) && Array.isArray(data.accounts)) {
    if (Object.prototype.hasOwnProperty.call(data, 'version')) {
      if (data.version !== '2.0.0') return failure('UNSUPPORTED_VERSION')
      sourceFormat = 'aiomanager-2.0.0'
    }
    rows = data.accounts
  } else return failure('UNSUPPORTED_FORMAT')
  if (rows.length > MAX_CREDENTIAL_IMPORT_ROWS) return failure('TOO_MANY_ACCOUNTS')

  const issues = []
  const candidates = new Map()
  const addIssue = (row, code) => issues.push({ row, code, message: issueMessages[code] })
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
  const accounts = []
  for (const { account, conflict } of candidates.values()) {
    if (conflict) account.sourceRows.forEach((row) => addIssue(row, 'CONFLICTING_PASSWORD'))
    else {
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
