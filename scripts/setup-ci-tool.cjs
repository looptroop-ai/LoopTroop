const { appendFileSync, chmodSync, copyFileSync, readFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')

// npm ci verifies the committed integrity hashes and creates the platform shims.
// Only the native-binary copy normally performed by postinstall is needed here.
const tool = process.argv[2]
if (!['bun', 'pnpm', 'yarn', 'opencode-v1', 'opencode-v2'].includes(tool)) {
  throw new Error(`Unknown CI tool: ${tool}`)
}
const root = join(__dirname, 'ci-tools', tool)
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const [name] = Object.keys(manifest.dependencies)
const packageRoot = join(root, 'node_modules', name)
const installed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
if (installed.version !== manifest.dependencies[name]) throw new Error(`Unexpected ${name} version`)

if (tool === 'bun' || tool.startsWith('opencode-')) {
  const platform = process.platform === 'win32' ? 'windows' : process.platform
  const arch = tool === 'bun' && process.arch === 'arm64' ? 'aarch64' : process.arch
  // Baseline x64 binaries work on runners without AVX2. These CI jobs use glibc.
  const suffix = `${platform}-${arch}${process.arch === 'x64' ? '-baseline' : ''}`
  const nativeName = Object.keys(installed.optionalDependencies).find((dependency) => dependency.endsWith(`-${suffix}`))
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
    throw new Error(`${name} --version failed: ${probe.error?.message ?? probe.stderr ?? probe.signal ?? probe.status}`)
  }
}

// Keep Bun's native Windows PATH layout. OpenCode keeps its npm shim so the
// Windows smoke still covers .cmd launches.
const bin = tool === 'bun' && process.platform === 'win32'
  ? join(packageRoot, 'bin')
  : join(root, 'node_modules', '.bin')
if (!process.env.GITHUB_PATH) throw new Error('GITHUB_PATH is required')
appendFileSync(process.env.GITHUB_PATH, `${bin}\n`)
console.log(`${name}@${installed.version} ready at ${bin}`)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- CI tool: ${name}@${installed.version}\n`)
}
