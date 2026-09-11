import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'

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
].join('\n')

async function restrictedLines(filePath: string): Promise<number[]> {
  const [result] = await new ESLint().lintText(probe, { filePath })
  return [...new Set((result?.messages ?? []).filter((message) => message.ruleId === 'no-restricted-imports').map((message) => message.line))]
}

describe('workflow artifact I/O lint boundary', () => {
  it('rejects raw content imports, aliases and namespaces while retaining metadata and contained I/O', async () => {
    expect(await restrictedLines('server/workflow/phases/__lint-probe.ts')).toEqual([1, 2, 3, 4, 5, 6, 7, 13, 14, 15, 16])
  })

  it('leaves fixture setup and low-level I/O implementations outside the workflow boundary', async () => {
    expect(await restrictedLines('server/workflow/__tests__/__lint-probe.test.ts')).toEqual([])
    expect(await restrictedLines('server/io/__lint-probe.ts')).toEqual([])
  })
})
