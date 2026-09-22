import { ManagedApiError } from '@/api/managed'

export function captureManagedSubmission<T>(value: T, key: string = crypto.randomUUID()) {
  return Object.freeze({ value: structuredClone(value), key })
}

export function managedFailure(error: unknown) {
  const code = error instanceof ManagedApiError ? error.code : 'NETWORK_ERROR'
  return {
    message:
      error instanceof ManagedApiError
        ? error.message
        : 'No save has been confirmed. Retry the same request.',
    uncertain: ['NETWORK_ERROR', 'INVALID_RESPONSE', 'REQUEST_FAILED', 'CANCELLED'].includes(code),
    stale: ['VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'INVALID_STATE', 'PREVIEW_STALE'].includes(
      code
    ),
  }
}
