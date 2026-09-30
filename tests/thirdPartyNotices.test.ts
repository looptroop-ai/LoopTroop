import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, describe, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'

const generator = fileURLToPath(new URL('../scripts/generate-third-party-notices.mjs', import.meta.url))

type DependencyTree = { dependencies?: Record<string, { version?: string; missing?: boolean; extraneous?: boolean; dependencies?: DependencyTree['dependencies'] }> }

interface Fixture {
  root: string
  state: string
  npmStub: string
}

function createFixture(options: { bundle?: string[]; packages?: Record<string, { version: string; license?: string; licenseText?: string }>; tree?: DependencyTree } = {}): Fixture {
  const root = makeTempDir('looptroop-third-party-notices-')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const state = join(root, 'npm-state.json')
  const tree = options.tree ?? {
    dependencies: {
      'runtime-lib': { version: '2.0.0', dependencies: { 'transitive-lib': { version: '1.1.0' } } },
    },
  }

  for (const [name, pkg] of Object.entries(options.packages ?? {
    'runtime-lib': { version: '2.0.0', license: 'MIT', licenseText: 'MIT runtime licence\nCopyright (c) 2025 Runtime Author' },
    'transitive-lib': { version: '1.1.0', license: 'Apache-2.0', licenseText: 'Apache transitive licence\nCopyright (c) 2024 Transitive Author' },
    'frontend-lib': { version: '3.2.0', license: 'ISC', licenseText: 'ISC frontend licence\nCopyright (c) 2023 Frontend Author' },
  })) {
    const dir = join(root, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, ...pkg }))
    if (pkg.licenseText) writeFileSync(join(dir, 'LICENSE'), pkg.licenseText)
  }

  if (options.bundle !== undefined) {
    const manifest = join(root, 'dist', 'client')
    mkdirSync(manifest, { recursive: true })
    writeFileSync(join(manifest, 'bundled-packages.json'), JSON.stringify(options.bundle))
  }

  writeFileSync(state, JSON.stringify({ calls: [] as string[][] }))
  // On Windows, a batch file expands `%NAME%` even inside quotes. Keeping the
  // stub under a percent-delimited path makes the env-based invocation below
  // exercise that edge on every Windows run.
  const npmStubDir = process.platform === 'win32'
    ? join(root, '%LOOPTROOP_TEST_STUB_PATH%')
    : root
  mkdirSync(npmStubDir, { recursive: true })
  const npmStub = join(npmStubDir, 'npm-stub.cjs')
  writeFileSync(npmStub, `
const fs = require('node:fs')
const statePath = process.env.NOTICE_TEST_STATE
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
state.calls.push(process.argv.slice(2))
fs.writeFileSync(statePath, JSON.stringify(state))
process.stdout.write(${JSON.stringify(JSON.stringify(tree))})
`)
  const posixQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  writeFileSync(join(bin, process.platform === 'win32' ? 'npm.cmd' : 'npm'), process.platform === 'win32'
    ? '@echo off\r\n"%NOTICE_TEST_NODE%" "%NOTICE_TEST_NPM_STUB%" %*\r\n'
    : `#!/bin/sh\nexec ${posixQuote(process.execPath)} ${posixQuote(npmStub)} "$@"\n`, { mode: 0o755 })

  return { root, state, npmStub }
}

function run(fixture: Fixture, ...args: string[]) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const normalized = key.toUpperCase()
    return normalized !== 'PATH'
      && !(process.platform === 'win32' && normalized === 'LOOPTROOP_TEST_STUB_PATH')
  }))
  const result = spawnSync(process.execPath, [generator, ...args], {
    cwd: fixture.root,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...env,
      PATH: join(fixture.root, 'bin'),
      LOOPTROOP_TRUSTED_EXECUTABLE_DIRS: join(fixture.root, 'bin'),
      NOTICE_TEST_STATE: fixture.state,
      ...(process.platform === 'win32' ? {
        NOTICE_TEST_NODE: process.execPath,
        NOTICE_TEST_NPM_STUB: fixture.npmStub,
      } : {}),
    },
  })
  expect(result.error).toBeUndefined()
  return result
}

function calls(fixture: Fixture): string[][] {
  return JSON.parse(readFileSync(fixture.state, 'utf8')).calls as string[][]
}

describe('third-party notice generator', () => {
  it('combines the complete runtime npm tree with bundled frontend packages', () => {
    const fixture = createFixture({ bundle: ['frontend-lib', 'runtime-lib'] })
    try {
      const result = run(fixture)

      expect(result.status, result.stderr).toBe(0)
      const notices = readFileSync(join(fixture.root, 'THIRD-PARTY-NOTICES.md'), 'utf8')
      expect(notices).toContain('| `runtime-lib` | 2.0.0 | MIT | Copyright (c) 2025 Runtime Author |')
      expect(notices).toContain('| `transitive-lib` | 1.1.0 | Apache-2.0 | Copyright (c) 2024 Transitive Author |')
      expect(notices).toContain('| `frontend-lib` | 3.2.0 | ISC | Copyright (c) 2023 Frontend Author |')
      expect(notices.match(/\| `runtime-lib` \|/g)).toHaveLength(1)
      expect(calls(fixture)).toEqual([['ls', '--omit=dev', '--all', '--json']])
    } finally {
      removeTempDir(fixture.root)
    }
  })

  it('accepts current generated output in --check mode', () => {
    const fixture = createFixture({ bundle: ['frontend-lib'] })
    try {
      expect(run(fixture).status).toBe(0)
      const result = run(fixture, '--check')

      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('matches the redistributed package set')
    } finally {
      removeTempDir(fixture.root)
    }
  })

  it('fails --check when the committed notice file is stale', () => {
    const fixture = createFixture({ bundle: ['frontend-lib'] })
    try {
      expect(run(fixture).status).toBe(0)
      writeFileSync(join(fixture.root, 'THIRD-PARTY-NOTICES.md'), 'stale output\n')

      const result = run(fixture, '--check')

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('THIRD-PARTY-NOTICES.md is out of date.')
      expect(result.stderr).toContain('npm run licenses:generate')
    } finally {
      removeTempDir(fixture.root)
    }
  })

  it('fails when a redistributed package does not declare a licence', () => {
    const fixture = createFixture({
      bundle: [],
      packages: { 'unknown-lib': { version: '1.0.0' } },
      tree: { dependencies: { 'unknown-lib': { version: '1.0.0' } } },
    })
    try {
      const result = run(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('unknown-lib@1.0.0')
      expect(result.stderr).toContain('A redistributed package must declare a licence.')
      expect(existsSync(join(fixture.root, 'THIRD-PARTY-NOTICES.md'))).toBe(false)
    } finally {
      removeTempDir(fixture.root)
    }
  })

  it('fails before npm runs when the bundled-package manifest is missing', () => {
    const fixture = createFixture()
    try {
      const result = run(fixture)

      expect(result.status, result.stderr).toBe(1)
      expect(result.stderr).toMatch(/dist[/\\]client[/\\]bundled-packages\.json is missing\./)
      expect(result.stderr).toContain('Run `npm run build` first')
      expect(calls(fixture)).toEqual([])
    } finally {
      removeTempDir(fixture.root)
    }
  })

  it('fails when the bundle manifest names a package that is no longer installed', () => {
    const fixture = createFixture({ bundle: ['removed-frontend-lib'] })
    try {
      const result = run(fixture)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('bundled package "removed-frontend-lib" is not installed.')
      expect(result.stderr).toContain('npm run build:client')
      expect(calls(fixture)).toEqual([['ls', '--omit=dev', '--all', '--json']])
    } finally {
      removeTempDir(fixture.root)
    }
  })
})
