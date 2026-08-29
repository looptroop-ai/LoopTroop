import { describe, expect, it } from 'vitest'
import { WORKFLOW_PHASES, WORKFLOW_PHASE_MAP } from '../workflowMeta'
import {
  AI_QUESTION_WINDOW_DEFAULT_MS,
  AI_QUESTION_WINDOW_MAX_MS,
  AI_QUESTION_WINDOW_MIN_MS,
  COUNCIL_QUORUM_PHASES,
  INTERVIEW_QUESTION_PHASES,
  clampAiQuestionWindowMs,
  isCouncilQuorumPhase,
  phaseMayAskQuestions,
} from '../aiQuestions'

describe('AI question phase sets', () => {
  it('names only statuses that exist', () => {
    // A renamed status would otherwise drop silently out of both sets, and
    // nothing about the resulting behaviour would look wrong.
    for (const phase of [...COUNCIL_QUORUM_PHASES, ...INTERVIEW_QUESTION_PHASES]) {
      expect(WORKFLOW_PHASE_MAP[phase], `${phase} is not a workflow status`).toBeDefined()
    }
  })

  it('covers every status that seats a council', () => {
    // `COUNCIL_QUORUM_PHASES` is written by hand because "does a refusal here
    // cost quorum" is a domain fact, not something the metadata records. This is
    // the guard that makes adding a council status without adding it here fail
    // loudly rather than quietly stop annotating receipts.
    const multiModel = WORKFLOW_PHASES
      .filter((phase) => phase.multiModelLogs === true)
      .map((phase) => phase.id)
    expect(multiModel.length).toBeGreaterThan(0)
    for (const phase of multiModel) {
      expect(isCouncilQuorumPhase(phase), `${phase} runs a council but is not a quorum phase`).toBe(true)
    }
  })

  it('never lets the interview ask its own kind of question', () => {
    for (const phase of INTERVIEW_QUESTION_PHASES) {
      expect(phaseMayAskQuestions(phase)).toBe(false)
    }
    expect(phaseMayAskQuestions('CODING')).toBe(true)
    // No status at all means no ticket to ask about.
    expect(phaseMayAskQuestions(undefined)).toBe(false)
  })

  it('clamps a window to the configurable range', () => {
    expect(clampAiQuestionWindowMs(5)).toBe(AI_QUESTION_WINDOW_MIN_MS)
    expect(clampAiQuestionWindowMs(999_999_999)).toBe(AI_QUESTION_WINDOW_MAX_MS)
    expect(clampAiQuestionWindowMs(null)).toBe(AI_QUESTION_WINDOW_DEFAULT_MS)
    expect(clampAiQuestionWindowMs(120_000)).toBe(120_000)
  })
})
