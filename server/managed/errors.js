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
  PUBLICATION_UNAVAILABLE: [
    503,
    'Group publication is unavailable until trusted manifest validation is configured.',
  ],
  MANIFEST_UNAVAILABLE: [
    422,
    'A required addon manifest could not be validated. No revision was published.',
  ],
  MANIFEST_UNSAFE_URL: [
    422,
    'The manifest URL or destination is not permitted. Use a direct trusted URL.',
  ],
  MANIFEST_INVALID: [422, 'The manifest response is incomplete, invalid, or exceeds 2 MiB.'],
  MANIFEST_CONFIGURATION_REQUIRED: [
    422,
    'Configure the addon in its own app, then use its configured manifest URL.',
  ],
  MANIFEST_ID_MISMATCH: [
    422,
    'The URL now serves a different addon. Review the saved addon before publishing.',
  ],
  MANIFEST_TIMEOUT: [
    504,
    'Manifest validation timed out or was cancelled. No revision was published.',
  ],
  MANIFEST_BUSY: [503, 'Manifest validation is busy. Try again after the current checks finish.'],
  PREVIEW_STALE: [
    409,
    'This publication preview is invalid, expired, or changed. Prepare it again.',
  ],
  GROUP_TOO_LARGE: [422, 'This publication exceeds the 1,000-member transaction limit.'],
  EMPTY_PUBLICATION_CONFIRMATION: [
    409,
    'Publishing an empty or entirely disabled addon setup requires an explicit choice.',
  ],
  WRITE_PAUSED: [409, 'Managed writes are paused.'],
  LEASE_LOST: [409, 'The job lease is no longer current.'],
  IDENTITY_MISMATCH: [409, 'The provider session does not match the enrolled account.'],
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
