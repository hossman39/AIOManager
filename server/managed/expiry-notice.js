import { readFile } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { defaultExpiryNotice, EXPIRY_NOTICE_ADDON_ID } from '../../shared/expiry-notice.js'
import { ManagedError } from './errors.js'

const publicUrl = (value, base = false) => {
  if (!value) return true
  if (/[\s\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!base || !url.search)
    )
  } catch {
    return false
  }
}
const settingsSchema = z
  .strictObject({
    enabled: z.boolean(),
    baseUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => publicUrl(value, true))
      .transform((value) => (value ? new URL(value).href.replace(/\/+$/, '') : '')),
    message: z.string().trim().min(1).max(600),
    renewalUrl: z
      .string()
      .trim()
      .max(2048)
      .refine((value) => publicUrl(value)),
  })
  .refine((value) => !value.enabled || Boolean(value.baseUrl))
const inputSchema = z.strictObject({
  expectedVersion: z.number().int().positive().nullable(),
  settings: settingsSchema,
})
const binding = (owner) => ({ owner, id: owner, purpose: 'expiry-notice' })
const itemId = 'aiomanager:membership-expired'
export function readExpiryNotice(row, crypto) {
  if (!row?.expiry_notice_enc) return { ...defaultExpiryNotice, manifestUrl: null }
  const parsed = settingsSchema.safeParse(crypto.open(row.expiry_notice_enc, binding(row.owner_id)))
  if (!parsed.success || !/^[a-f0-9]{64}$/.test(row.expiry_notice_token))
    throw new ManagedError('DATA_UNREADABLE')
  const settings = parsed.data
  return {
    ...settings,
    manifestUrl: settings.baseUrl
      ? `${settings.baseUrl}/api/notice/${row.expiry_notice_token}/manifest.json`
      : null,
  }
}
export function expiryNoticeAddon(settings) {
  if (!settings.enabled || !settings.manifestUrl) return null
  return {
    transportUrl: settings.manifestUrl,
    manifest: {
      id: EXPIRY_NOTICE_ADDON_ID,
      version: '1.0.0',
      name: 'Membership expired',
      description: settings.message,
      resources: [
        { name: 'catalog', types: ['movie'] },
        { name: 'meta', types: ['movie'], idPrefixes: ['aiomanager:'] },
        { name: 'stream', types: ['movie', 'series'] },
      ],
      types: ['movie', 'series'],
      catalogs: [{ type: 'movie', id: 'membership', name: 'Membership expired' }],
      behaviorHints: { configurable: false },
    },
    flags: { official: false, protected: false },
  }
}

export function createExpiryNoticeRepository({
  db,
  crypto,
  authorize,
  ownerTransaction,
  idempotent,
  jobs,
}) {
  return {
    async getExpiryNotice(auth) {
      const owner = await authorize(auth)
      const row = await db.get('SELECT * FROM managed_owners WHERE owner_id = $1', [owner])
      return { version: row?.version ?? null, settings: readExpiryNotice(row, crypto) }
    },
    async saveExpiryNotice(auth, input, key) {
      const parsed = inputSchema.safeParse(input)
      if (!parsed.success) throw new ManagedError('INVALID_INPUT')
      const value = parsed.data
      return ownerTransaction(auth, (tx, owner, row, timestamp) =>
        idempotent(tx, owner, 'expiry-notice.save', key, value, timestamp, async () => {
          if (row.version !== (value.expectedVersion ?? 1))
            throw new ManagedError('VERSION_CONFLICT')
          const members = await tx.query(
            `SELECT * FROM managed_accounts WHERE owner_id = $1 AND state = 'active'
            AND (suspended_at IS NOT NULL OR (lifetime = 0 AND expiry_at <= $2))
            ORDER BY id${tx.type === 'postgres' ? ' FOR UPDATE' : ''}`,
            [owner, timestamp]
          )
          await tx.run(
            `UPDATE managed_owners SET expiry_notice_enc = $1, expiry_notice_token = $2,
            version = version + 1, updated_at = $3 WHERE owner_id = $4`,
            [
              crypto.seal(value.settings, binding(owner)),
              row.expiry_notice_token ?? randomBytes(32).toString('hex'),
              timestamp,
              owner,
            ]
          )
          for (const account of members) {
            await tx.run(
              'UPDATE managed_accounts SET record_version = record_version + 1, policy_version = policy_version + 1, updated_at = $1 WHERE owner_id = $2 AND id = $3',
              [timestamp, owner, account.id]
            )
            const updated = {
              ...account,
              record_version: account.record_version + 1,
              policy_version: account.policy_version + 1,
            }
            await jobs.enqueueInTransaction(tx, updated, 'expiry', timestamp)
          }
          const auditId = randomUUID()
          await tx.run(
            'INSERT INTO managed_audit (id, owner_id, event_type, subject_id, detail_enc, created_at) VALUES ($1, $2, $3, $2, $4, $5)',
            [
              auditId,
              owner,
              'expiry-notice.saved',
              crypto.seal(
                { enabled: value.settings.enabled, queued: members.length },
                { owner, id: auditId, purpose: 'audit' }
              ),
              timestamp,
            ]
          )
          return {
            version: row.version + 1,
            settings: readExpiryNotice(
              await tx.get('SELECT * FROM managed_owners WHERE owner_id = $1', [owner]),
              crypto
            ),
            queued: members.length,
            replayed: false,
          }
        })
      )
    },
  }
}

/** Public Stremio protocol endpoints contain only the manager's public notice.
 * No account identity, credentials, membership date, or playable content is exposed. */
export async function registerExpiryNoticeRoutes(app, { db, crypto }) {
  const poster = await readFile(new URL('../assets/membership-expired.png', import.meta.url))
  await app.register(
    async (routes) => {
      routes.addHook('onRequest', async (_request, reply) => {
        reply.header('access-control-allow-origin', '*').header('cache-control', 'no-store')
      })
      routes.get('/:token/*', async (request, reply) => {
        const missing = () => reply.code(404).send({ error: 'Notice not found' })
        if (!/^[a-f0-9]{64}$/.test(request.params.token)) return missing()
        const row = await db.get('SELECT * FROM managed_owners WHERE expiry_notice_token = $1', [
          request.params.token,
        ])
        if (!row) return missing()
        let settings
        try {
          settings = readExpiryNotice(row, crypto)
        } catch {
          return missing()
        }
        if (!settings.manifestUrl) return missing()
        const resource = request.params['*']
        // Continue serving the notice while a disabling sync removes it from devices.
        const addon = expiryNoticeAddon({ ...settings, enabled: true })
        const base = settings.manifestUrl.slice(0, -'/manifest.json'.length)
        const meta = {
          id: itemId,
          type: 'movie',
          name: 'Membership expired',
          poster: `${base}/poster.png`,
          posterShape: 'square',
          description: settings.message,
          ...(settings.renewalUrl
            ? {
                links: [
                  { name: 'Renew membership', category: 'Membership', url: settings.renewalUrl },
                ],
              }
            : {}),
        }
        const cache = { cacheMaxAge: 0, staleRevalidate: 0, staleError: 0 }
        if (resource === 'manifest.json') return addon.manifest
        if (resource === 'poster.png') return reply.type('image/png').send(poster)
        if (resource === 'catalog/movie/membership.json') return { metas: [meta], ...cache }
        if (/^catalog\/movie\/membership\/.+\.json$/.test(resource)) return { metas: [], ...cache }
        if (resource === `meta/movie/${itemId}.json`) return { meta, ...cache }
        if (/^stream\/(movie|series)\/[^/]+\.json$/.test(resource))
          return {
            streams: [
              {
                name: 'Membership expired',
                title: settings.message,
                externalUrl: settings.renewalUrl || `${base}/renew`,
              },
            ],
            ...cache,
          }
        if (resource === 'renew') {
          const escape = (value) =>
            value.replace(
              /[&<>"']/g,
              (character) =>
                ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
            )
          reply.header(
            'content-security-policy',
            "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
          )
          reply.header('x-robots-tag', 'noindex, nofollow').type('text/html; charset=utf-8')
          return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Membership expired</title><style>body{margin:0;background:#101113;color:#f9f9f9;font:18px/1.6 system-ui,sans-serif;display:grid;min-height:100vh;place-items:center}main{max-width:38rem;padding:2rem}h1{color:#f2c20e;font-size:2.5rem;line-height:1.2}p{white-space:pre-wrap;overflow-wrap:anywhere}a{color:#f2c20e}small{color:#b8bbc3}</style><main><small>AIOManager</small><h1>Membership expired</h1><p>${escape(settings.message)}</p>${settings.renewalUrl ? `<a href="${escape(settings.renewalUrl)}" rel="noreferrer noopener">Renew membership</a>` : ''}</main></html>`
        }
        return missing()
      })
    },
    { prefix: '/api/notice' }
  )
}
