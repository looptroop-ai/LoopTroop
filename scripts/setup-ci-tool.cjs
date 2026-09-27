const { appendFileSync, chmodSync, copyFileSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

// npm ci verifies the committed integrity hashes and creates the platform shims.
// Only the native-binary copy normally performed by postinstall is needed here.
const tool = process.argv[2]
if (!['bun', 'pnpm', 'yarn', 'opencode-v1', 'opencode-v2'].includes(tool)) {
  throw new Error(`Unknown CI tool: ${tool}`)
}
const root = join(__dirname, 'ci-tools', tool)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const [packageName] = Object.keys(manifest.dependencies)
const packageRoot = join(root, 'node_modules', packageName)
const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
if (installed.version !== manifest.dependencies[packageName]) throw new Error(`Unexpected ${packageName} version`)

if (tool === 'bun' || tool.startsWith('opencode-')) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = tool === 'bun' && process.arch === 'arm64' ? 'aarch64' : process.arch
  // Prefer baseline x64 binaries when available. Bun 1.4 ships one x64 binary.
  const suffix = `${platform}-${arch}${process.arch === 'x64' ? '-baseline' : ''}`
  const dependencies = Object.keys(installed.optionalDependencies)
  const nativeName = dependencies.find((dependency) => dependency.endsWith(`-${suffix}`))
    ?? (tool === 'bun' && process.arch === 'x64'
      ? dependencies.find((dependency) => dependency.endsWith(`-${platform}-${arch}`))
      : undefined)
  if (!nativeName) throw new Error(`No reviewed native package for ${tool} on ${suffix}`)
  const binary = `${tool === 'bun' ? 'bun' : 'opencode'}${process.platform === 'win32' ? '.exe' : ''}`
  const source = join(root, 'node_modules', nativeName, 'bin', binary)
  const targets = [...new Set(Object.values(installed.bin))]
  for (const target of targets) {
    copyFileSync(source, join(packageRoot, target))
    chmodSync(join(packageRoot, target), 0o755)
  }
  const probe = spawnSync(join(packageRoot, targets[0]), ['--version'], { encoding: 'utf8', timeout: 30_000 })
  if (probe.error || probe.status !== 0) {
    throw new Error(`${packageName} --version failed: ${probe.error?.message ?? probe.stderr ?? probe.signal ?? probe.status}`)
  }
}

// Keep Bun's native Windows PATH layout. OpenCode keeps its npm shim so the
// Windows smoke still covers .cmd launches.
let bin = join(root, 'node_modules', '.bin')
if (process.platform === 'win32' && tool === 'bun') bin = join(packageRoot, 'bin')
if (process.platform === 'win32' && tool === 'pnpm') {
  const nativeName = `@pnpm/exe.win32-${process.arch}`
  if (installed.optionalDependencies?.[nativeName] !== installed.version) {
    throw new Error(`No reviewed native package for ${tool} on win32-${process.arch}`)
  }
  // pnpm 12's npm shim targets a shell placeholder when install scripts are disabled.
  bin = join(root, 'node_modules', nativeName)
  const probe = spawnSync(join(bin, 'pnpm.exe'), ['--version'], { cwd: tmpdir(), encoding: 'utf8', timeout: 30_000 })
  if (probe.error || probe.status !== 0 || probe.stdout.trim() !== installed.version) {
    throw new Error(`pnpm --version failed: ${probe.error?.message ?? probe.stderr ?? probe.signal ?? probe.status}`)
  }
}
if (!process.env.GITHUB_PATH) throw new Error('GITHUB_PATH is required')
appendFileSync(process.env.GITHUB_PATH, `${bin}\n`)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- CI tool: ${packageName}@${installed.version}\n`)
}
