import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readJsonl, readJsonlWithDiagnostics } from '../jsonl'

const roots: string[] = []

function writeFixture(content: string): string {
  const root = mkdtempSync(join(tmpdir(), 'looptroop-jsonl-test-'))
  roots.push(root)
  const path = join(root, 'records.jsonl')
  writeFileSync(path, content, 'utf8')
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('readJsonlWithDiagnostics', () => {
  it('reads every record of a clean file', () => {
    const path = writeFixture('{"id":1}\n{"id":2}\n')
    expect(readJsonlWithDiagnostics(path)).toEqual({
      items: [{ id: 1 }, { id: 2 }],
      itemLines: [1, 2],
      malformedLines: [],
    })
  })

  it('reports the line number in the file, not among the records it kept', () => {
    // Blank lines used to be filtered out before numbering, which renumbered
    // everything after them: the bad line below is line 5 of the file and was
    // reported as line 3, pointing an operator at a record that parsed fine.
    const path = writeFixture('{"id":1}\n\n\n{"id":2}\nnot json\n{"id":3}\n')
    const result = readJsonlWithDiagnostics(path)
    expect(result.items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
    expect(result.malformedLines).toEqual([5])
    // Positionally aligned with `items`: the third record is on line 6, not 3.
    expect(result.itemLines).toEqual([1, 4, 6])
  })

  it('treats a missing file as empty rather than an error', () => {
    const root = mkdtempSync(join(tmpdir(), 'looptroop-jsonl-test-'))
    roots.push(root)
    expect(readJsonlWithDiagnostics(join(root, 'absent.jsonl'))).toEqual({
      items: [],
      itemLines: [],
      malformedLines: [],
    })
  })

  it('drops malformed lines silently through the plain reader', () => {
    const path = writeFixture('{"id":1}\nnot json\n')
    expect(readJsonl(path)).toEqual([{ id: 1 }])
  })
})
