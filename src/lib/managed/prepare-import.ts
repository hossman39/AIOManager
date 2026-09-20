import { parseCredentialImport } from './credential-import'

export interface CredentialUpload {
  version?: '2.0.0'
  accounts: (null | { email: string | null; password?: string | null | number })[]
}

/** Remove all noncredential data before upload, preserving source rows/issues. */
export function prepareCredentialUpload(json: string) {
  const parsed = parseCredentialImport(json)
  if (!parsed.ok) return parsed
  const data: unknown = JSON.parse(json.replace(/^\uFEFF/, ''))
  const rows: unknown[] = Array.isArray(data) ? data : (data as { accounts: unknown[] }).accounts
  const upload: CredentialUpload = {
    ...(parsed.sourceFormat === 'aiomanager-2.0.0' ? { version: '2.0.0' as const } : {}),
    accounts: rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return null
      const candidate = row as Record<string, unknown>
      const result: NonNullable<CredentialUpload['accounts'][number]> = {
        email: typeof candidate.email === 'string' ? candidate.email : null,
      }
      // A fixed numeric marker retains INVALID_PASSWORD without transmitting an
      // arbitrary object accidentally stored in that field by an invalid export.
      if (candidate.password !== undefined) {
        result.password =
          typeof candidate.password === 'string' || candidate.password === null
            ? candidate.password
            : 0
      }
      return result
    }),
  }
  return { ok: true as const, upload }
}
