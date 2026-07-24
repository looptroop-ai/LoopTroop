import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveWatchPollingDecision } from '../shared/wslPerformance'

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
