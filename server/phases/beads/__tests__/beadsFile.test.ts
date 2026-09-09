import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BEAD_FIELD_ALIASES, NESTED_BEAD_FIELD_ALIASES, readBeadsFile } from '../beadsFile'
import {
  BEAD_FIELD_ALIASES as CLIENT_BEAD_FIELD_ALIASES,
} from '../../../../src/lib/beadsDocument'

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

/**
 * The top-level spellings, which reach further than the nested ones.
 *
 * `formatBeadContext` dereferences `acceptanceCriteria`, `targetFiles`,
 * `tests` and `testCommands` without a guard, so a bead that arrives with only
 * the snake_case spelling reached the coding prompt as `undefined` and threw
 * there. The quiet ones are worse than the crash: an alias-only
 * `bead_start_commit` blocks a retry with a false cause, alias-only timestamps
 * resume the wrong bead, and an alias-only `qa_origin` drops the Manual QA
 * evidence with nothing said.
 */
describe('readBeadsFile and the top-level spellings', () => {
  it.each([
    ['acceptance_criteria', 'acceptanceCriteria', ['AC-1']],
    ['target_files', 'targetFiles', ['src/app.ts']],
    ['prd_refs', 'prdRefs', ['E01']],
    ['test_commands', 'testCommands', ['npm test']],
    ['issue_type', 'issueType', 'bug'],
    ['external_ref', 'externalRef', 'LOO-9'],
    ['started_at', 'startedAt', '2026-01-01T00:00:00.000Z'],
    ['updated_at', 'updatedAt', '2026-01-02T00:00:00.000Z'],
    ['completed_at', 'completedAt', '2026-01-03T00:00:00.000Z'],
    ['created_at', 'createdAt', '2026-01-01T00:00:00.000Z'],
    ['bead_start_commit', 'beadStartCommit', 'abc123'],
    ['test_command_reason', 'testCommandReason', 'nothing to run'],
  ])('reads %s as %s', (alias, canonical, value) => {
    const beads = readBeadsFile(writeTracker(bead({ [alias]: value })))

    expect(beads).toHaveLength(1)
    expect((beads[0] as unknown as Record<string, unknown>)[canonical]).toEqual(value)
    expect(beads[0] as unknown as Record<string, unknown>).not.toHaveProperty(alias)
  })

  it('reads the guidance and origin objects under their older spellings', () => {
    const beads = readBeadsFile(writeTracker(bead({
      context_guidance: { patterns: ['p'], anti_patterns: ['a'] },
      qa_origin: { sourceItems: [] },
    })))

    expect(beads[0]!.contextGuidance).toEqual({ patterns: ['p'], anti_patterns: ['a'] })
    expect(beads[0]!.qaOrigin).toEqual({ sourceItems: [] })
  })

  it('keeps the canonical value when a record carries both spellings', () => {
    const beads = readBeadsFile(writeTracker(bead({
      acceptanceCriteria: ['canonical'],
      acceptance_criteria: ['superseded'],
    })))

    expect(beads[0]!.acceptanceCriteria).toEqual(['canonical'])
  })

  it('treats a canonical null as carrying nothing, so the other spelling is read', () => {
    // `null` is what a writer leaves behind when it clears a field, and every
    // reader treats it as absent. Taking it as "the canonical name has this"
    // would drop the value the record actually holds.
    const beads = readBeadsFile(writeTracker(bead({
      qaOrigin: null,
      qa_origin: { sourceItems: [] },
    })))

    expect(beads[0]!.qaOrigin).toEqual({ sourceItems: [] })
  })

  it('still applies the type checks after canonicalising', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readBeadsFile(writeTracker(bead({ acceptance_criteria: 'not a list' })))).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('field "acceptanceCriteria" has the wrong type'))
  })
})

/**
 * The two tables are one contract.
 *
 * The interface decides which spellings it will *show*; this reader decides
 * which the runtime will *run*. A spelling in one and not the other is how a
 * plan reads correctly on the approval screen and then does not execute — the
 * failure `blockedBy` caused, and the reason both tables exist in step.
 */
describe('the reader accepts every spelling the interface does', () => {
  it('covers each top-level alias', () => {
    for (const [field, aliases] of Object.entries(CLIENT_BEAD_FIELD_ALIASES)) {
      for (const alias of aliases) {
        if (alias === field) continue
        expect(BEAD_FIELD_ALIASES[alias], `${alias} is displayed but not read`).toBe(field)
      }
    }
  })

  it('covers the nested ones', () => {
    // Not in the client's field table — they live inside a value — so they are
    // listed by hand on both sides and checked here.
    expect(NESTED_BEAD_FIELD_ALIASES).toEqual(expect.arrayContaining([
      ['dependencies', 'blocked_by', 'blockedBy'],
      ['contextGuidance', 'anti_patterns', 'antiPatterns'],
    ]))
  })
})
