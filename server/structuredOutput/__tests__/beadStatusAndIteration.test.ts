import { describe, expect, it, vi } from 'vitest'
import { normalizeBeadSubsetYamlOutput, normalizeBeadsJsonlOutput } from '../index'
import { reconcileStoredBeadStatus } from '../../phases/beads/beadsFile'

const TEST_COMMAND = {
  mode: 'shell' as const,
  shell: 'posix' as const,
  script: 'npm run test',
  cwd: '.',
  env: {},
}

function buildBeadRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'bead-1',
    title: 'First bead',
    prdRefs: ['EPIC-1 / US-1'],
    description: 'Do the first step.',
    contextGuidance: {
      patterns: ['Keep the bead narrowly scoped.'],
      anti_patterns: ['Do not depend on unrelated files.'],
    },
    acceptanceCriteria: ['done'],
    tests: ['test'],
    testCommands: [TEST_COMMAND],
    priority: 1,
    status: 'pending',
    labels: [],
    dependencies: [],
    targetFiles: [],
    iteration: 1,
    createdAt: '',
    updatedAt: '',
    beadStartCommit: null,
    ...overrides,
  }
}

function parseBead(overrides: Record<string, unknown> = {}) {
  return normalizeBeadsJsonlOutput(JSON.stringify([buildBeadRecord(overrides)]))
}

function buildBeadSubset(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bead-1',
    title: 'First bead',
    prdRefs: ['EPIC-1 / US-1'],
    description: 'Do the first step.',
    contextGuidance: {
      patterns: ['Keep the bead narrowly scoped.'],
      anti_patterns: ['Do not depend on unrelated files.'],
    },
    acceptanceCriteria: ['done'],
    tests: ['test'],
    testCommands: [TEST_COMMAND],
    ...overrides,
  }
}

describe('bead status validation', () => {
  it.each(['pending', 'in_progress', 'done', 'error'])('accepts %s', (status) => {
    const result = parseBead({ status })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.status).toBe(status)
  })

  it.each([
    ['completed', 'done'],
    ['failed', 'error'],
    ['skipped', 'done'],
  ])('keeps the legacy alias %s mapping to %s', (status, expected) => {
    const result = parseBead({ status })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.status).toBe(expected)
  })

  it('defaults a missing status to pending', () => {
    const record = buildBeadRecord()
    delete record.status
    const result = normalizeBeadsJsonlOutput(JSON.stringify([record]))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.status).toBe('pending')
  })

  it.each(['complete', 'todo', 'in-progress'])('rejects the unsupported status %s', (status) => {
    const result = parseBead({ status })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('unsupported status')
  })

  it.each([
    ['DONE', 'done'],
    ['Done', 'done'],
    ['Completed', 'done'],
    ['IN_PROGRESS', 'in_progress'],
    ['Failed', 'error'],
  ])('reads %s as %s, as the read path already did', (status, expected) => {
    // Rejecting these spent a structured retry on a capital letter, while the
    // same value read back off disk was reconciled and accepted.
    const result = parseBead({ status })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.status).toBe(expected)
  })

  it('does not resolve a status the alias map inherits rather than owns', () => {
    // The map was indexed directly, so `constructor` resolved to a function.
    for (const status of ['constructor', 'toString', 'hasOwnProperty']) {
      const result = parseBead({ status })
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toContain('unsupported status')
    }
  })

  it('maps an explicitly blank status to pending with a warning', () => {
    const result = parseBead({ status: '   ' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.status).toBe('pending')
    expect(result.repairWarnings).toContain('Bead at index 0 had an empty status; used "pending".')
  })
})

describe('bead iteration clamping', () => {
  it.each([0, -3, 1.5, 'later', true, [1], [2, 3], {}])('clamps %s to 1 and warns', (iteration) => {
    const result = parseBead({ iteration })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.iteration).toBe(1)
    expect(result.repairWarnings.some((warning) => warning.includes('replaced invalid iteration'))).toBe(true)
  })

  it('keeps only valid failed-iteration and retry notes', () => {
    const result = parseBead({
      failedIterationNotes: [
        { timestamp: ' 2026-08-01 ', iteration: '2', content: 'test failed', errorCode: ' TEST_FAILED ' },
        null,
        { timestamp: '', iteration: 2, content: 'missing time' },
        { timestamp: '2026-08-02', iteration: 'later', content: 'invalid iteration' },
        { timestamp: '2026-08-03', iteration: 3, content: '   ' },
      ],
      userRetryNotes: [
        { timestamp: '2026-08-04', iteration: 4, content: 'Retry requested.' },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.failedIterationNotes).toEqual([
      { timestamp: '2026-08-01', iteration: 2, content: 'test failed', errorCode: 'TEST_FAILED' },
    ])
    expect(result.value[0]?.userRetryNotes).toEqual([
      { timestamp: '2026-08-04', iteration: 4, content: 'Retry requested.' },
    ])
    expect(result.value[0]?.finalizationFailureNotes).toEqual([])
  })

  it('keeps a valid iteration without warning', () => {
    const result = parseBead({ iteration: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.iteration).toBe(4)
    expect(result.repairWarnings.some((warning) => warning.includes('iteration'))).toBe(false)
  })

  it('uses the canonical testCommands field when both spellings are present', () => {
    const result = parseBead({
      testCommands: [{ ...TEST_COMMAND, script: 'npm run canonical' }],
      test_commands: [{ ...TEST_COMMAND, script: 'npm run legacy' }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const command = result.value[0]?.testCommands[0]
    expect(command?.mode).toBe('shell')
    if (!command || command.mode !== 'shell') return
    expect(command.script).toBe('npm run canonical')
    expect(result.repairWarnings).toContain('Resolved "testCommands" and ignored the conflicting value in "test_commands".')
  })
})

describe('bead subset output validation', () => {
  it('normalizes guidance strings and repairs duplicate IDs without losing warnings', () => {
    const result = normalizeBeadSubsetYamlOutput(JSON.stringify({ beads: [
      buildBeadSubset({
        id: 'duplicate',
        contextGuidance: 'Patterns:\n- Use small changes.\nAnti-patterns:\n- Skip validation.',
      }),
      buildBeadSubset({ id: 'duplicate', title: 'Second bead', prdRefs: [] }),
    ] }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.map(({ id }) => id)).toEqual(['duplicate', 'duplicate-2'])
    expect(result.value[0]?.contextGuidance).toEqual({
      patterns: ['Use small changes.'],
      anti_patterns: ['Skip validation.'],
    })
    expect(result.repairWarnings).toEqual(expect.arrayContaining([
      'Canonicalized string context guidance at index 0 into patterns/anti_patterns object.',
      'Renumbered duplicate bead id "duplicate" to "duplicate-2".',
      'Bead "duplicate-2" has no PRD references (prdRefs is empty).',
    ]))
  })

  it.each([
    ['empty output', { beads: [] }, 'Bead subset output is empty'],
    ['non-object guidance', { beads: [buildBeadSubset({ contextGuidance: 3 })] }, 'must be a string or object'],
    ['guidance missing a pattern', { beads: [buildBeadSubset({ contextGuidance: { anti_patterns: ['avoid'] } })] }, 'missing patterns'],
    ['guidance missing anti-patterns', { beads: [buildBeadSubset({ contextGuidance: { patterns: ['safe'] } })] }, 'missing anti-patterns'],
    ['empty guidance string', { beads: [buildBeadSubset({ contextGuidance: '  ' })] }, 'is empty'],
    ['empty acceptance criteria', { beads: [buildBeadSubset({ acceptanceCriteria: [] })] }, 'is missing acceptance criteria'],
    ['empty tests', { beads: [buildBeadSubset({ tests: [] })] }, 'is missing tests'],
    ['blank test command reason', { beads: [buildBeadSubset({ testCommands: [], testCommandReason: '  ' })] }, 'invalid testCommandReason'],
  ])('rejects %s with a structured validation error', (_label, payload, expected) => {
    const result = normalizeBeadSubsetYamlOutput(JSON.stringify(payload))

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain(expected)
  })
})

describe('reconcileStoredBeadStatus', () => {
  it('passes a valid status through untouched', () => {
    expect(reconcileStoredBeadStatus('in_progress', 'bead-1')).toEqual({ status: 'in_progress' })
  })

  it.each([
    ['completed', 'done'],
    ['FAILED', 'error'],
    ['DONE', 'done'],
  ])('coerces the stored value %s to %s with a warning', (stored, expected) => {
    const result = reconcileStoredBeadStatus(stored, 'bead-1')
    expect(result.status).toBe(expected)
    expect(result.warning).toContain('bead-1')
  })

  it('coerces an unrecognised stored status to pending so the scheduler can run it', () => {
    const result = reconcileStoredBeadStatus('todo', 'bead-1')
    expect(result.status).toBe('pending')
    expect(result.warning).toContain('unrecognised stored status')
  })

  it('coerces a missing status rather than leaving the bead unrunnable', () => {
    expect(reconcileStoredBeadStatus(undefined, 'bead-1').status).toBe('pending')
  })
})

describe('readBeadsFile', () => {
  it('reconciles stored statuses and warns once per bead', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    writeFileSync(path, [
      JSON.stringify({ id: 'bead-1', status: 'done' }),
      JSON.stringify({ id: 'bead-2', status: 'complete' }),
    ].join('\n'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const beads = readBeadsFile(path)
      expect(beads.map((bead) => bead.status)).toEqual(['done', 'pending'])
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('fails closed on a malformed line when the caller says the read is authoritative', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    writeFileSync(path, [
      JSON.stringify({ id: 'bead-1', status: 'done' }),
      '{ not json',
    ].join('\n'))

    // The Manual QA evidence manifest decides which images reach a prompt, so a
    // line that quietly disappears becomes evidence that silently never arrives.
    expect(() => readBeadsFile(path, { malformedEntries: 'fail' })).toThrow('unparseable JSON at line')
    expect(readBeadsFile(path, { malformedEntries: 'skip' }).map((bead) => bead.id)).toEqual(['bead-1'])
  })

  it('fails closed on an entry with no id when the read is authoritative', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    writeFileSync(path, [JSON.stringify({ status: 'done' })].join('\n'))

    expect(() => readBeadsFile(path, { malformedEntries: 'fail' })).toThrow('no usable id')
  })

  it('skips a malformed line instead of throwing on the whole tracker', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // `readJsonl<Bead>` casts rather than checks, so `null` threw on `.status`
    // and a bare string became a Bead with no id.
    writeFileSync(path, [
      'null',
      '"just a string"',
      JSON.stringify({ status: 'done' }),
      JSON.stringify({ id: 'bead-1', status: 'done' }),
    ].join('\n'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const beads = readBeadsFile(path, { malformedEntries: 'skip' })
      expect(beads.map((bead) => bead.id)).toEqual(['bead-1'])
      expect(warn).toHaveBeenCalledTimes(3)
    } finally {
      warn.mockRestore()
    }
  })

  it('rejects an entry whose field holds the wrong kind of value', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // The scheduler reaches into `bead.dependencies.blocked_by` with no guard,
    // so casting this row through as a `Bead` crashed it far from the file
    // that caused it.
    writeFileSync(path, [
      JSON.stringify({ id: 'bead-1', status: 'pending', dependencies: 'none' }),
      JSON.stringify({ id: 'bead-2', status: 'pending', testCommands: { npm: 'test' } }),
      JSON.stringify({ id: 'bead-3', status: 'pending', dependencies: { blocked_by: ['bead-1'], blocks: [] } }),
    ].join('\n'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readBeadsFile(path, { malformedEntries: 'skip' }).map((bead) => bead.id)).toEqual(['bead-3'])
    } finally {
      warn.mockRestore()
    }
    expect(() => readBeadsFile(path, { malformedEntries: 'fail' }))
      .toThrow('at line 1 with field "dependencies" has the wrong type')
  })

  it('fills missing collection members but rejects malformed commands and evidence', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // Missing collection members have safe empty defaults. Invalid command
    // entries and incomplete evidence still fail before their consumers run.
    writeFileSync(path, [
      JSON.stringify({ id: 'empty-deps', status: 'pending', dependencies: {} }),
      JSON.stringify({ id: 'empty-guidance', status: 'pending', contextGuidance: {} }),
      JSON.stringify({ id: 'null-command', status: 'pending', testCommands: [null] }),
      JSON.stringify({ id: 'no-source-items', status: 'pending', qaOrigin: { imageDelivery: 'attached' } }),
      JSON.stringify({ id: 'good', status: 'pending', dependencies: { blocked_by: [], blocks: [] } }),
    ].join('\n'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const beads = readBeadsFile(path, { malformedEntries: 'skip' })
      expect(beads.map((bead) => bead.id)).toEqual(['empty-deps', 'empty-guidance', 'good'])
      expect(beads[0]?.dependencies).toEqual({ blocked_by: [], blocks: [] })
      expect(beads[1]?.contextGuidance).toEqual({ patterns: [], anti_patterns: [] })
    } finally {
      warn.mockRestore()
    }
    expect(() => readBeadsFile(path, { malformedEntries: 'fail' }))
      .toThrow('at line 3 with field "testCommands" has the wrong type')
  })

  it('accepts a row that carries only the fields it has reached so far', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // Present fields are type-checked; absent ones are not demanded. The
    // runtime projection reads rows like this one, so requiring the fully
    // expanded shape would reject files that work today.
    writeFileSync(path, JSON.stringify({ id: 'bead-1', title: 'Partial', status: 'pending', iteration: 1 }))

    expect(readBeadsFile(path, { malformedEntries: 'fail' }).map((bead) => bead.id)).toEqual(['bead-1'])
  })

  it('fills in the collections its readers dereference without a guard', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')
    const { getRunnable } = await import('../../phases/execution/scheduler')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // A row that has not reached expansion carries neither field, and rejecting
    // it would refuse files that work — but the scheduler and a dozen other
    // readers reach straight into them. An empty list is the only thing "no
    // dependencies" can mean.
    writeFileSync(path, JSON.stringify({ id: 'early', title: 'Early', status: 'pending', priority: 1 }))

    const [bead] = readBeadsFile(path, { malformedEntries: 'fail' })
    expect(bead?.dependencies).toEqual({ blocked_by: [], blocks: [] })
    expect(bead?.contextGuidance).toEqual({ patterns: [], anti_patterns: [] })
    expect(getRunnable([bead!]).map((entry) => entry.id)).toEqual(['early'])
  })

  it('rejects a Manual QA provenance record whose items carry no evidence list', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // The evidence loader walks `sourceItems[].evidence` outside the try that
    // turns a bad manifest into a readable error, so this row used to reach it
    // and throw a TypeError from somewhere the operator cannot place.
    writeFileSync(path, JSON.stringify({
      id: 'qa-fix',
      status: 'pending',
      qaOrigin: { imageDelivery: 'attached', sourceItems: [{ itemId: 'i1' }] },
    }))

    expect(() => readBeadsFile(path, { malformedEntries: 'fail' }))
      .toThrow('field "qaOrigin" has the wrong type')
  })

  it('names the line in the file when it rejects an entry', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // The bad entry is on line 4. Counting positions among the entries that
    // parsed named line 2 and pointed at a bead that was fine.
    writeFileSync(path, [
      JSON.stringify({ id: 'bead-1', status: 'pending' }),
      '',
      'not json',
      JSON.stringify({ status: 'pending' }),
    ].join('\n'))

    expect(() => readBeadsFile(path, { malformedEntries: 'fail' })).toThrow('at line(s) 3')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      readBeadsFile(path, { malformedEntries: 'skip' })
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('at line 4'))
    } finally {
      warn.mockRestore()
    }
  })
})
