import { ESLint } from 'eslint'
import { beforeAll, describe, expect, it } from 'vitest'

const probe = [
  "import { readFileSync as read } from 'fs'",
  "import * as fs from 'node:fs'",
  "import fsDefault from 'fs'",
  "import { promises } from 'node:fs'",
  "import { readFile as readAsync } from 'node:fs/promises'",
  "import { safeAtomicWrite as write } from '../../io/atomicWrite'",
  "import * as atomic from '../../io/atomicWrite.ts'",
  "import { existsSync } from 'node:fs'",
  "import { stat } from 'fs/promises'",
  "import { safeAtomicWriteWithin } from '../../io/atomicWrite'",
  "import { readTicketFile, writeTicketFile } from '../../storage/tickets'",
  "import { readFileNoFollowSync } from '../../io/readFile'",
  "import { writeJsonl as writeRows, appendJsonl } from '../../io/jsonl'",
  "import * as jsonl from '../../io/jsonl.ts'",
  "import { safeAtomicAppend } from '../../io/atomicAppend'",
  "import * as append from '../../io/atomicAppend.ts'",
  "import { appendJsonlWithin } from '../../io/jsonl'",
  "import { safeAtomicAppendWithin } from '../../io/atomicAppend'",
  "import { readdirSync, rmSync, renameSync, statSync } from 'node:fs'",
  "import('node:fs')",
  "readdirSync('/tmp')",
  "rmSync('/tmp')",
  "renameSync('/tmp/a', '/tmp/b')",
  "statSync('/tmp')",
  'const dynamicFs = import(`node:fs`)',
  "const requiredFs = require('node:fs')",
  'const requiredFsTemplate = require(`node:fs/promises`)',
  "const builtinFs = process.getBuiltinModule('node:fs')",
  'const builtinFsTemplate = process.getBuiltinModule(`node:fs/promises`)',
  "fs.promises.readFile('/tmp')",
  "fs.promises['readFile']('/tmp')",
  "fs['readFileSync']('/tmp')",
  "const builtinFsComputed = process['getBuiltinModule']('node:fs')",
  "builtinFsComputed['readFileSync']('/tmp')",
  "export * from 'node:fs'",
  "export { readFile } from 'node:fs'",
  "import fsEquals = require('node:fs')",
  "import { opendir, opendirSync } from 'node:fs'",
].join('\n')

const projectBrowserProbe = [
  "import { access, constants, readdir, stat } from 'fs/promises'",
  "await access('/tmp', constants.F_OK)",
  "await readdir('/tmp')",
  "await stat('/tmp')",
  "import { readFileSync, writeFileSync, rmSync } from 'node:fs'",
  "readFileSync('/tmp/user-path')",
  "writeFileSync('/tmp/user-path', 'content')",
  "rmSync('/tmp/user-path', { recursive: true, force: true })",
  "import { safeAtomicWrite } from '../../io/atomicWrite'",
  "import { safeAtomicAppend } from '../../io/atomicAppend'",
].join('\n')

const eslint = new ESLint()

beforeAll(async () => {
  await eslint.calculateConfigForFile('server/phases/execution/__lint-probe.ts')
}, 45_000)

async function restrictedLines(filePath: string, source = probe): Promise<number[]> {
  const [result] = await eslint.lintText(source, { filePath })
  return [...new Set((result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-imports').map((message) => message.line))]
}

async function restrictedSyntaxLines(filePath: string, source = probe): Promise<number[]> {
  const [result] = await eslint.lintText(source, { filePath })
  return [...new Set((result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-syntax').map((message) => message.line))]
}

describe('artifact I/O lint boundary', () => {
  it.each(['server/workflow/phases/__lint-probe.ts', 'server/storage/__lint-probe.ts'])('rejects raw content imports in %s while retaining metadata and contained I/O', async (path) => {
    expect(await restrictedLines(path)).toEqual([1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 19, 35, 36, 38])
    expect(await restrictedSyntaxLines(path)).toEqual([2, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30, 31, 32, 33, 35, 36, 37])
  })

  it.each(['server/routes/__lint-probe.ts', 'server/phases/__lint-probe.ts', 'server/ticket/__lint-probe.ts'])('extends raw content, directory, and destructive I/O checks to %s', async (path) => {
    expect(await restrictedLines(path)).toEqual([1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16, 19, 35, 36, 38])
    expect(await restrictedSyntaxLines(path)).toEqual([2, 20, 21, 22, 23, 25, 26, 27, 28, 29, 30, 31, 32, 33, 35, 36, 37])
  })

  it('keeps the documented project-browser boundary narrow', async () => {
    expect(await restrictedLines('server/routes/projects.ts', projectBrowserProbe)).toEqual([5, 9, 10])
    expect(await restrictedSyntaxLines('server/routes/projects.ts', projectBrowserProbe)).toEqual([6, 7, 8])
  })

  it.each([
    ['server/phases/manualQa/checkpoint.ts', 'readSync', 'writeFileSync'],
    ['server/phases/executionSetup/hookValidation.ts', 'readFileSync', 'copyFileSync'],
  ])('keeps reviewed recovery exceptions operation-specific in %s', async (filePath, allowed, denied) => {
    const source = `import { ${allowed}, ${denied} } from 'node:fs'\n${allowed}(0)\n${denied}('/untrusted')`
    expect(await restrictedLines(filePath, source)).toEqual([1])
    expect(await restrictedSyntaxLines(filePath, source)).toEqual([3])
  })

  it('leaves fixture setup and low-level I/O implementations outside the workflow boundary', async () => {
    expect(await restrictedLines('server/workflow/__tests__/__lint-probe.test.ts')).toEqual([])
    expect(await restrictedLines('server/storage/__tests__/__lint-probe.test.ts')).toEqual([])
    expect(await restrictedLines('server/io/__lint-probe.ts')).toEqual([])
  })
})
