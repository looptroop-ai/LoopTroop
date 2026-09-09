import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBeadsFile } from '../beadsFile'

const tempDirs: string[] = []

function writeTracker(...lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-file-'))
  tempDirs.push(dir)
  const filePath = join(dir, 'issues.jsonl')
  writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf-8')
  return filePath
}

function bead(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'B-1',
    title: 'One',
    status: 'pending',
    priority: 1,
    dependencies: { blocked_by: [], blocks: [] },
    ...overrides,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The reader the scheduler runs on.
 *
 * The interface accepts `dependencies.blockedBy` and
 * `contextGuidance.antiPatterns`, because trackers carry both. Until this
 * reader did too, the two disagreed in the worst possible direction: a plan
 * showed its dependencies on the approval screen, passed approval, and the bead
 * was then dropped here with a console warning nobody reads.
 */
describe('readBeadsFile and the nested spellings', () => {
  it('reads a bead whose dependencies use the camelCase spelling', () => {
    const beads = readBeadsFile(writeTracker(bead({ dependencies: { blockedBy: ['B-0'], blocks: [] } })))

    expect(beads).toHaveLength(1)
    expect(beads[0]!.dependencies).toEqual({ blocked_by: ['B-0'], blocks: [] })
  })

  it('reads guidance whose anti-patterns use the camelCase spelling', () => {
    const beads = readBeadsFile(writeTracker(bead({
      contextGuidance: { patterns: ['p'], antiPatterns: ['a'] },
    })))

    expect(beads[0]!.contextGuidance).toEqual({ patterns: ['p'], anti_patterns: ['a'] })
  })

  it('keeps the canonical value when a record carries both spellings', () => {
    const beads = readBeadsFile(writeTracker(bead({
      dependencies: { blocked_by: ['canonical'], blockedBy: ['superseded'], blocks: [] },
    })))

    expect(beads[0]!.dependencies.blocked_by).toEqual(['canonical'])
  })

  it('still rejects a dependency list that is the wrong type under either spelling', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readBeadsFile(writeTracker(bead({ dependencies: { blockedBy: 'B-0', blocks: [] } })))).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('field "dependencies" has the wrong type'))
  })

  it('fails closed on the alias too when the caller asked it to', () => {
    expect(() => readBeadsFile(
      writeTracker(bead({ dependencies: { blockedBy: 'B-0', blocks: [] } })),
      { malformedEntries: 'fail' },
    )).toThrow(/field "dependencies" has the wrong type/)
  })
})
