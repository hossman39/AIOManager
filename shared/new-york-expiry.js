export const MEMBERSHIP_TIMEZONE = 'America/New_York'
const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: MEMBERSHIP_TIMEZONE,
  calendar: 'iso8601',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

function wallTime(at) {
  const parts = Object.fromEntries(
    formatter.formatToParts(at).map(({ type, value }) => [type, value])
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** Resolve New York wall time without consulting the browser/server local zone. */
export function newYorkExpiryChoices(local) {
  if (typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    return { ok: false, code: 'INVALID_EXPIRY' }
  const [year, month, day, hour, minute] = local.split(/[-T:]/).map(Number)
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
    return { ok: false, code: 'INVALID_EXPIRY' }
  const asUtc = Date.UTC(year, month - 1, day, hour, minute)
  const date = new Date(asUtc)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return { ok: false, code: 'INVALID_EXPIRY' }
  // Since 1900, New York's applicable offsets are -05:00 and -04:00. Validate
  // candidates against ICU's timezone rules rather than guessing DST by month.
  const choices = [-240, -300]
    .map((offset) => ({
      at: asUtc - offset * 60_000,
      offset,
      local,
      timezone: MEMBERSHIP_TIMEZONE,
      label: offset === -240 ? 'UTC−04:00 (daylight time)' : 'UTC−05:00 (standard time)',
    }))
    .filter((choice) => wallTime(choice.at) === local)
    .sort((a, b) => a.at - b.at)
  return choices.length ? { ok: true, choices } : { ok: false, code: 'NONEXISTENT_EXPIRY' }
}

export function resolveNewYorkExpiry(local, offset) {
  const result = newYorkExpiryChoices(local)
  if (!result.ok) return result
  if (offset === undefined && result.choices.length > 1)
    return { ok: false, code: 'AMBIGUOUS_EXPIRY' }
  const selected =
    offset === undefined
      ? result.choices[0]
      : result.choices.find((choice) => choice.offset === offset)
  return selected ? { ok: true, expiry: selected } : { ok: false, code: 'INVALID_EXPIRY' }
}
