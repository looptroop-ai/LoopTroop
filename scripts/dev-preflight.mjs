/**
 * Lightweight pre-dev hook that ensures dependencies are installed
 * before the TypeScript preflight runs.
 *
 * IMPORTANT: The actual preflight logic lives in scripts/dev-preflight.ts.
 * This file is intentionally minimal (plain JS, no build step required) so
 * that it can run as `npm run predev` before any build tooling is available.
 * It delegates all real work to the TypeScript version via tsx.
 *
 * The duplications of pathExists/isExecutable/getMtimeMs from dev-maintenance.ts
 * are intentional: this file must run before tsx is available, so it cannot
 * import from TypeScript modules. Keep logic changes minimal and in sync.
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { dirname, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')
const isWindows = process.platform === 'win32'
const npmCommand = isWindows ? 'npm.cmd' : 'npm'
const binExtension = isWindows ? '.cmd' : ''

/**
 * Windows `.cmd`/`.bat` shims (npm.cmd, tsx.cmd, ...) are batch scripts that
 * can only run via cmd.exe. Since the BatBadBut fix (Node 18.20.2/20.12.2/21+),
 * spawnSync refuses to launch them directly and throws EINVAL. Routing through
 * the shell fixes that, but `shell: true` re-parses the command line, so any
 * argument containing whitespace or shell metacharacters must be quoted.
 */
function quoteForShell(value) {
  return isWindows && /[\s&|<>^()"]/.test(value) ? `"${value}"` : value
}

function spawnViaShell(command, args, options) {
  return spawnSync(quoteForShell(command), args.map(quoteForShell), {
    ...options,
    shell: isWindows,
  })
}
const tsxBin = resolve(repoRoot, 'node_modules', '.bin', `tsx${binExtension}`)
const installStamp = resolve(repoRoot, 'node_modules', '.package-lock.json')
const npmInstallFlags = ['--no-fund', '--no-audit']
const trackedManifests = [
  resolve(repoRoot, 'package.json'),
  resolve(repoRoot, 'package-lock.json'),
]

function pathExists(filePath) {
  try { accessSync(filePath, constants.F_OK); return true } catch { return false }
}

function getMtimeMs(filePath) {
  try { return statSync(filePath).mtimeMs } catch { return null }
}

function isExecutable(filePath) {
  try { accessSync(filePath, constants.X_OK); return true } catch { return false }
}

console.log('[dev-preflight] Preparing LoopTroop dev startup preflight.')

const reasons = []

if (!pathExists(resolve(repoRoot, 'node_modules'))) {
  reasons.push('node_modules is missing')
} else if (!pathExists(installStamp)) {
  reasons.push('the npm install stamp is missing')
} else {
  const stampMtime = getMtimeMs(installStamp)
  if (stampMtime !== null) {
    for (const manifest of trackedManifests) {
      const manifestMtime = getMtimeMs(manifest)
      if (manifestMtime !== null && manifestMtime > stampMtime) {
        reasons.push(`${basename(manifest)} changed after the last npm install`)
      }
    }
  }
}

const requiredBins = ['tsx', 'vite', 'concurrently']
const missingBins = requiredBins.filter(name => {
  const binPath = resolve(repoRoot, 'node_modules', '.bin', `${name}${binExtension}`)
  return !isExecutable(binPath)
})

if (missingBins.length > 0) {
  reasons.push(`missing local dev binaries: ${missingBins.join(', ')}`)
}

if (reasons.length > 0) {
  console.log('[dev-preflight] Running npm ci before starting dev:')
  for (const reason of reasons) {
    console.log(`[dev-preflight] - ${reason}`)
  }

  const result = spawnViaShell(npmCommand, ['ci', ...npmInstallFlags], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  })

  if (result.error) {
    console.error(`[dev-preflight] Failed to start npm ci: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join('\n')
      .trim()
    if (output) {
      console.error(output)
    }
    process.exit(result.status ?? 1)
  }
} else {
  console.log('[dev-preflight] Bootstrap dependencies are ready.')
}

const stillMissing = requiredBins.filter(name => {
  const binPath = resolve(repoRoot, 'node_modules', '.bin', `${name}${binExtension}`)
  return !isExecutable(binPath)
})

if (stillMissing.length > 0) {
  console.error(
    '[dev-preflight] Required dev tools are still missing after npm ci: ' +
    stillMissing.join(', '),
  )
  process.exit(1)
}

if (reasons.length > 0) {
  console.log('[dev-preflight] Dependency bootstrap completed.')
}

// Delegate to the TypeScript preflight for all other checks
console.log('[dev-preflight] Running startup maintenance, process cleanup, and port checks.')
const result = spawnViaShell(tsxBin, [resolve(repoRoot, 'scripts', 'dev-preflight.ts')], {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (result.error) {
  console.error(`[dev-preflight] Failed to start TypeScript preflight: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 0)
