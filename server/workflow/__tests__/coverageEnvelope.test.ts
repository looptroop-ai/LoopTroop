import { describe, expect, it, vi } from 'vitest'

vi.mock('../../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({}),
  isMockOpenCodeMode: () => false,
}))

import {
  normalizeBeadsCoverageEnvelope,
  normalizeInterviewCoverageEnvelope,
  normalizePrdCoverageEnvelope,
} from '../phases/verificationPhase'
import type { CoverageResultEnvelope } from '../../structuredOutput'

const followUp = { id: 'FU1', question: 'Which platforms?' }

function envelope(overrides: Partial<CoverageResultEnvelope> = {}): CoverageResultEnvelope {
  return { status: 'clean', gaps: [], followUpQuestions: [], ...overrides }
}

describe('interview coverage envelope', () => {
  it('rejects status clean with gaps', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ gaps: ['Nothing covers retries.'] }))
    expect(result.validationError).toContain('reported status clean but also returned gaps')
  })

  it('rejects status clean with follow-up questions', () => {
    // These used to be dropped in silence: the follow-up resolution returns
    // nothing for any status that is not `gaps`.
    const result = normalizeInterviewCoverageEnvelope(envelope({ followUpQuestions: [followUp] }))
    expect(result.validationError).toContain('reported status clean but also returned follow-up questions')
  })

  it('accepts a clean envelope with neither', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope())
    expect(result.validationError).toBeUndefined()
    expect(result.envelope).toEqual({ status: 'clean', gaps: [], followUpQuestions: [] })
  })

  it('keeps follow-up questions on a gaps envelope', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ status: 'gaps', followUpQuestions: [followUp] }))
    expect(result.validationError).toBeUndefined()
    expect(result.envelope.followUpQuestions).toEqual([followUp])
  })

  it('accepts a gaps envelope with no gap strings, because follow-ups answer them', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ status: 'gaps', followUpQuestions: [followUp] }))
    expect(result.validationError).toBeUndefined()
  })

  it('trims empty gap strings and says so', () => {
    const result = normalizeInterviewCoverageEnvelope(envelope({ status: 'gaps', gaps: ['Real gap.', '  '] }))
    expect(result.envelope.gaps).toEqual(['Real gap.'])
    expect(result.repairWarnings).toContain('Trimmed empty interview coverage gap strings before persisting the normalized result.')
  })
})

describe('PRD and beads coverage envelopes keep their existing contract', () => {
  it.each([
    ['PRD', normalizePrdCoverageEnvelope, 'PRD'],
    ['Beads', normalizeBeadsCoverageEnvelope, 'beads'],
  ] as const)('%s drops follow-up questions with a warning', (label, normalize, trimmedLabel) => {
    const result = normalize(envelope({ status: 'gaps', gaps: ['A gap.'], followUpQuestions: [followUp] }))
    expect(result.envelope.followUpQuestions).toEqual([])
    expect(result.repairWarnings).toContain(
      `${label} coverage follow_up_questions were ignored because ${trimmedLabel} coverage is envelope-only.`,
    )
  })

  it.each([
    ['PRD', normalizePrdCoverageEnvelope],
    ['Beads', normalizeBeadsCoverageEnvelope],
  ] as const)('%s rejects status clean with gaps', (label, normalize) => {
    const result = normalize(envelope({ gaps: ['A gap.'] }))
    expect(result.validationError).toBe(
      `${label} coverage reported status clean but also returned gaps. Return status gaps for unresolved coverage and keep gaps empty when status is clean.`,
    )
  })

  it.each([
    ['PRD', normalizePrdCoverageEnvelope],
    ['Beads', normalizeBeadsCoverageEnvelope],
  ] as const)('%s rejects status gaps with no gap strings', (label, normalize) => {
    const result = normalize(envelope({ status: 'gaps' }))
    expect(result.validationError).toBe(
      `${label} coverage reported status gaps but did not return any non-empty gap strings. Return at least one concrete gap string.`,
    )
  })
})
