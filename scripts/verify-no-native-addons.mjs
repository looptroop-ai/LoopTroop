#!/usr/bin/env node
/**
 * Fails if the published production package would pull in a native Node addon.
 *
 * Packing alone proves nothing: the tarball has no node_modules, so transitive
 * native dependencies are invisible. This packs, installs the tarball into a
 * clean directory with production dependencies only, and scans the resolved
 * tree for compiled artefacts.
 *
 * Native addons require a compiler toolchain at install time (the main cause of
 * failed installs) and cannot be bundled into a standalone binary.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const NATIVE_EXTENSIONS = ['.node']
const BUILD_SCRIPT_MARKERS = ['node-gyp', 'prebuild-install', 'node-pre-gyp', 'cmake-js', 'neon', 'cargo']

function run(command, args, cwd) {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function walk(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, onFile)
    else if (entry.isFile()) onFile(full)
  }
}

const repoRoot = process.cwd()
const workDir = mkdtempSync(join(tmpdir(), 'looptroop-native-gate-'))

try {
  console.log('Packing production package...')
  const packOutput = run('npm', ['pack', '--pack-destination', workDir, '--silent'], repoRoot)
  const tarball = join(workDir, packOutput.trim().split('\n').pop().trim())

  console.log(`Installing ${relative(repoRoot, tarball)} into a clean tree...`)
  const installDir = join(workDir, 'install')
  mkdirSync(installDir, { recursive: true })
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'native-gate', private: true }))
  run('npm', ['install', tarball, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installDir)

  const modulesDir = join(installDir, 'node_modules')
  const nativeBinaries = []
  const buildScriptPackages = []

  walk(modulesDir, (file) => {
    if (NATIVE_EXTENSIONS.some((extension) => file.endsWith(extension))) {
      nativeBinaries.push(relative(modulesDir, file))
      return
    }
    if (!file.endsWith('package.json')) return
    try {
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      if (!manifest.name) return
      const label = `${manifest.name}@${manifest.version}`
      const scripts = manifest.scripts ?? {}
      const lifecycle = [scripts.install, scripts.preinstall, scripts.postinstall].filter(Boolean).join(' ')

      if (BUILD_SCRIPT_MARKERS.some((marker) => lifecycle.includes(marker))) {
        buildScriptPackages.push(`${label}: ${lifecycle.trim()}`)
        return
      }

      // better-sqlite3 ships no install script at all: npm compiles it purely
      // because a binding.gyp is present. Checking scripts alone would have
      // missed the very dependency this project removed.
      if (manifest.gypfile === true || existsSync(join(dirname(file), 'binding.gyp'))) {
        buildScriptPackages.push(`${label}: compiled via binding.gyp`)
      }
    } catch {
      // Unparseable manifests are not evidence of a native dependency.
    }
  })

  const packageCount = readdirSync(modulesDir).length
  console.log(`Scanned ${packageCount} top-level entries in the installed tree.`)

  if (nativeBinaries.length > 0 || buildScriptPackages.length > 0) {
    console.error('\nFAIL: the production package pulls in native code.\n')
    if (nativeBinaries.length > 0) {
      console.error('Compiled binaries:')
      for (const binary of nativeBinaries) console.error(`  ${binary}`)
    }
    if (buildScriptPackages.length > 0) {
      console.error('Packages compiling at install time:')
      for (const entry of buildScriptPackages) console.error(`  ${entry}`)
    }
    console.error('\nNative addons require a compiler toolchain on the user\'s machine')
    console.error('and cannot be bundled into a standalone binary.')
    process.exit(1)
  }

  console.log('\nPASS: no native addons in the production package.')
} finally {
  rmSync(workDir, { recursive: true, force: true })
}
