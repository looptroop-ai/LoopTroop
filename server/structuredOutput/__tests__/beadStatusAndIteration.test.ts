import { describe, expect, it, vi } from 'vitest'
import { normalizeBeadsJsonlOutput } from '../index'
import { reconcileStoredBeadStatus } from '../../phases/beads/beadsFile'

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
    testCommands: ['npm run test'],
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
})

describe('bead iteration clamping', () => {
  it.each([0, -3, 1.5, 'later'])('clamps %s to 1 and warns', (iteration) => {
    const result = parseBead({ iteration })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.iteration).toBe(1)
    expect(result.repairWarnings.some((warning) => warning.includes('replaced invalid iteration'))).toBe(true)
  })

  it('keeps a valid iteration without warning', () => {
    const result = parseBead({ iteration: 4 })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value[0]?.iteration).toBe(4)
    expect(result.repairWarnings.some((warning) => warning.includes('iteration'))).toBe(false)
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
    expect(readBeadsFile(path).map((bead) => bead.id)).toEqual(['bead-1'])
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
      const beads = readBeadsFile(path)
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
      expect(readBeadsFile(path).map((bead) => bead.id)).toEqual(['bead-3'])
    } finally {
      warn.mockRestore()
    }
    expect(() => readBeadsFile(path, { malformedEntries: 'fail' }))
      .toThrow('at line 1 with field "dependencies" has the wrong type')
  })

  it('rejects a field that is present but not fully formed', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readBeadsFile } = await import('../../phases/beads/beadsFile')

    const dir = mkdtempSync(join(tmpdir(), 'looptroop-beads-'))
    const path = join(dir, 'beads.jsonl')
    // Each of these passed the first version of the check and then threw
    // somewhere else: the scheduler on `dependencies.blocked_by`, the prompt
    // builder on `contextGuidance.patterns` and on a null test command, and the
    // evidence loader on `qaOrigin.sourceItems` — the last one outside the try
    // that turns a bad manifest into a readable error.
    writeFileSync(path, [
      JSON.stringify({ id: 'empty-deps', status: 'pending', dependencies: {} }),
      JSON.stringify({ id: 'empty-guidance', status: 'pending', contextGuidance: {} }),
      JSON.stringify({ id: 'null-command', status: 'pending', testCommands: [null] }),
      JSON.stringify({ id: 'no-source-items', status: 'pending', qaOrigin: { imageDelivery: 'attached' } }),
      JSON.stringify({ id: 'good', status: 'pending', dependencies: { blocked_by: [], blocks: [] } }),
    ].join('\n'))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(readBeadsFile(path).map((bead) => bead.id)).toEqual(['good'])
    } finally {
      warn.mockRestore()
    }
    expect(() => readBeadsFile(path, { malformedEntries: 'fail' }))
      .toThrow('field "dependencies" has the wrong type')
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
      readBeadsFile(path)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('at line 4'))
    } finally {
      warn.mockRestore()
    }
  })
})
