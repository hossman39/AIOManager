import { inflateSync } from 'node:zlib'
import { boundedJson } from './nuvio.js'
import { ManagedError } from './errors.js'

const identity = (row) =>
  JSON.stringify([row.content_type, row.content_id, row.season ?? null, row.episode ?? null])
const episodeNumber = (n) => Number.isSafeInteger(n) && n >= 0
const timestamp = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value)
  return Number.isSafeInteger(ms) && ms > 0 ? ms : 0
}

export async function cinemetaEpisodes(id, signal) {
  if (!/^tt\d+$/.test(id)) return []
  const r = await fetch('https://v3-cinemeta.strem.io/meta/series/' + id + '.json', {
    signal: AbortSignal.any([AbortSignal.timeout(8000), signal]),
    redirect: 'error',
  })
  if (!r.ok) {
    await r.body?.cancel()
    return []
  }
  const meta = await boundedJson(r)
  return Array.isArray(meta?.meta?.videos) ? meta.meta.videos : []
}

// Stremio stores a compressed little-endian bitmap anchored at a video ID in its ordered episode list.
export function watchedEpisodes(serialized, videos) {
  const match = /^(.+):(\d+):([A-Za-z0-9+/]+=*)$/.exec(serialized)
  if (!match || !Array.isArray(videos)) return null
  const size = Number(match[2])
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_000_000) return null
  const sorted = videos
    .map((v) => ({
      id: v.id,
      season: v.season,
      episode: v.episode ?? v.number,
      released: timestamp(v.released),
    }))
    .sort(
      (a, b) =>
        (a.season ?? -1) - (b.season ?? -1) ||
        (a.episode ?? -1) - (b.episode ?? -1) ||
        a.released - b.released
    )
  const anchor = sorted.findIndex((v) => v.id === match[1])
  if (anchor < 0) return null
  let bytes
  try {
    bytes = inflateSync(Buffer.from(match[3], 'base64'), { maxOutputLength: 128 * 1024 })
  } catch {
    return null
  }
  if (size > bytes.length * 8) return null
  return sorted.filter((v, i) => {
    const bit = i + size - anchor - 1
    return (
      episodeNumber(v.season) &&
      episodeNumber(v.episode) &&
      bit >= 0 &&
      Boolean(bytes[bit >> 3] & (1 << (bit % 8)))
    )
  })
}

export async function historyCandidates(
  items,
  { episodes = cinemetaEpisodes, signal = AbortSignal.timeout(180_000) } = {}
) {
  if (!Array.isArray(items)) throw new ManagedError('PROVIDER_FAILURE')
  const watched = new Map(),
    progress = new Map(),
    skipped = []
  let cursor = 0
  const retainLatest = (map, row, field) => {
    const key = identity(row)
    if (!map.has(key) || map.get(key)[field] < row[field]) map.set(key, row)
  }
  async function scan() {
    while (cursor < items.length) {
      signal.throwIfAborted()
      const item = items[cursor++],
        state = item?.state
      if (!state || !['movie', 'series'].includes(item.type) || typeof item._id !== 'string')
        continue
      const base = { content_id: item._id, content_type: item.type }
      const title = item.name || item._id
      const at = timestamp(state.lastWatched)
      const watchedAt = at || timestamp(item._mtime)
      const addWatched = (episode) =>
        retainLatest(watched, { ...base, ...episode, title, watched_at: watchedAt }, 'watched_at')
      if (item.type === 'movie' && (state.flaggedWatched || state.timesWatched > 0)) addWatched({})
      if (
        item.type === 'series' &&
        state.watched &&
        !(typeof state.watched === 'string' && state.watched.startsWith('undefined:'))
      ) {
        let found
        try {
          found = /^tt\d+$/.test(item._id)
            ? watchedEpisodes(state.watched, await episodes(item._id, signal))
            : null
        } catch {
          signal.throwIfAborted()
          found = null
        }
        if (!found) skipped.push(title)
        else for (const { season, episode } of found) addWatched({ season, episode })
      }
      if (
        (!item.removed || item.temp) &&
        Number.isSafeInteger(state.timeOffset) &&
        state.timeOffset > 0 &&
        Number.isSafeInteger(state.duration) &&
        state.duration >= 60_000 &&
        at
      ) {
        const matched = typeof state.video_id === 'string' && /:(\d+):(\d+)$/.exec(state.video_id)
        const season = matched ? Number(matched[1]) : state.season
        const episode = matched ? Number(matched[2]) : state.episode
        if (item.type === 'series' && !(episodeNumber(season) && episodeNumber(episode))) {
          skipped.push(title)
          continue
        }
        const episodeKey = item.type === 'series' ? { season, episode } : {}
        if (state.timeOffset >= state.duration * 0.9) {
          addWatched(episodeKey)
          continue
        }
        retainLatest(
          progress,
          {
            ...base,
            ...episodeKey,
            video_id:
              state.video_id ||
              (item.type === 'series' ? [item._id, season, episode].join(':') : item._id),
            position: Math.round(state.timeOffset),
            duration: Math.round(state.duration),
            last_watched: at,
          },
          'last_watched'
        )
      }
    }
  }
  await Promise.all(Array.from({ length: 4 }, scan))
  return {
    watched: [...watched.values()],
    progress: [...progress.values()],
    skipped: [...new Set(skipped)].sort(),
  }
}

export function mergeHistory(candidates, existing) {
  const done = new Map(existing.watched.map((row) => [identity(row), Number(row.watched_at)]))
  const resume = new Map(existing.progress.map((row) => [identity(row), Number(row.last_watched)]))
  const watched = candidates.watched.filter(
    (row) => !done.has(identity(row)) && !(resume.get(identity(row)) > row.watched_at)
  )
  for (const row of watched) done.set(identity(row), row.watched_at)
  const progress = candidates.progress.filter((row) => {
    const key = identity(row)
    return row.last_watched > (resume.get(key) ?? 0) && row.last_watched > (done.get(key) ?? 0)
  })
  return { watched, progress, skipped: candidates.skipped }
}

export function confirmHistory(plan, snapshot) {
  const watched = new Map(snapshot.watched.map((row) => [identity(row), row]))
  const progress = new Map(snapshot.progress.map((row) => [identity(row), row]))
  const result = { watched: 0, progress: 0, preserved: 0, unconfirmed: 0 }
  for (const row of plan.watched) {
    const key = identity(row)
    if (watched.has(key)) result.watched++
    else if (Number(progress.get(key)?.last_watched) > row.watched_at) result.preserved++
    else result.unconfirmed++
  }
  for (const row of plan.progress) {
    const key = identity(row)
    const resume = progress.get(key)
    if (
      Number(resume?.last_watched) === row.last_watched &&
      Number(resume?.position) === row.position &&
      Number(resume?.duration) === row.duration
    )
      result.progress++
    else if (
      Number(resume?.last_watched) > row.last_watched ||
      Number(watched.get(key)?.watched_at) >= row.last_watched
    )
      result.preserved++
    else result.unconfirmed++
  }
  return result
}

export async function readHistory(driver, token, profileId, options) {
  const pageSize = 250
  async function pages(watched) {
    const rows = []
    for (let page = 0; page < 400; page++) {
      const batch = watched
        ? await driver.rpc(
            'sync_pull_watched_items',
            token,
            { p_profile_id: profileId, p_page: page + 1, p_page_size: pageSize },
            options
          )
        : await driver.progressPage(token, profileId, page * pageSize, pageSize, options)
      if (
        !Array.isArray(batch) ||
        batch.length > pageSize ||
        batch.some((row) => !row || typeof row.content_id !== 'string')
      )
        throw new ManagedError('PROVIDER_FAILURE')
      rows.push(...batch)
      if (batch.length < pageSize) return rows
    }
    throw new ManagedError('REQUEST_TOO_LARGE')
  }
  const [watched, progress] = await Promise.all([pages(true), pages(false)])
  return { watched, progress }
}
