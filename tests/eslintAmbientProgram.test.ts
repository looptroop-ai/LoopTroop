import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

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
  "childProcess['spawnSync']('git', [])",                                       // 14 computed namespace spawn
  "spawnSync('/usr/bin/git', ['status'])",                                       // 15 ok: absolute path
  "spawnSync(`${'/usr/bin'}/git`, ['status'])",                                  // 16 ok: interpolated
  "const db = { exec: (sql) => sql }",                                           // 17
  "db.exec('BEGIN')",                                                            // 18 ok: not a process
  "spawnSync('/bin/sh', ['-c', 'true'], { shell: true })",                       // 19 shell with a literal
  "spawnSync('/bin/sh', ['-c', 'true'], { ['shell']: true })",                   // 20 computed shell key
  'undefinedHelper()',                                                           // 21 no-undef (.mjs)
  "import * as proc from 'node:child_process'",                                  // 22 namespace alias
  "proc.execSync('git status')",                                                 // 23 (the alias is caught at 22)
  'const run = promisify(execFile)',                                             // 24 promisify alias
  "const worker = { spawn: (job) => job }",                                      // 25
  "worker.spawn('job')",                                                         // 26 ok: not child_process
  "import * as util from 'node:util'",                                           // 27
  'const runLater = util.promisify(childProcess.execFile)',                      // 28 promisify through namespaces
  'const execFileAsync2 = util.promisify(childProcess.exec)',                    // 29 same, any unknown name
  'const execAsync = util.promisify(childProcess.exec)',                         // 30 ok: a name the rule knows
  "import childProcessDefault from 'node:child_process'",                       // 31 default import
  "const dynamicChildProcess = import('node:child_process')",                    // 32 dynamic import
  "import { createRequire } from 'node:module'",                                 // 33 createRequire import
  'const requireFromModule = createRequire(import.meta.url)',                     // 34 createRequire call
  "require('node:child_process')",                                               // 35 direct require
  "import * as moduleApi from 'node:module'",                                    // 36 namespace module API
  'const requireFromNamespace = moduleApi.createRequire(import.meta.url)',         // 37 namespace createRequire
  "import moduleDefault from 'node:module'",                                     // 38 default module API
  'const requireFromDefault = moduleDefault.createRequire(import.meta.url)',        // 39 default createRequire
  'const { spawn: destructuredSpawn } = childProcess',                              // 40 namespace destructuring
  'const { spawnSync: assignedSpawnSync } = cp',                                    // 41 namespace destructuring alias
  'const dynamicChildProcessTemplate = import(`node:child_process`)',                // 42 static template import
  "const requiredChildTemplate = require(`node:child_process`)",                   // 43 static template require
  "const builtinChild = process.getBuiltinModule('node:child_process')",             // 44 builtin child_process
  'const builtinChildTemplate = process.getBuiltinModule(`node:child_process`)',     // 45 builtin child_process template
  "const builtinChildComputed = process['getBuiltinModule']('node:child_process')",  // 46 computed builtin child_process
  "export { spawn } from 'node:child_process'",                                     // 47 child_process re-export
  "export * from 'node:child_process'",                                             // 48 child_process re-export
  "const dynamicModule = import('node:module')",                                    // 49 dynamic node:module
  'const dynamicModuleTemplate = import(`node:module`)',                             // 50 dynamic node:module template
  "const builtinModule = process.getBuiltinModule('node:module')",                  // 51 builtin node:module
  'const builtinModuleTemplate = process.getBuiltinModule(`node:module`)',            // 52 builtin node:module template
  "const builtinModuleComputed = process['getBuiltinModule']('node:module')",       // 53 computed builtin node:module
  "const requiredModule = require('node:module')",                                  // 54 static node:module require
  'const requiredModuleTemplate = require(`node:module`)',                           // 55 static node:module require template
  "export { createRequire } from 'node:module'",                                    // 56 node:module re-export
  "moduleApi['createRequire'](import.meta.url)",                                    // 57 computed createRequire
  "const computedRun = util['promisify'](childProcess['execFile'])",                 // 58 computed promisify and launcher
  "const computedCall = util['promisify'](childProcess.execFile)",                   // 59 computed promisify only
  "const computedArgument = util.promisify(childProcess['execFile'])",               // 60 computed launcher only
].join('\n')

const eslint = new ESLint()

// Loading the shared TypeScript/React lint configuration can exceed a test's
// assertion budget when the full suite runs concurrently. Initialize it once.
beforeAll(async () => {
  await eslint.calculateConfigForFile('scripts/__lint-probe.mjs')
}, 45_000)

async function flaggedLines(filePath: string): Promise<number[]> {
  const [result] = await eslint.lintText(PROBE, { filePath })
  return [...new Set((result?.messages ?? []).map((message) => message.line))].sort((a, b) => a - b)
}

describe('the ambient-program lint rule', () => {
  it('flags every bypass and nothing legitimate, in a script', async () => {
    expect(await flaggedLines('scripts/__lint-probe.mjs')).toEqual([1, 6, 7, 8, 9, 11, 12, 13, 14, 19, 20, 21, 22, 24, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60])
  })

  it('applies to server code too, where no-undef is left to TypeScript', async () => {
    const lines = await flaggedLines('server/__lint-probe.ts')
    for (const line of [1, 6, 7, 8, 9, 11, 12, 13, 14, 19, 20, 22, 24, 28, 29, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]) expect(lines).toContain(line)
    for (const line of [15, 16, 18, 25, 26]) expect(lines).not.toContain(line)
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
  const [result] = await eslint.lintText(SHARED_HELPER_PROBE, { filePath })
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
