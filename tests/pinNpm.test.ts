import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTempDir } from '../server/test/tempDir'

const script = resolve('scripts/pin-npm.mjs')
const declared = JSON.parse(readFileSync('package.json', 'utf8')).packageManager.slice(4) as string
const install = ['install', '--global', '--ignore-scripts', `npm@${declared}`]

function run(current: string, options: { installed?: string, exitCode?: number, mode?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-npm-fixture-'))
  try {
    const statePath = join(dir, 'state.json')
    writeFileSync(statePath, JSON.stringify({ current, installed: options.installed ?? declared, exitCode: options.exitCode ?? 0, calls: [] }))
    const mock = join(dir, 'npm.cjs')
    writeFileSync(mock, `
const fs = require('node:fs')
const path = process.env.NPM_FIXTURE_STATE
const state = JSON.parse(fs.readFileSync(path, 'utf8'))
const args = process.argv.slice(2)
state.calls.push(args)
if (args[0] === '--version') console.log(state.current)
else if (args[0] === 'install' && state.exitCode === 0) state.current = state.installed
fs.writeFileSync(path, JSON.stringify(state))
process.exit(args[0] === 'install' ? state.exitCode : 0)
`)
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    writeFileSync(join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm'), process.platform === 'win32'
      ? `@echo off\r\n"${process.execPath}" "${mock}" %*\r\n`
      : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mock)} "$@"\n`, { mode: 0o755 })
    // Keep real npm off PATH: this test can only change its JSON fixture.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
    const result = spawnSync(process.execPath, [script, options.mode ?? '--prefer-bundled'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...env, PATH: dir, LOOPTROOP_TRUSTED_EXECUTABLE_DIRS: dir, NPM_FIXTURE_STATE: statePath },
    })
    expect(result.error).toBeUndefined()
    const calls = JSON.parse(readFileSync(statePath, 'utf8')).calls as string[][]
    return { ...result, calls }
  } finally {
    removeTempDir(dir)
  }
}

describe('npm selection before dependency installation', () => {
  it('keeps a bundled npm 12 even when its version differs from the repository pin', () => {
    const result = run('12.99.99')
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toEqual([['--version']])
    expect(result.stdout).toContain('12.99.99')
  })

  it.each(['11.19.1', '13.0.0'])('replaces unsupported bundled npm %s and verifies the replacement', (current) => {
    const result = run(current)
    expect(result.status, result.stderr).toBe(0)
    expect(result.calls).toEqual([['--version'], install, ['--version']])
    expect(result.stdout).toContain(`::warning::Bundled npm ${current}`)
    expect(result.stdout).toContain(`npm ${declared} is active`)
  })

  it('fails if installing the supported npm fails', () => {
    const result = run('11.19.1', { exitCode: 7 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('exited 7')
    expect(result.calls).toEqual([['--version'], install])
  })

  it('fails if the old npm remains active after installation', () => {
    const result = run('11.19.1', { installed: '11.19.1' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`Expected npm ${declared}`)
    expect(result.calls).toEqual([['--version'], install, ['--version']])
  })

  it('keeps check-policy read-only and refuses unsupported npm', () => {
    const result = run('11.19.1', { mode: '--check-policy' })
    expect(result.status).toBe(1)
    expect(result.calls).toEqual([['--version']])
  })
})
