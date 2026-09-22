import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Upload } from 'lucide-react'
import {
  ManagedApiError,
  type createManagedApi,
  type ManagedImportBatch,
  type ManagedImportPreview,
} from '@/api/managed'
import { MAX_CREDENTIAL_IMPORT_BYTES } from '@/lib/managed/credential-import'
import { prepareCredentialUpload, type CredentialUpload } from '@/lib/managed/prepare-import'
import { useManagedApi } from '@/components/managed/useManagedApi'
import { useUnsavedWarning } from '@/components/common/UnsavedWorkGuard'
import { Button } from '@/components/ui/button'
const describeError = (error: unknown) =>
  error instanceof ManagedApiError ? error.message : 'The import could not be completed. Try again.'
const isCancelled = (error: unknown) =>
  error instanceof ManagedApiError && error.code === 'CANCELLED'
export function AccountImportPage() {
  const { api, ownerKey } = useManagedApi()
  return <ImportWorkspace key={ownerKey} api={api} />
}
function ImportWorkspace({ api }: { api: ReturnType<typeof createManagedApi> }) {
  const [preview, setPreview] = useState<ManagedImportPreview | null>(null)
  const [batch, setBatch] = useState<ManagedImportBatch | null>(null)
  const [importError, setImportError] = useState('')
  const [busy, setBusy] = useState<'preview' | 'stage' | null>(null)
  const [consent, setConsent] = useState(false)
  const [hasPending, setHasPending] = useState(false)
  // Keep raw credentials transient; never put them in React state or local storage.
  const pending = useRef<{ upload: CredentialUpload; key: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const importAbort = useRef<AbortController | null>(null)
  const importSequence = useRef(0)
  useUnsavedWarning(hasPending || busy === 'stage')
  useEffect(
    () => () => {
      importSequence.current++
      importAbort.current?.abort()
      pending.current = null
    },
    []
  )
  const clearImport = () => {
    importSequence.current++
    importAbort.current?.abort()
    pending.current = null
    setHasPending(false)
    setPreview(null)
    setImportError('')
    setConsent(false)
    setBusy(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  const previewPending = async (sequence: number) => {
    const record = pending.current
    if (!record) return
    const controller = new AbortController()
    importAbort.current = controller
    try {
      const result = await api.previewImport(record.upload, controller.signal)
      if (sequence === importSequence.current) setPreview(result)
    } catch (error) {
      if (sequence === importSequence.current && !isCancelled(error))
        setImportError(describeError(error))
    } finally {
      if (sequence === importSequence.current) setBusy(null)
    }
  }

  const selectFile = async (file: File | undefined) => {
    if (!file) return
    clearImport()
    setBatch(null)
    const sequence = importSequence.current
    if (file.size > MAX_CREDENTIAL_IMPORT_BYTES) {
      setImportError('The selected file exceeds the 10 MiB limit.')
      return
    }
    setBusy('preview')
    try {
      const prepared = prepareCredentialUpload(await file.text())
      if (sequence !== importSequence.current) return
      if (!prepared.ok) {
        setImportError(prepared.error.message)
        setBusy(null)
        return
      }
      pending.current = { upload: prepared.upload, key: crypto.randomUUID() }
      setHasPending(true)
      await previewPending(sequence)
    } catch {
      if (sequence === importSequence.current) {
        setImportError('The file could not be read. Select a valid JSON export.')
        setBusy(null)
      }
    }
  }

  const stage = async () => {
    const record = pending.current
    if (!record || !preview || !consent || busy) return
    const sequence = ++importSequence.current
    const controller = new AbortController()
    importAbort.current = controller
    setBusy('stage')
    setImportError('')
    try {
      const result = await api.stageImport(record.upload, record.key, controller.signal)
      if (sequence !== importSequence.current) return
      pending.current = null
      setHasPending(false)
      setPreview(null)
      setConsent(false)
      setBatch(result)
    } catch (error) {
      if (sequence === importSequence.current && !isCancelled(error))
        setImportError(describeError(error))
      // Retain the same key and payload so an ambiguous response can be retried.
    } finally {
      if (sequence === importSequence.current) setBusy(null)
    }
  }

  const readyCount = preview?.accounts.filter((account) => account.status === 'ready').length ?? 0
  const existingCount =
    preview?.accounts.filter((account) => account.status === 'existing').length ?? 0
  const report = preview ?? batch
  return (
    <div className="space-y-5">
      <Link to="/" className="text-sm text-muted-foreground">
        ← Accounts
      </Link>
      <section
        className="space-y-4 rounded-xl border bg-card p-5"
        aria-labelledby="managed-import-heading"
      >
        <div>
          <h3 id="managed-import-heading" className="text-lg font-semibold">
            Import accounts from another installation
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Select an export from your old AIOManager installation with saved credentials included.
            Only email and password are uploaded; addons, tokens, names, dates, and automation rules
            are discarded. Passwords are never shown here.
          </p>
        </div>
        <label className="block space-y-2 text-sm font-medium" htmlFor="managed-import-file">
          <span>AIOManager JSON export (up to 10 MiB)</span>
          <input
            id="managed-import-file"
            ref={fileInput}
            type="file"
            accept=".json,application/json"
            disabled={busy !== null}
            className="block w-full rounded-md border p-2 text-sm file:mr-3 file:rounded file:border-0 file:bg-muted file:px-3 file:py-1"
            onChange={(event) => {
              void selectFile(event.target.files?.[0])
            }}
          />
        </label>
        {busy === 'preview' && (
          <p role="status" className="text-sm">
            Checking rows and existing users… No users are being saved yet.
          </p>
        )}
        {importError && (
          <p
            role="alert"
            className="rounded border border-destructive/30 p-3 text-sm text-destructive"
          >
            {importError}
          </p>
        )}
        {hasPending && !preview && !busy && (
          <Button
            variant="outline"
            onClick={() => {
              setImportError('')
              setBusy('preview')
              void previewPending(++importSequence.current)
            }}
          >
            Retry preview
          </Button>
        )}

        {report && (
          <div className="space-y-3">
            <p className="text-sm">
              {report.totalRows} source rows · {report.accounts.length} distinct credential
              candidates
            </p>
            {preview && (
              <p className="text-sm">
                {readyCount} new users ready to stage · {existingCount} already saved ·{' '}
                {preview.accounts.filter((account) => account.status === 'conflict').length}{' '}
                saved-password conflicts
              </p>
            )}
            <div className="max-h-72 overflow-auto rounded border">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Credential import reconciliation</caption>
                <thead className="sticky top-0 bg-muted">
                  <tr>
                    <th scope="col" className="p-3">
                      Source rows
                    </th>
                    <th scope="col" className="p-3">
                      Email
                    </th>
                    <th scope="col" className="p-3">
                      Result
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.accounts.map((account) => (
                    <tr key={account.sourceRows.join(',')} className="border-t">
                      <td className="p-3">{account.sourceRows.join(', ')}</td>
                      <td className="break-all p-3">{account.email}</td>
                      <td className="p-3">
                        {
                          {
                            ready: 'Ready to stage',
                            existing: 'Already saved',
                            conflict: 'Password conflict — unchanged',
                            staged: 'Saved, inactive',
                          }[account.status]
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {report.issues.length > 0 && (
              <details className="rounded border p-3" open>
                <summary className="cursor-pointer text-sm font-medium">
                  {report.issues.length} row notices — no silent credential replacement
                </summary>
                <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-sm text-muted-foreground">
                  {report.issues.map((issue) => (
                    <li key={`${issue.row}:${issue.code}`}>
                      Row {issue.row}: {issue.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}

        {preview && (
          <div className="space-y-3 border-t pt-4">
            <h3 className="font-semibold">2. Save inactive users</h3>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={consent}
                disabled={busy !== null}
                onChange={(event) => setConsent(event.target.checked)}
                className="mt-1"
              />
              <span>
                I understand that account passwords will be stored encrypted on this server for
                future unattended management. Use a trusted server over HTTPS. Importing does not
                activate users.
              </span>
            </label>
            <Button
              onClick={() => {
                void stage()
              }}
              disabled={!consent || readyCount + existingCount === 0 || busy !== null}
            >
              <Upload aria-hidden="true" />
              {busy === 'stage' ? 'Saving inactive users…' : 'Save inactive users'}
            </Button>
          </div>
        )}
        {hasPending && (
          <Button variant="ghost" disabled={busy === 'stage'} onClick={clearImport}>
            Clear selected credentials
          </Button>
        )}
        {batch && (
          <p
            role="status"
            className="rounded border border-green-500/30 bg-green-500/5 p-3 text-sm"
          >
            {batch.replayed ? 'Import already saved. Original result: ' : 'Import saved: '}
            {batch.created} users staged, {batch.existing} existing matches, {batch.conflicts}{' '}
            saved-password conflicts.{' '}
            {batch.issues.length > 0 && `See the ${batch.issues.length} row notices above. `}
            No Stremio addons were changed.
          </p>
        )}
      </section>
    </div>
  )
}
