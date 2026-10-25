import { expect } from 'vitest'
import { parseUiArtifactCompanionArtifact } from '@shared/artifactCompanions'
import { opencodeSessions } from '../../db/schema'
import { requestSessionContinuation } from '../../opencode/sessionContinuation'
import { getLatestPhaseArtifact } from '../../storage/tickets'
import { getTicketContext } from '../../storage/ticketQueries'

type CoverageDomain = 'prd' | 'beads'

function coveragePhase(domain: CoverageDomain) {
  return domain === 'prd' ? 'VERIFYING_PRD_COVERAGE' : 'VERIFYING_BEADS_COVERAGE'
}

export function continueCoverageSession(input: {
  ticketId: string
  domain: CoverageDomain
  sessionId: string
  memberId: string
  step: 'audit' | 'revision'
}): void {
  const phase = coveragePhase(input.domain)
  const stored = getTicketContext(input.ticketId)
  if (!stored) throw new Error(`Ticket not found: ${input.ticketId}`)

  stored.projectDb.insert(opencodeSessions).values({
    ticketId: stored.localTicketId,
    sessionId: input.sessionId,
    phase,
    phaseAttempt: 1,
    memberId: input.memberId,
    step: input.step,
    state: 'active',
  }).run()
  requestSessionContinuation({ ticketId: input.ticketId, phase, sessionId: input.sessionId })
}

export function expectCleanCoverageAttempts(input: {
  ticketId: string
  domain: CoverageDomain
  finalCandidateVersion: number
  gap: string
  transitionContent?: [string, string]
}): void {
  const phase = coveragePhase(input.domain)
  const coverage = getLatestPhaseArtifact(input.ticketId, `${input.domain}_coverage`, phase)
  expect(coverage).toBeDefined()
  expect(JSON.parse(coverage!.content)).toMatchObject({
    status: 'clean',
    finalCandidateVersion: input.finalCandidateVersion,
    hasRemainingGaps: false,
    remainingGaps: [],
  })

  const companion = getLatestPhaseArtifact(input.ticketId, `ui_artifact_companion:${input.domain}_coverage`, phase)
  expect(companion).toBeDefined()
  const payload = parseUiArtifactCompanionArtifact(companion!.content)?.payload
  const transitions = Array.from({ length: input.finalCandidateVersion - 1 }, (_, index) => ({
    fromVersion: index + 1,
    toVersion: index + 2,
    gaps: [input.gap],
    ...(index === 0 && input.transitionContent
      ? {
          fromContent: expect.stringContaining(input.transitionContent[0]),
          toContent: expect.stringContaining(input.transitionContent[1]),
        }
      : {}),
  }))

  expect(payload).toMatchObject({
    finalCandidateVersion: input.finalCandidateVersion,
    hasRemainingGaps: false,
    remainingGaps: [],
    attempts: [
      ...Array.from({ length: input.finalCandidateVersion - 1 }, (_, index) => expect.objectContaining({
        candidateVersion: index + 1,
        status: 'gaps',
        gaps: [input.gap],
      })),
      expect.objectContaining({
        candidateVersion: input.finalCandidateVersion,
        status: 'clean',
        gaps: [],
      }),
    ],
    transitions: transitions.map(transition => expect.objectContaining(transition)),
  })
}
