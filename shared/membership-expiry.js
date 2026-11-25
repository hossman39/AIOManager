export const MEMBERSHIP_TIMEZONE = 'America/New_York'
const formatters = new Map()

function formatter(timezone) {
  if (
    typeof timezone !== 'string' ||
    !timezone ||
    timezone.length > 100 ||
    !/^[A-Za-z0-9_+/-]+$/.test(timezone)
  )
    throw new RangeError('Invalid timezone')
  if (!formatters.has(timezone)) {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      calendar: 'iso8601',
      numberingSystem: 'latn',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
    if (formatters.size >= 64) formatters.delete(formatters.keys().next().value)
    formatters.set(timezone, value)
  }
  return formatters.get(timezone)
}
export function validMembershipTimezone(timezone) {
  try {
    formatter(timezone)
    return true
  } catch {
    return false
  }
}
function partsAt(value, at) {
  const parts = Object.fromEntries(value.formatToParts(at).map(({ type, value }) => [type, value]))
  return {
    local: `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
    utc: Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    ),
  }
}
function offsetLabel(offset) {
  const seconds = Math.round(Math.abs(offset) * 60)
  const hours = String(Math.floor(seconds / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
  const remainder = seconds % 60
  return `UTC${offset < 0 ? '−' : '+'}${hours}:${minutes}${remainder ? `:${String(remainder).padStart(2, '0')}` : ''}`
}
/** Resolve named-zone wall time with ICU rules, including gaps and repeated times. */
export function expiryChoices(local, timezone = MEMBERSHIP_TIMEZONE) {
  let value
  try {
    value = formatter(timezone)
  } catch {
    return { ok: false, code: 'INVALID_TIMEZONE' }
  }
  if (typeof local !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local))
    return { ok: false, code: 'INVALID_EXPIRY' }
  const [year, month, day, hour, minute] = local.split(/[-T:]/).map(Number)
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59)
    return { ok: false, code: 'INVALID_EXPIRY' }
  const utc = Date.UTC(year, month - 1, day, hour, minute)
  const date = new Date(utc)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return { ok: false, code: 'INVALID_EXPIRY' }
  const offsets = new Set()
  // Round-trip candidates from both sides of nearby timezone transitions.
  for (let hours = -48; hours <= 48; hours += 6) {
    const at = utc + hours * 3_600_000
    offsets.add((partsAt(value, at).utc - at) / 60_000)
  }
  const choices = [...offsets]
    .map((offset) => ({
      at: utc - Math.round(offset * 60_000),
      offset,
      local,
      timezone,
      label: offsetLabel(offset),
    }))
    .filter((choice) => partsAt(value, choice.at).local === local)
    .sort((a, b) => a.at - b.at)
  return choices.length ? { ok: true, choices } : { ok: false, code: 'NONEXISTENT_EXPIRY' }
}
export function resolveExpiry(local, offset, timezone = MEMBERSHIP_TIMEZONE) {
  const result = expiryChoices(local, timezone)
  if (!result.ok) return result
  if (offset === undefined && result.choices.length > 1)
    return { ok: false, code: 'AMBIGUOUS_EXPIRY' }
  const selected =
    offset === undefined
      ? result.choices[0]
      : result.choices.find((choice) => choice.offset === offset)
  return selected ? { ok: true, expiry: selected } : { ok: false, code: 'INVALID_EXPIRY' }
}

/** Exclusive cutoff after the last instant of the selected local calendar day. */
export function resolveExpiryDate(date, timezone = MEMBERSHIP_TIMEZONE) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return { ok: false, code: 'INVALID_EXPIRY' }
  const end = expiryChoices(`${date}T23:59`, timezone)
  if (!end.ok && end.code !== 'NONEXISTENT_EXPIRY') return end
  const zone = formatter(timezone)
  const nextDay = Date.parse(`${date}T00:00:00Z`) + 86_400_000
  // Start at the last occurrence if the final hour repeats. If a clock jump
  // skips the final minute, locate the transition using the actual zone rules.
  let low = end.ok ? end.choices.at(-1).at : nextDay - 2 * 86_400_000
  let high = end.ok ? low + 60_000 : nextDay + 2 * 86_400_000
  while (high - low > 1000) {
    const middle = low + Math.floor((high - low) / 2000) * 1000
    if (partsAt(zone, middle).utc < nextDay) low = middle
    else high = middle
  }
  const last = partsAt(zone, high - 1000)
  if (last.local.slice(0, 10) !== date) return { ok: false, code: 'NONEXISTENT_EXPIRY' }
  const offset = (last.utc - (high - 1000)) / 60_000
  return {
    ok: true,
    expiry: { at: high, local: date, timezone, offset, label: offsetLabel(offset) },
  }
}

export function resolveAnnualExpiry(expiryAt, timezone, now) {
  if (!validMembershipTimezone(timezone)) return { ok: false, code: 'INVALID_TIMEZONE' }
  // The stored cutoff is exclusive. One millisecond earlier is the last paid day.
  const base = expiryAt !== null && expiryAt > now ? expiryAt - 1 : now
  const local = partsAt(formatter(timezone), base).local
  const nextYear = Number(local.slice(0, 4)) + 1
  const monthDay = local.slice(5, 10)
  return resolveExpiryDate(`${nextYear}-${monthDay === '02-29' ? '02-28' : monthDay}`, timezone)
}
