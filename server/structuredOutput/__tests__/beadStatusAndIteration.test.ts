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
})
