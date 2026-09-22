export const MEMBERSHIP_TIMEZONE: 'America/New_York'
export interface NewYorkExpiry {
  at: number
  offset: number
  local: string
  timezone: 'America/New_York'
  label: string
}
type InvalidExpiry = {
  ok: false
  code: 'INVALID_EXPIRY' | 'NONEXISTENT_EXPIRY' | 'AMBIGUOUS_EXPIRY'
}
export function newYorkExpiryChoices(
  local: string
): { ok: true; choices: NewYorkExpiry[] } | InvalidExpiry
export function resolveNewYorkExpiry(
  local: string,
  offset?: number
): { ok: true; expiry: NewYorkExpiry } | InvalidExpiry
