import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function listRepositoryFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'buffer' })
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
}

function isBinary(buffer: Buffer): boolean {
  return buffer.includes(0)
}

describe('line ending policy', () => {
  it('keeps tracked text files from mixing LF and CRLF endings', () => {
    const violations: string[] = []

    for (const path of listRepositoryFiles()) {
      const content = readFileSync(path)
      if (isBinary(content)) continue

      const text = content.toString('utf8')
      const crlfCount = (text.match(/\r\n/g) ?? []).length
      const lfOnlyCount = (text.match(/(?<!\r)\n/g) ?? []).length

      if (crlfCount > 0 && lfOnlyCount > 0) {
        violations.push(`${path} mixes CRLF (${crlfCount}) and LF (${lfOnlyCount}) endings`)
      }

      if (crlfCount > 0) {
        violations.push(`${path} uses CRLF endings; application text files must use LF`)
      }
    }

    expect(violations).toEqual([])
  })
})
