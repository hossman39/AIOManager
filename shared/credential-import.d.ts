export const MAX_CREDENTIAL_IMPORT_BYTES: number
export const MAX_CREDENTIAL_IMPORT_ROWS: number

export interface ImportedCredential {
  email: string
  password: string
  name: string
  sourceRows: number[]
}
export interface CredentialImportIssue {
  row: number
  code:
    | 'INVALID_RECORD'
    | 'INVALID_EMAIL'
    | 'MISSING_PASSWORD'
    | 'INVALID_PASSWORD'
    | 'DUPLICATE_ROW'
    | 'CONFLICTING_PASSWORD'
  message: string
}
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
      error: {
        code:
          | 'INVALID_INPUT'
          | 'FILE_TOO_LARGE'
          | 'INVALID_JSON'
          | 'UNSUPPORTED_FORMAT'
          | 'UNSUPPORTED_VERSION'
          | 'TOO_MANY_ACCOUNTS'
        message: string
      }
    }
export function parseCredentialImport(json: string): CredentialImportResult
