import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { doctorCommand, runChecks } from '../server/cli/doctorCommand'

/**
 * 2.12 contract: doctor tells a user whether this machine can run LoopTroop,
 * names a remedy for anything wrong, and emits only JSON on stdout under --json
 * so its output can be piped into a parser.
 */
describe('doctor command', () => {
  const tempDirs: string[] = []
  const previousConfigDir = process.env.LOOPTROOP_CONFIG_DIR
  const previousMode = process.env.LOOPTROOP_OPENCODE_MODE

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of tempDirs.splice(0)) {
      try {
        chmodSync(dir, 0o700)
      } catch {
        // Already removable.
      }
      rmSync(dir, { recursive: true, force: true })
    }
    if (previousConfigDir === undefined) delete process.env.LOOPTROOP_CONFIG_DIR
    else process.env.LOOPTROOP_CONFIG_DIR = previousConfigDir
    if (previousMode === undefined) delete process.env.LOOPTROOP_OPENCODE_MODE
    else process.env.LOOPTROOP_OPENCODE_MODE = previousMode
  })

  function useConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-doctor-'))
    tempDirs.push(dir)
    process.env.LOOPTROOP_CONFIG_DIR = dir
    process.env.LOOPTROOP_OPENCODE_MODE = 'mock'
    return dir
  }

  function captureStdout(): { text: () => string } {
    let captured = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
    return { text: () => captured }
  }

  it('reports on the runtime, tooling, config and services', async () => {
    useConfigDir()

    const names = (await runChecks()).map((check) => check.name)

    expect(names).toContain('node')
    expect(names).toContain('git')
    expect(names).toContain('config dir')
    expect(names).toContain('schema')
    expect(names).toContain('opencode')
    expect(names).toContain('daemon')
  })

  it('treats a missing database as healthy rather than a fault', async () => {
    useConfigDir()

    const schema = (await runChecks()).find((check) => check.name === 'schema')

    expect(schema?.status).toBe('ok')
    expect(schema?.detail).toContain('no database')
  })

  it('emits only valid JSON on stdout under --json', async () => {
    useConfigDir()
    const stdout = captureStdout()

    await doctorCommand(true)

    // Any stray human-readable line would break a caller parsing this.
    const parsed = JSON.parse(stdout.text()) as { ok: boolean; checks: unknown[] }
    expect(typeof parsed.ok).toBe('boolean')
    expect(Array.isArray(parsed.checks)).toBe(true)
  })

  it('exits zero when nothing is failing', async () => {
    useConfigDir()
    captureStdout()

    const checks = await runChecks()
    const anyFailing = checks.some((check) => check.status === 'fail')
    const code = await doctorCommand(false)

    expect(code).toBe(anyFailing ? 1 : 0)
  })

  it('attaches a remedy to anything that is not ok', async () => {
    useConfigDir()

    for (const check of await runChecks()) {
      if (check.status === 'ok') continue
      expect(check.remedy, `${check.name} reported ${check.status} without a remedy`).toBeTruthy()
    }
  })

  it('treats mock OpenCode as healthy so a machine without it can still be checked', async () => {
    useConfigDir()

    const opencode = (await runChecks()).find((check) => check.name === 'opencode')

    expect(opencode?.status).toBe('ok')
    expect(opencode?.detail).toContain('mock')
  })

  it('prints a human summary without --json', async () => {
    useConfigDir()
    const stdout = captureStdout()

    await doctorCommand(false)

    expect(stdout.text()).toMatch(/can run LoopTroop|cannot run/)
  })
})
