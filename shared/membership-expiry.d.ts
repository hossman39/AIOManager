export const MEMBERSHIP_TIMEZONE: 'America/New_York'
export interface MembershipExpiry {
  at: number
  offset: number
  local: string
  timezone: string
  label: string
}
export type InvalidExpiry = {
  ok: false
  code: 'INVALID_EXPIRY' | 'NONEXISTENT_EXPIRY' | 'AMBIGUOUS_EXPIRY' | 'INVALID_TIMEZONE'
}
export function validMembershipTimezone(timezone: unknown): boolean
export function expiryChoices(
  local: string,
  timezone?: string
): { ok: true; choices: MembershipExpiry[] } | InvalidExpiry
export function resolveExpiry(
  local: string,
  offset?: number,
  timezone?: string
): { ok: true; expiry: MembershipExpiry } | InvalidExpiry
