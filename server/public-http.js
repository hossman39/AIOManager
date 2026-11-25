import http from 'node:http'
import https from 'node:https'
import axios from 'axios'
import { pinnedManifestLookup, resolveManifestTarget } from './managed/manifest-network.js'

// All legacy HTTP relays and webhook jobs use the same network boundary as managed manifests.
// Resolve every redirect separately and connect only to the addresses just checked.
export async function publicRequest(
  value,
  { method = 'GET', headers = {}, data, maxBytes = 5 * 1024 ** 2, signal } = {}
) {
  const deadline = AbortSignal.timeout(10000)
  signal = signal ? AbortSignal.any([deadline, signal]) : deadline
  let url = new URL(value)
  for (let hop = 0; hop <= 3; hop++) {
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 16384
    )
      throw new Error('Invalid upstream URL')
    const addresses = await resolveManifestTarget(url, { signal })
    const Agent = url.protocol === 'https:' ? https.Agent : http.Agent
    const agent = new Agent({
      keepAlive: false,
      proxyEnv: {},
      lookup: pinnedManifestLookup(url.hostname.replace(/^\[|\]$/g, ''), addresses),
    })
    try {
      const res = await axios.request({
        url: url.href,
        method,
        headers,
        data,
        signal,
        proxy: false,
        httpAgent: agent,
        httpsAgent: agent,
        maxRedirects: 0,
        timeout: 10000,
        maxContentLength: maxBytes,
        maxBodyLength: 256 * 1024,
        responseType: 'arraybuffer',
        validateStatus: () => true,
      })
      if (
        method !== 'POST' &&
        [301, 302, 303, 307, 308].includes(res.status) &&
        res.headers.location
      ) {
        const next = new URL(res.headers.location, url)
        if (url.protocol === 'https:' && next.protocol !== 'https:')
          throw new Error('Insecure redirect')
        if (next.origin !== url.origin) headers = { Accept: headers.Accept ?? '*/*' }
        url = next
        continue
      }
      const body = method === 'HEAD' || [204, 205, 304].includes(res.status) ? null : res.data
      return new Response(body, {
        status: res.status,
        headers: { 'content-type': res.headers['content-type'] ?? 'application/octet-stream' },
      })
    } finally {
      agent.destroy()
    }
  }
  throw new Error('Too many upstream redirects')
}
