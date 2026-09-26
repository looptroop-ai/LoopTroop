import { appendFileSync, chmodSync, copyFileSync, readFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// npm ci verifies the committed integrity hashes and creates the platform shims.
// Only the native-binary copy normally performed by postinstall is needed here.
const tool = process.argv[2]
if (!['bun', 'pnpm', 'yarn', 'opencode-v1', 'opencode-v2'].includes(tool)) {
  throw new Error(`Unknown CI tool: ${tool}`)
}
const root = join(dirname(fileURLToPath(import.meta.url)), 'ci-tools', tool)
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
  for (const target of Object.values(installed.bin)) {
    copyFileSync(source, join(packageRoot, target))
    chmodSync(join(packageRoot, target), 0o755)
  }
}

const bin = join(root, 'node_modules', '.bin')
if (!process.env.GITHUB_PATH || !process.env.GITHUB_ENV) throw new Error('GitHub Actions environment files are required')
appendFileSync(process.env.GITHUB_PATH, `${bin}\n`)
// The smoke driver deliberately rejects arbitrary executables from a checkout.
// Trust only this integrity-checked package's shims and binary directory.
const trusted = [process.env.LOOPTROOP_TRUSTED_EXECUTABLE_DIRS, bin, join(packageRoot, 'bin')].filter(Boolean)
appendFileSync(process.env.GITHUB_ENV, `LOOPTROOP_TRUSTED_EXECUTABLE_DIRS=${trusted.join(delimiter)}\n`)
console.log(`${name}@${installed.version} ready at ${bin}`)
