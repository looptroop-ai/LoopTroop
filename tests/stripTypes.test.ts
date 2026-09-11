import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'

const verifier = readFileSync(new URL('../scripts/verify-strip-types.mjs', import.meta.url), 'utf8')

function verify(source: string, extra = '') {
  const directory = makeTempDir('looptroop-strip-types-')
  try {
    const script = join(directory, 'verify-strip-types.mjs')
    writeFileSync(script, `${verifier}\n${extra}`)
    writeFileSync(join(directory, 'fixture.ts'), source)
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    return result
  } finally {
    removeTempDir(directory)
  }
}

describe('bare Node TypeScript verification', () => {
  it('accepts erasable types without executing the script or printing the known advisory', () => {
    const result = verify('const value: number = 1; throw new Error("must not execute")')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('PASS: all 1 scripts/*.ts')
    expect(result.stderr).toBe('')
  })

  it.each([
    ['enum', 'enum Value { One }'],
    ['parameter property', 'class Value { constructor(readonly value: string) {} }'],
    ['import equals', 'import fs = require("node:fs")'],
  ])('rejects %s syntax requiring transformation', (_name, source) => {
    const result = verify(source)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('FAIL: these scripts cannot be run by bare node.')
    expect(result.stderr).toContain('scripts/fixture.ts:')
  })

  it('preserves unrelated warnings, including other experimental APIs', () => {
    const result = verify('const value: number = 1', `
      process.emitWarning('stripTypeScriptTypes unrelated experimental warning', 'ExperimentalWarning')
      process.emitWarning('stripTypeScriptTypes unrelated warning', { code: 'TEST_WARNING' })
    `)
    expect(result.status).toBe(0)
    expect(result.stderr).toContain('ExperimentalWarning: stripTypeScriptTypes unrelated experimental warning')
    expect(result.stderr).toContain('[TEST_WARNING] Warning: stripTypeScriptTypes unrelated warning')
    expect(result.stderr).not.toContain('stripTypeScriptTypes is an experimental feature')
  })
})
