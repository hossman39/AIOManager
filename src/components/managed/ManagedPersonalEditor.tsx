import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ManagedApiError, type createManagedApi, type ManagedAccount } from '@/api/managed'
import { checkedAddonDraft, AddonDraftError } from '@/lib/managed/addon-draft'
import type { ManagedAddon } from '../../../shared/addon-config.js'
import { ManagedAddonEditor } from './ManagedAddonEditor'
import { useManagedSubmission, useUnsavedWarning } from './useManagedSubmission'

type Props = {
  api: ReturnType<typeof createManagedApi>
  account: ManagedAccount
  onSaved: (account: ManagedAccount) => void
  onClose: () => void
}

export function ManagedPersonalEditor({ api, account, onSaved, onClose }: Props) {
  const [current, setCurrent] = useState<ManagedAccount | null>(null)
  const [addons, setAddons] = useState<ManagedAddon[]>([])
  const [dirty, setDirty] = useState(false)
  const [reading, setReading] = useState(true)
  const [resolving, setResolving] = useState(false)
  const [pendingUrl, setPendingUrl] = useState(false)
  const [editorEpoch, setEditorEpoch] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(false)
  const readAbort = useRef<AbortController | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const mutation = useManagedSubmission<
    { addons: ManagedAddon[]; expectedVersion: number },
    Awaited<ReturnType<typeof api.personalAddons>>
  >(
    async (body, key, signal) => {
      const result = await api.setPersonalAddons(account.id, body, key, signal)
      return result.replayed ? api.personalAddons(account.id, signal) : result
    },
    (result) => {
      setCurrent(result.account)
      setAddons(result.addons)
      setDirty(false)
      setNotice(
        'Personal setup saved. Staged users are not activated; provider status is tracked separately.'
      )
      onSaved(result.account)
    }
  )
  const load = async () => {
    readAbort.current?.abort()
    const controller = new AbortController()
    readAbort.current = controller
    setReading(true)
    setError('')
    try {
      const result = await api.personalAddons(account.id, controller.signal)
      if (alive.current && !controller.signal.aborted) {
        setCurrent(result.account)
        setAddons(result.addons)
        setDirty(false)
        setEditorEpoch((value) => value + 1)
        mutation.reset()
      }
    } catch (error) {
      if (alive.current && !controller.signal.aborted)
        setError(
          error instanceof ManagedApiError ? error.message : 'The personal setup could not be read.'
        )
    } finally {
      if (alive.current && !controller.signal.aborted) setReading(false)
    }
  }
  useEffect(() => {
    alive.current = true
    heading.current?.focus()
    const controller = new AbortController()
    readAbort.current = controller
    void api.personalAddons(account.id, controller.signal).then(
      (result) => {
        if (alive.current && !controller.signal.aborted) {
          setCurrent(result.account)
          setAddons(result.addons)
          setReading(false)
        }
      },
      (error) => {
        if (alive.current && !controller.signal.aborted) {
          setError(
            error instanceof ManagedApiError
              ? error.message
              : 'The personal setup could not be read.'
          )
          setReading(false)
        }
      }
    )
    return () => {
      alive.current = false
      readAbort.current?.abort()
    }
  }, [api, account.id])
  useUnsavedWarning(dirty || mutation.busy || mutation.uncertain)
  const locked =
    reading ||
    resolving ||
    mutation.busy ||
    mutation.uncertain ||
    mutation.stale ||
    current?.state === 'offboarding'
  const save = () => {
    if (!current || locked || pendingUrl || !dirty) return
    try {
      setError('')
      void mutation.submit({ addons: checkedAddonDraft(addons), expectedVersion: current.version })
    } catch (error) {
      setError(
        error instanceof AddonDraftError ? error.message : 'The setup could not be validated.'
      )
    }
  }
  return (
    <section
      className="min-w-0 space-y-3 rounded border p-4"
      aria-labelledby="managed-personal-heading"
    >
      <h4
        ref={heading}
        tabIndex={-1}
        id="managed-personal-heading"
        className="break-all font-semibold"
      >
        Personal addons for {account.email}
      </h4>
      <p className="text-sm text-muted-foreground">
        These follow the group’s addons. A URL cannot appear in both layers. Expiry disables these
        too, without deleting their saved setup.
      </p>
      {reading && (
        <p role="status" className="text-sm">
          Reading saved personal setup…
        </p>
      )}
      {current && (
        <ManagedAddonEditor
          key={editorEpoch}
          addons={addons}
          api={api}
          disabled={locked}
          onBusyChange={setResolving}
          onPendingChange={setPendingUrl}
          onChange={(value) => {
            setAddons(value)
            setDirty(true)
            setNotice('')
          }}
        />
      )}
      {(error || mutation.message) && (
        <p role="alert" className="text-sm text-destructive">
          {error || mutation.message}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={locked || pendingUrl || !dirty} onClick={save}>
          Save personal setup
        </Button>
        {mutation.uncertain && (
          <Button type="button" disabled={mutation.busy} onClick={() => void mutation.retry()}>
            Retry same personal save
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={mutation.busy || mutation.uncertain || reading || resolving}
          onClick={() => void load()}
        >
          {dirty || pendingUrl ? 'Discard edits & reload' : 'Reload personal setup'}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={dirty || pendingUrl || mutation.busy || mutation.uncertain || resolving}
          onClick={onClose}
        >
          Close personal editor
        </Button>
      </div>
    </section>
  )
}
