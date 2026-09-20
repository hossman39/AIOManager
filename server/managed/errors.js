const definitions = {
  UNAUTHORIZED: [401, 'A valid manager login is required.'],
  NOT_FOUND: [404, 'The managed record was not found.'],
  INVALID_INPUT: [400, 'The managed request is invalid.'],
  INVALID_EXPIRY: [422, 'Select a valid New York date and time.'],
  NONEXISTENT_EXPIRY: [
    422,
    'That New York time does not exist because the clock moves forward. Select a different time.',
  ],
  AMBIGUOUS_EXPIRY: [
    422,
    'That New York time occurs twice. Select the daylight or standard-time occurrence.',
  ],
  IDEMPOTENCY_KEY_REQUIRED: [400, 'A request idempotency key is required.'],
  IDEMPOTENCY_CONFLICT: [409, 'This request key was already used for different content.'],
  VERSION_CONFLICT: [409, 'This record changed. Refresh it before trying again.'],
  INVALID_STATE: [409, 'This operation is not allowed in the current state.'],
  INVALID_ADDON_CONFIG: [422, 'Provide a complete, valid addon configuration.'],
  ADDON_CONFIG_TOO_LARGE: [422, 'An addon configuration exceeds 200 entries or 2 MiB.'],
  DUPLICATE_ADDON_URL: [422, 'The configuration contains duplicate addon URLs.'],
  ADDON_LAYER_CONFLICT: [
    409,
    'A personal addon URL is also present in the group. Resolve the duplicate explicitly.',
  ],
  GROUP_NOT_PUBLISHED: [409, 'Active users require a published destination group.'],
  WRITE_PAUSED: [409, 'Managed writes are paused.'],
  LEASE_LOST: [409, 'The job lease is no longer current.'],
  DATA_UNREADABLE: [503, 'Managed data cannot be decrypted. Restore the matching key and data.'],
}

export class ManagedError extends Error {
  constructor(code) {
    const definition = definitions[code]
    if (!definition) throw new TypeError('Unknown managed error code')
    super(definition[1])
    this.name = 'ManagedError'
    this.code = code
    this.statusCode = definition[0]
  }
}
