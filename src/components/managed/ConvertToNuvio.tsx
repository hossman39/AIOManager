import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ManagedApiError, type createManagedApi, type ManagedAccount } from '@/api/managed'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

type Props = { api: ReturnType<typeof createManagedApi>; account: ManagedAccount }
const message = (e: unknown) =>
  e instanceof ManagedApiError ? e.message : 'Could not finish this step. Retry to continue.'

export function ConvertToNuvio(props: Props) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Convert to Nuvio
      </Button>
      {open && <NuvioConversionDialog {...props} onClose={() => setOpen(false)} />}
    </>
  )
}
export function NuvioConversionDialog({ api, account, onClose }: Props & { onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState('')
  const [destination, setDestination] = useState('')
  const [setup, setSetup] = useState('')
  const [history, setHistory] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  async function convert() {
    if (busy) return
    setBusy(true)
    setError('')
    setSetup('')
    setHistory('')
    setStage('Connecting the primary Nuvio profile…')
    try {
      const { account: target, keptSetup } = await api.convertToNuvio(
        account.id,
        account.version,
        crypto.randomUUID()
      )
      setDestination(target.id)
      let setupComplete = true
      setStage('Preparing addon sync…')
      try {
        if (keptSetup) {
          setSetup(
            'This Nuvio profile is already managed. Kept its current membership and addon settings.'
          )
        } else if (target.membershipType === 'unset') {
          setSetup('Setup copied. Set a Nuvio membership to enable addon sync.')
        } else if (!target.groupId && target.state === 'staged') {
          const preview = await api.activationPreview(target.id, {
            expectedVersion: target.version,
            safeMode: target.safeMode,
          })
          if (preview.afterCount === 0 && preview.beforeCount > 0) {
            setSetup('Setup copied. Open Sync & access to review clearing existing Nuvio addons.')
          } else {
            await api.activate(
              target.id,
              {
                expectedVersion: preview.version,
                receipt: preview.receipt,
                allowEmpty: preview.afterCount === 0,
              },
              crypto.randomUUID()
            )
            setSetup('Individual addon sync queued.')
          }
        } else if (target.groupId && target.state === 'staged') {
          setSetup('Group copied. Addons sync when the group has a published configuration.')
        } else {
          setSetup('Nuvio addon management is active.')
        }
      } catch (e) {
        setupComplete = false
        setSetup('Addon sync needs attention. ' + message(e))
      }
      setStage('Importing watch history…')
      const preview = await api.historyPreview(target.id, account.id, 1)
      const hasChanges = preview.watched + preview.progress > 0
      const result = hasChanges ? await api.importHistory(target.id, preview.preview) : null
      const report = result
        ? `Confirmed ${result.watched} watched items and ${result.progress} resume points. ${result.preserved ? result.preserved + ' newer entries preserved. ' : ''}${result.unconfirmed ? result.unconfirmed + ' entries need another attempt.' : ''}`
        : 'History is up to date.'
      setHistory(
        report +
          (preview.skippedCount
            ? ' Unmatched titles (' + preview.skippedCount + '): ' + preview.skipped.join(', ')
            : '')
      )
      setDone(setupComplete && !result?.unconfirmed)
    } catch (e) {
      const detail =
        e instanceof ManagedApiError && e.code === 'NUVIO_CONFIRM_EMAIL'
          ? 'Confirm the email from Nuvio, then retry conversion here.'
          : e instanceof ManagedApiError && e.code === 'ACCOUNT_EXISTS'
            ? 'This primary Nuvio profile is already managed separately. Open its Sync & access tab to import history.'
            : message(e)
      setError(detail)
    } finally {
      setStage('')
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(value) => {
        if (!value && !busy) onClose()
      }}
    >
      <DialogContent role="dialog" aria-modal="true" aria-label="Convert to Nuvio">
        <DialogHeader>
          <DialogTitle>Convert to Nuvio</DialogTitle>
          <DialogDescription>
            Use the saved Stremio email ({account.email}) and password to sign in to Nuvio or create
            an account. Copy the membership, group, and addon settings to the primary profile and
            import watch history. The original Stremio account stays available.
          </DialogDescription>
        </DialogHeader>
        {stage && <p role="status">{stage}</p>}
        {setup && <p role="status">{setup}</p>}
        {history && <p role="status">{history}</p>}
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          {destination && !busy && (
            <Button variant="outline" asChild>
              <Link to={'/account/' + destination}>Open Nuvio account</Link>
            </Button>
          )}
          {!done && (
            <Button disabled={busy} onClick={() => void convert()}>
              {busy
                ? 'Converting…'
                : destination || error
                  ? 'Retry conversion'
                  : 'Convert and import'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
