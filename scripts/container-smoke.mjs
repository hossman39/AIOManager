import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const image = process.argv[2]
if (!image) throw new Error('Pass the locally built image tag')
let container
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000 }).trim()

async function waitHealthy() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      docker('exec', container, 'node', 'server/healthcheck.js')
      return
    } catch {
      await delay(1000)
    }
  }
  throw new Error('Container did not become healthy')
}

try {
  // No egress and no host data mount: this image cannot contact client services.
  container = docker('run', '--detach', '--network', 'none', '--env', 'DB_TYPE=sqlite', image)
  assert.match(container, /^[a-f0-9]{64}$/)
  await waitHealthy()
  assert.equal(docker('exec', container, 'node', '-p', 'process.getuid()'), '1000')
  const save = `
    const response = await fetch('http://127.0.0.1:1610/api/sync/synthetic-smoke', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-sync-password': 'synthetic-only' },
      body: JSON.stringify({ marker: 'survives-restart' })
    });
    if (response.status !== 200) throw new Error('Synthetic sync save failed');
  `
  docker('exec', container, 'node', '--input-type=module', '-e', save)
  docker('restart', '--time', '30', container)
  await waitHealthy()
  const read = `
    const response = await fetch('http://127.0.0.1:1610/api/sync/synthetic-smoke', {
      headers: { 'x-sync-password': 'synthetic-only' }
    });
    if (response.status !== 200 || (await response.json()).marker !== 'survives-restart') {
      throw new Error('Synthetic sync state was not recovered');
    }
  `
  docker('exec', container, 'node', '--input-type=module', '-e', read)
  console.log('Container smoke passed: non-root, SQLite, encrypted sync, restart, no egress.')
} catch (error) {
  if (container && /^[a-f0-9]{64}$/.test(container)) console.error(docker('logs', container))
  throw error
} finally {
  // Only remove the exact disposable container created above, never a name/glob.
  if (container && /^[a-f0-9]{64}$/.test(container)) docker('rm', '--force', container)
}
