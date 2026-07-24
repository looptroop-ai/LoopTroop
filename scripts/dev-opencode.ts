import { spawn } from 'node:child_process'
import { DEFAULT_OPENCODE_BASE_URL } from '../shared/appConfig'
import { getErrorMessage } from '../shared/typeGuards'
import { resolveOpenCodeBaseUrl } from './opencode-dev-base-url'
import { resolveOpenCodeLogMode } from './opencode-log-mode'
import { withManagedOpenCodeServerEnv } from './opencode-permission-env'
import { LOOPTROOP_OPENCODE_ROUTING_CONFIG } from '../shared/openRouterRouting'

const requestedBaseUrl = process.env.LOOPTROOP_OPENCODE_BASE_URL?.trim() || DEFAULT_OPENCODE_BASE_URL
const hasExplicitBaseUrl = Boolean(process.env.LOOPTROOP_OPENCODE_BASE_URL?.trim())
const opencodeLogMode = (() => {
  try {
    return resolveOpenCodeLogMode()
  } catch (error) {
    console.error(`[dev-opencode] ${getErrorMessage(error)}`)
    process.exit(1)
  }
})()

const { baseUrl, note, status } = await resolveOpenCodeBaseUrl({
  requestedBaseUrl,
  hasExplicitBaseUrl,
  mockMode: process.env.LOOPTROOP_OPENCODE_MODE === 'mock',
})

if (note) {
  console.log(`[dev-opencode] ${note}`)
}

if (status !== 'ready-to-start') {
  if (opencodeLogMode.mode === 'all') {
    console.log(
      '[dev-opencode] OpenCode all-log mode requested, but this watcher is not starting OpenCode; ' +
      'configure the existing OpenCode server logs separately.',
    )
  }
  process.exit(0)
}

const url = new URL(baseUrl)
const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))

const serveHostname = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
console.log(`[dev-opencode] Checking OpenCode availability at ${baseUrl}.`)
console.log(`[dev-opencode] Starting OpenCode on ${serveHostname}:${port}.`)
if (opencodeLogMode.mode === 'all') {
  console.log('[dev-opencode] Printing managed OpenCode DEBUG logs to stderr.')
}

const managedServerEnv = withManagedOpenCodeServerEnv(process.env)
if (!managedServerEnv.OPENCODE_CONFIG?.trim()) {
  const routingConfigPath = process.env[LOOPTROOP_OPENCODE_ROUTING_CONFIG]?.trim()
  if (routingConfigPath) {
    managedServerEnv.OPENCODE_CONFIG = routingConfigPath
  }
}

const child = spawn('opencode', ['serve', ...opencodeLogMode.serveArgs, '--hostname', serveHostname, '--port', String(port)], {
  stdio: 'inherit',
  env: managedServerEnv,
})

child.once('error', (error) => {
  console.error(`[dev-opencode] Failed to start OpenCode: ${error.message}`)
  process.exit(1)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal)
    }
  })
}

child.once('exit', (code) => {
  process.exit(code ?? 0)
})
