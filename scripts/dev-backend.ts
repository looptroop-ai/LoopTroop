import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWatchPollingDecision } from '../shared/wslPerformance'
import { getBackendPort } from '../shared/appConfig'
import {
  INITIAL_LIVENESS_STATE,
  nextLivenessState,
  resolveGraceMs,
  shouldDeclareDead,
  type LivenessState,
} from './dev-backend-liveness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const binExtension = process.platform === 'win32' ? '.cmd' : ''
const tsxBin = resolve(repoRoot, 'node_modules', '.bin', `tsx${binExtension}`)

const childEnv = { ...process.env }

function isWslRuntime() {
  if (process.platform !== 'linux') return false
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true

  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft')
  } catch {
    return false
  }
}

const pollingDecision = resolveWatchPollingDecision({
  explicitPolling: process.env.CHOKIDAR_USEPOLLING,
  isWsl: isWslRuntime(),
  workspacePath: repoRoot,
})

if (pollingDecision.usePolling) {
  childEnv.CHOKIDAR_USEPOLLING = '1'
} else {
  delete childEnv.CHOKIDAR_USEPOLLING
}
console.log(`[dev-backend] ${pollingDecision.reason}`)

const child = spawn(tsxBin, ['watch', 'server/index.ts'], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: childEnv,
})

child.once('error', (error) => {
  console.error(`[dev-backend] Failed to start backend watcher: ${error.message}`)
  process.exit(1)
})

/**
 * Watches the port the backend is supposed to be listening on.
 *
 * `tsx watch` does not exit when the process it is watching dies — it waits for
 * a file to change, which is what makes it a watcher. So a backend that exits
 * on a fatal error leaves this script, `concurrently`, and any supervisor above
 * it all reporting a healthy stack while nothing is answering. That happened:
 * a backend refused to start on a schema-version guard and the frontend went on
 * serving a dashboard whose every request was refused, for hours.
 *
 * The port is the honest signal. When it stops answering long enough that a
 * restart cannot explain it, this exits non-zero, which is what lets
 * `concurrently`'s killOthersOn and any process supervisor do their jobs.
 */
const backendPort = getBackendPort()
const graceMs = resolveGraceMs()
const probeIntervalMs = 2_000
let liveness: LivenessState = INITIAL_LIVENESS_STATE
let shuttingDown = false

function probeBackendPort(): Promise<boolean> {
  return new Promise((resolveProbe) => {
    // Loopback is correct even when the backend binds 0.0.0.0 for LAN sharing.
    const socket = net.connect({ host: '127.0.0.1', port: backendPort })
    const settle = (reachable: boolean) => {
      socket.destroy()
      resolveProbe(reachable)
    }

    socket.setTimeout(probeIntervalMs)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

const livenessTimer = setInterval(() => {
  if (shuttingDown) return

  void probeBackendPort().then((reachable) => {
    if (shuttingDown) return

    liveness = nextLivenessState(liveness, { reachable, nowMs: Date.now() })
    if (!shouldDeclareDead(liveness, { nowMs: Date.now(), graceMs })) return

    console.error(
      `[dev-backend] The backend has not answered on port ${backendPort} for ${Math.round(graceMs / 1000)}s. `
      + 'It exited and the watcher is still waiting for a file change, so nothing else will notice. '
      + 'Failing so the stack goes down with it — scroll up for the error that killed it.',
    )
    shuttingDown = true
    clearInterval(livenessTimer)
    if (!child.killed) child.kill('SIGTERM')
    process.exit(1)
  })
}, probeIntervalMs)

// The stack is torn down for many ordinary reasons; none of them are the
// backend dying, so the supervisor must stand down first.
livenessTimer.unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shuttingDown = true
    clearInterval(livenessTimer)
    if (!child.killed) {
      child.kill(signal)
    }
  })
}

child.once('exit', (code) => {
  shuttingDown = true
  clearInterval(livenessTimer)
  process.exit(code ?? 0)
})
