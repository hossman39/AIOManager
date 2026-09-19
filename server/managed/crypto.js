import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { ManagedError } from './errors.js'

const MAX_BYTES = 12 * 1024 * 1024

/** Canonical JSON without lossy undefined/nonfinite values or executable objects. */
export function canonicalJson(value, depth = 0) {
  if (depth > 100) throw new ManagedError('INVALID_INPUT')
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value))
    return `[${Array.from(value, (entry) => canonicalJson(entry, depth + 1)).join(',')}]`
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], depth + 1)}`)
      .join(',')}}`
  }
  throw new ManagedError('INVALID_INPUT')
}

export function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return timingSafeEqual(
    createHash('sha256').update(left).digest(),
    createHash('sha256').update(right).digest()
  )
}

function aad(context) {
  if (
    !context ||
    ['owner', 'id', 'purpose'].some(
      (key) => typeof context[key] !== 'string' || !context[key] || context[key].length > 256
    )
  ) {
    throw new ManagedError('INVALID_INPUT')
  }
  return Buffer.from(
    JSON.stringify(['aiomanager.managed', 1, context.owner, context.id, context.purpose])
  )
}

function decode(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('encoding')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value || (length !== undefined && bytes.length !== length))
    throw new Error('length')
  return bytes
}

/** Strict format: never interpret an unrecognized envelope as plaintext. */
export function createEnvelopeCrypto({ primary, candidates = [] }) {
  const keys = new Map()
  for (const secret of [...new Set([primary, ...candidates])]) {
    if (typeof secret !== 'string' || !secret) throw new ManagedError('DATA_UNREADABLE')
    const key = Buffer.from(
      hkdfSync('sha256', secret, 'AIOManager managed records v1', 'encryption', 32)
    )
    const kid = createHash('sha256').update(key).digest('hex')
    keys.set(kid, key)
  }
  const primaryId = keys.keys().next().value
  return Object.freeze({
    seal(value, context) {
      const plaintext = canonicalJson(value)
      if (Buffer.byteLength(plaintext) > MAX_BYTES) throw new ManagedError('INVALID_INPUT')
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', keys.get(primaryId), iv)
      cipher.setAAD(aad(context))
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return JSON.stringify({
        v: 1,
        kid: primaryId,
        iv: iv.toString('base64url'),
        ct: ciphertext.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
      })
    },
    open(serialized, context) {
      try {
        if (typeof serialized !== 'string' || serialized.length > MAX_BYTES * 2)
          throw new Error('size')
        const envelope = JSON.parse(serialized)
        if (
          !envelope ||
          Object.keys(envelope).sort().join(',') !== 'ct,iv,kid,tag,v' ||
          envelope.v !== 1 ||
          !keys.has(envelope.kid)
        )
          throw new Error('format')
        const decipher = createDecipheriv(
          'aes-256-gcm',
          keys.get(envelope.kid),
          decode(envelope.iv, 12)
        )
        decipher.setAAD(aad(context))
        decipher.setAuthTag(decode(envelope.tag, 16))
        const plaintext = Buffer.concat([decipher.update(decode(envelope.ct)), decipher.final()])
        if (plaintext.length > MAX_BYTES) throw new Error('size')
        return JSON.parse(plaintext.toString('utf8'))
      } catch {
        throw new ManagedError('DATA_UNREADABLE')
      }
    },
  })
}

const indexContext = { owner: 'deployment', id: 'index-key', purpose: 'keyring' }

/** Called after migrations. A stable wrapped random key prevents index drift on rotation. */
export async function initializeManagedCrypto(db, keyOptions) {
  const envelopes = createEnvelopeCrypto(keyOptions)
  const indexKey = await db.transaction(async (tx) => {
    if (tx.type === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(804160, 2)')
    const row = await tx.get('SELECT secret_blob FROM managed_metadata WHERE id = 1')
    if (row) {
      const material = envelopes.open(row.secret_blob, indexContext)
      if (material?.version !== 1 || !/^[a-f0-9]{64}$/.test(material.indexKey))
        throw new ManagedError('DATA_UNREADABLE')
      return Buffer.from(material.indexKey, 'hex')
    }
    // Even a lost metadata row must not silently create different lookup indexes.
    if (await tx.get('SELECT 1 AS present FROM managed_owners LIMIT 1'))
      throw new ManagedError('DATA_UNREADABLE')
    const key = randomBytes(32)
    await tx.run(
      'INSERT INTO managed_metadata (id, secret_blob, write_paused, version) VALUES (1, $1, 1, 1)',
      [envelopes.seal({ version: 1, indexKey: key.toString('hex') }, indexContext)]
    )
    return key
  })
  return Object.freeze({
    ...envelopes,
    fingerprint(value, context) {
      return createHmac('sha256', indexKey)
        .update(aad(context))
        .update('\0')
        .update(canonicalJson(value))
        .digest('hex')
    },
  })
}
