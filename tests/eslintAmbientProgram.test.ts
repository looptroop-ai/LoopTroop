import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

/**
 * The lint rule that refuses a program `PATH` gets to choose, run against the
 * spellings it has to catch and the ones it must leave alone.
 *
 * The rule is a list of AST selectors, and a selector that stops matching fails
 * silently — lint just gets quieter. Every bypass a reviewer found is a line
 * here, and so is every legitimate form, so a clause that is lost or widened
 * shows up as a changed set of flagged lines rather than as nothing at all.
 */
const PROBE = [
  "import { spawnSync, execFile, spawn as launch } from 'node:child_process'", // 1  alias
  "import * as childProcess from 'node:child_process'",                        // 2
  "import { promisify } from 'node:util'",                                       // 3
  'const execFileAsync = promisify(execFile)',                                   // 4
  "const IS_WINDOWS = process.platform === 'win32'",                             // 5
  "spawnSync('git', ['status'])",                                                // 6  literal
  "spawnSync(`git`, ['status'])",                                                // 7  template
  "spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'ver'])",                  // 8  logical fallback
  "spawnSync(IS_WINDOWS ? 'npm.cmd' : 'npm', ['-v'])",                           // 9  conditional
  "launch('/usr/bin/true', [])",                                                 // 10 (the alias is caught at 1)
  "execFileAsync('git', ['status'])",                                            // 11 promisified
  "childProcess.execSync('git status')",                                         // 12 namespace exec
  "childProcess.spawnSync('git', [])",                                           // 13 namespace spawn
  "spawnSync('/usr/bin/git', ['status'])",                                       // 14 ok: absolute path
  "spawnSync(`${'/usr/bin'}/git`, ['status'])",                                  // 15 ok: interpolated
  "const db = { exec: (sql) => sql }",                                           // 16
  "db.exec('BEGIN')",                                                            // 17 ok: not a process
  "spawnSync('/bin/sh', ['-c', 'true'], { shell: true })",                       // 18 shell with a literal
  'undefinedHelper()',                                                           // 19 no-undef (.mjs)
  "import * as proc from 'node:child_process'",                                  // 20 namespace alias
  "proc.execSync('git status')",                                                 // 21 (the alias is caught at 20)
  'const run = promisify(execFile)',                                             // 22 promisify alias
  "const worker = { spawn: (job) => job }",                                      // 23
  "worker.spawn('job')",                                                         // 24 ok: not child_process
  "import * as util from 'node:util'",                                           // 25
  'const runLater = util.promisify(childProcess.execFile)',                      // 26 promisify through namespaces
  'const execFileAsync2 = util.promisify(childProcess.exec)',                    // 27 same, any unknown name
  'const execAsync = util.promisify(childProcess.exec)',                         // 28 ok: a name the rule knows
  "import childProcessDefault from 'node:child_process'",                       // 29 default import
  "const dynamicChildProcess = import('node:child_process')",                    // 30 dynamic import
  "import { createRequire } from 'node:module'",                                 // 31 createRequire import
  'const requireFromModule = createRequire(import.meta.url)',                     // 32 createRequire call
  "require('node:child_process')",                                               // 33 direct require
  "import * as moduleApi from 'node:module'",                                    // 34 namespace module API
  'const requireFromNamespace = moduleApi.createRequire(import.meta.url)',         // 35 namespace createRequire
  "import moduleDefault from 'node:module'",                                     // 36 default module API
  'const requireFromDefault = moduleDefault.createRequire(import.meta.url)',        // 37 default createRequire
].join('\n')

async function flaggedLines(filePath: string): Promise<number[]> {
  const eslint = new ESLint()
  const [result] = await eslint.lintText(PROBE, { filePath })
  return [...new Set((result?.messages ?? []).map((message) => message.line))].sort((a, b) => a - b)
}

describe('the ambient-program lint rule', () => {
  it('flags every bypass and nothing legitimate, in a script', async () => {
    expect(await flaggedLines('scripts/__lint-probe.mjs')).toEqual([1, 6, 7, 8, 9, 11, 12, 13, 18, 19, 20, 22, 26, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37])
  })

  it('applies to server code too, where no-undef is left to TypeScript', async () => {
    const lines = await flaggedLines('server/__lint-probe.ts')
    for (const line of [1, 6, 7, 8, 9, 11, 12, 13, 18, 20, 22, 26, 27, 29, 30, 31, 32, 33, 34, 35, 36, 37]) expect(lines).toContain(line)
    for (const line of [14, 15, 17, 24]) expect(lines).not.toContain(line)
  })

  it('leaves test scaffolding alone, which spawns git against fixture repositories by design', async () => {
    const lines = await flaggedLines('server/__tests__/__lint-probe.test.ts')
    for (const line of [6, 7, 8, 9, 11, 12, 13, 18]) expect(lines).not.toContain(line)
  })

  it('keeps the ambient-program guard active in the documented helper exception', async () => {
    expect(await flaggedLines('server/git/github.ts')).toContain(6)
  })
})

const SHARED_HELPER_PROBE = [
  'class FieldHelpers { isRecord = () => true }',
  'class StringFieldHelpers { ["getErrorMessage"] = function () { return "" } }',
  'declare function normalizeString(value: unknown): string | undefined',
  'const objectHelpers = { ["stripAnsiSequences"]: () => "" }',
  'let getErrorMessage: (error: unknown) => string',
  'getErrorMessage = (error) => String(error)',
].join('\n')

async function sharedHelperFlaggedLines(filePath: string): Promise<number[]> {
  const [result] = await new ESLint().lintText(SHARED_HELPER_PROBE, { filePath })
  return [...new Set((result?.messages ?? [])
    .filter((message) => message.ruleId === 'no-restricted-syntax')
    .map((message) => message.line))]
    .sort((a, b) => a - b)
}

describe('the shared-helper lint rule', () => {
  it('catches fields, declarations, string keys, and late let assignments', async () => {
    expect(await sharedHelperFlaggedLines('server/__lint-helper-probe.ts')).toEqual([1, 2, 3, 4, 6])
  })
})
