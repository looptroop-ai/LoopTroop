import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptPart } from '../../opencode/types'

const { artifacts, context, lookup, upsert } = vi.hoisted(() => ({
  artifacts: new Map<string, { content: string }>(),
  context: vi.fn(),
  lookup: vi.fn(),
  upsert: vi.fn(),
}))
vi.mock('../../storage/ticketArtifacts', () => ({ getLatestPhaseArtifact: lookup, upsertLatestPhaseArtifact: upsert }))
vi.mock('../../storage/ticketQueries', () => ({ getTicketContext: context }))

import { appendPhaseRetryNote, canRetryWithExtraNote, PHASE_RETRY_NOTE_ARTIFACT, readPhaseRetryNote, savePhaseRetryNote } from '../retryNotes'

describe('phase retry notes', () => {
  beforeEach(() => {
    artifacts.clear()
    lookup.mockImplementation((ticketId, kind, phase) => artifacts.get(`${ticketId}:${phase}:${kind}`))
    upsert.mockImplementation((ticketId, kind, phase, content) => { artifacts.set(`${ticketId}:${phase}:${kind}`, { content }) })
  })

  it('preserves literal instructions and keeps them scoped to their ticket and phase', () => {
    const note = '  Keep this path: C:\\Users\\Example\\config.json\nDo not change the approved requirements.  '
    savePhaseRetryNote('1:TEST-1', 'EXPANDING_BEADS', note)
    expect(readPhaseRetryNote('1:TEST-1', 'EXPANDING_BEADS')).toBe(note)
    expect(readPhaseRetryNote('1:TEST-2', 'EXPANDING_BEADS')).toBeUndefined()
    expect(readPhaseRetryNote('1:TEST-1', 'REFINING_PRD')).toBeUndefined()
    const parts: PromptPart[] = [{ type: 'text', content: 'Saved input' }]
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'EXPANDING_BEADS')).toEqual([
      ...parts, { type: 'text', content: `## User Retry Note\n${note}` },
    ])
    expect(parts).toHaveLength(1)
  })

  it('clears rejected instructions without creating empty artifacts for ordinary retries', () => {
    savePhaseRetryNote('1:TEST-1', 'REFINING_PRD', undefined)
    expect(upsert).not.toHaveBeenCalled()
    savePhaseRetryNote('1:TEST-1', 'REFINING_PRD', 'Rejected dispatch')
    savePhaseRetryNote('1:TEST-1', 'REFINING_PRD', undefined)
    expect(readPhaseRetryNote('1:TEST-1', 'REFINING_PRD')).toBeUndefined()
  })

  it('leaves coding notes to the existing per-bead history', () => {
    savePhaseRetryNote('1:TEST-1', 'CODING', 'Do not duplicate this')
    const parts: PromptPart[] = [{ type: 'text', content: 'Bead and its retry notes' }]
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'CODING')).toBe(parts)
    expect(appendPhaseRetryNote(parts, '1:TEST-1', 'RUNNING_FINAL_TEST')).toBe(parts)
  })

  it('keeps newer per-model guidance after the phase retry note', () => {
    savePhaseRetryNote('1:TEST-1', 'DRAFTING_BEADS', 'Guidance for the round')
    const original: PromptPart = { type: 'text', content: 'Approved inputs' }
    const member: PromptPart = { type: 'text', content: '## User Retry Note\nNewer guidance for this model' }
    expect(appendPhaseRetryNote([original, member], '1:TEST-1', 'DRAFTING_BEADS')).toEqual([
      original, { type: 'text', content: '## User Retry Note\nGuidance for the round' }, member,
    ])
  })

  it.each([{ note: 1 }, {}, null])('ignores a stored non-string note: %j', value => {
    artifacts.set(`1:TEST-1:REFINING_PRD:${PHASE_RETRY_NOTE_ARTIFACT}`, { content: JSON.stringify(value) })
    expect(readPhaseRetryNote('1:TEST-1', 'REFINING_PRD')).toBeUndefined()
  })

  it.each([
    [null, 'REFINING_PRD', true],
    [null, 'INTEGRATING_CHANGES', false],
    ['[]', 'REFINING_PRD', true],
    ['["BEAD_FINALIZATION_FAILED"]', 'CODING', false],
    ['["BEAD_EXECUTION_FAILED", 1]', 'CODING', true],
    ['invalid', 'CODING', false],
    ['{}', 'REFINING_PRD', true],
  ] as const)('checks saved failure codes %s for %s', (codes, phase, expected) => {
    const get = vi.fn().mockReturnValue({ errorCodes: codes })
    context.mockReturnValue({ localTicketId: 1, projectDb: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ get }) }) }) }) } })
    expect(canRetryWithExtraNote('1:TEST-1', phase)).toBe(expected)
  })

  it('does not advertise notes for missing tickets and handles failures without occurrences', () => {
    context.mockReturnValue(undefined)
    expect(canRetryWithExtraNote('1:MISSING', 'CODING')).toBe(false)
    context.mockReturnValue({ localTicketId: 1, projectDb: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ get: () => undefined }) }) }) }) } })
    expect(canRetryWithExtraNote('1:TEST-1', 'PREPARING_EXECUTION_ENV')).toBe(true)
  })

  it.each([
    ['{"kind":"transport","source":"opencode","summary":"Prompt failed"}', true],
    ['{"kind":"runtime","source":"system","summary":"Git failed"}', false],
    ['invalid', false],
  ] as const)('uses the actual failing operation for mixed AI/local phases: %s', (diagnosticDetails, expected) => {
    context.mockReturnValue({ localTicketId: 1, projectDb: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ get: () => ({ errorCodes: '[]', diagnosticDetails }) }) }) }) }) } })
    expect(canRetryWithExtraNote('1:TEST-1', 'CREATING_PULL_REQUEST')).toBe(expected)
  })
})
