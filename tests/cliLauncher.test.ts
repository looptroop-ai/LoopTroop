import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const LAUNCHER = resolve(process.cwd(), 'server/cli/launcher.cjs')

/** The guard half of the launcher, with the shebang stripped so `node -e` accepts it. */
function readGuardSource(): string {
  const source = readFileSync(LAUNCHER, 'utf8')
  const guard = source.split("import('./cli.js')")[0] ?? ''
  return guard.replace(/^#![^\n]*\n/, '')
}

function runGuard(nodeVersion: string, trailer = ''): { stdout: string; stderr: string; exitCode: number } {
  const script = [
    `Object.defineProperty(process.versions, "node", { value: "${nodeVersion}", configurable: true });`,
    readGuardSource(),
    trailer,
  ].join('\n')

  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.status ?? 0 }
  }
}

/**
 * 2.9 contract: the bin entry must run on a Node too old to parse the real CLI,
 * so it stays ES5 CommonJS and checks the version before importing anything.
 */
describe('cli launcher', () => {
  it('exists at the path package.json points bin at', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
    }

    expect(manifest.bin?.looptroop).toBe('dist/server/cli/launcher.cjs')
    expect(existsSync(LAUNCHER)).toBe(true)
  })

  it('starts with a shebang so a shell can execute it directly', () => {
    const source = readFileSync(LAUNCHER, 'utf8')
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('parses under an ES5 syntax target', () => {
    const source = readFileSync(LAUNCHER, 'utf8')

    // A version check that cannot be parsed by the runtime it is guarding would
    // produce a SyntaxError instead of the intended message.
    expect(source).not.toMatch(/\bconst\b|\blet\b|=>|\?\?|\?\./)
    expect(source).toMatch(/\bvar\b/)
  })

  it('rejects an unsupported runtime before importing the CLI', () => {
    const result = runGuard('22.9.0')

    expect(result.exitCode).toBe(1)
    // The guard compares major and minor only — it is ES5 and dependency-free
    // by design, so it cannot parse a full semver range. Its label is therefore
    // the floor's major.minor with a zero patch, which is what it prints here
    // even when engines names a patch release. npm enforces the exact floor.
    expect(result.stderr).toContain('requires Node.js 24.18.0 or newer')
    expect(result.stderr).toContain('22.9.0')
  })

  it('accepts a supported runtime', () => {
    expect(runGuard('24.18.1', 'process.stdout.write("passed");').stdout).toBe('passed')
  })

  it('accepts a newer major', () => {
    expect(runGuard('26.0.0', 'process.stdout.write("passed");').stdout).toBe('passed')
  })

  it('rejects a same-major but older minor', () => {
    expect(runGuard('24.14.0').exitCode).toBe(1)
  })
})
