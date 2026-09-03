import type { StructuredFailureClass } from '../lib/structuredOutputRetry'
import type { StructuredIntervention } from '@shared/structuredInterventions'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'

/** Thrown when a ticket is canceled to distinguish from real errors. */
export class CancelledError extends Error {
  constructor(ticketId?: number | string) {
    super(ticketId ? `Ticket ${ticketId} was canceled` : 'Operation canceled')
    this.name = 'CancelledError'
  }
}

/** Throws CancelledError if the signal is already aborted. */
export function throwIfAborted(signal?: AbortSignal, ticketId?: number | string) {
  if (signal?.aborted) throw new CancelledError(ticketId)
}

/**
 * Vote score bounds. The parser, the voter's prompt copy and the strict output
 * instruction all state these numbers, so they are stated once here.
 */
export const MAX_VOTE_CATEGORY_SCORE = 20
export const MAX_VOTE_TOTAL_SCORE = 100

export type MemberOutcome = 'pending' | 'completed' | 'timed_out' | 'invalid_output' | 'failed'

export type RawAttemptOutcome = 'rejected' | 'accepted'

export type RawAttemptStage = 'draft' | 'full_answers' | 'prd_draft' | 'vote' | 'refine' | string

export interface RawAttempt {
  attempt: number
  stage: RawAttemptStage
  outcome: RawAttemptOutcome
  rawResponse: string
  initialInput?: string
  validationError?: string
  failureClass?: StructuredFailureClass
}

export interface DraftMetrics {
  questionCount?: number
  epicCount?: number
  userStoryCount?: number
  beadCount?: number
  totalTestCount?: number
  totalAcceptanceCriteriaCount?: number
}

export interface DraftStructuredOutputMeta {
  repairApplied: boolean
  repairWarnings: string[]
  autoRetryCount: number
  validationError?: string
  retryDiagnostics?: StructuredRetryDiagnostic[]
  interventions?: StructuredIntervention[]
  failureClass?: StructuredFailureClass
}

export interface CouncilMember {
  modelId: string
  name: string
  variant?: string
}

export interface DraftResult {
  memberId: string
  content: string
  outcome: MemberOutcome
  duration: number
  error?: string
  questionCount?: number
  draftMetrics?: DraftMetrics
  structuredOutput?: DraftStructuredOutputMeta
  rawResponse?: string
  normalizedResponse?: string
  rawAttempts?: RawAttempt[]
  skippedReason?: string
  /**
   * This member asked the operator something and got an answer.
   *
   * It therefore drafted against instructions none of the other members saw, and
   * will be judged by voters who did not see them either. Carried through to the
   * vote so a draft that *followed* the operator is not marked down for
   * disagreeing with drafts written without that steering.
   */
  steeredByOperator?: boolean
}

export interface DraftProgressEvent {
  memberId: string
  status: 'session_created' | 'finished'
  sessionId?: string
  outcome?: MemberOutcome
  duration?: number
  error?: string
  content?: string
  questionCount?: number
  draftMetrics?: DraftMetrics
  structuredOutput?: DraftStructuredOutputMeta
  rawResponse?: string
  normalizedResponse?: string
  rawAttempts?: RawAttempt[]
  skippedReason?: string
}

export interface DraftGenerationResult {
  drafts: DraftResult[]
  memberOutcomes: Record<string, MemberOutcome>
  deadlineReached: boolean
}

export interface VoteScore {
  category: string
  score: number
  justification: string
}

export interface Vote {
  voterId: string
  draftId: string
  scores: VoteScore[]
  totalScore: number
}

export interface VotePresentationOrder {
  seed: string
  order: string[]
}

export interface VoterDetail {
  voterId: string
  error?: string
  rawResponse?: string
  normalizedResponse?: string
  structuredOutput?: DraftStructuredOutputMeta
  rawAttempts?: RawAttempt[]
}

export interface VotingPhaseResult {
  votes: Vote[]
  memberOutcomes: Record<string, MemberOutcome>
  deadlineReached: boolean
  presentationOrders: Record<string, VotePresentationOrder>
  voterDetails: VoterDetail[]
}

export interface CouncilResult {
  phase: string
  drafts: DraftResult[]
  votes: Vote[]
  presentationOrders?: Record<string, VotePresentationOrder>
  winnerId: string
  winnerContent: string
  refinedContent: string
  memberOutcomes: Record<string, MemberOutcome>
  isFinal?: boolean
}

/** Returned by draft-only phase functions (before vote/refine). */
export interface DraftPhaseResult {
  phase: string
  drafts: DraftResult[]
  memberOutcomes: Record<string, MemberOutcome>
  deadlineReached?: boolean
  isFinal?: boolean
}

// Phase-specific voting rubrics per cl-prompt.md PROM2/PROM11/PROM21
export const VOTING_RUBRIC_INTERVIEW = [
  { category: 'Coverage of requirements', weight: 20, description: 'Questions address all areas needed to write a PRD (features, constraints, non-goals, acceptance criteria)' },
  { category: 'Correctness / feasibility', weight: 20, description: 'Questions are unambiguous, well-formed, and answerable by the target user' },
  { category: 'Testability', weight: 20, description: 'Answers to these questions would yield verifiable, measurable PRD requirements' },
  { category: 'Minimal complexity / good decomposition', weight: 20, description: 'Logical flow (Foundation → Structure → Assembly), no redundant or low-value questions, and the minimum necessary number of questions to achieve full coverage' },
  { category: 'Risks / edge cases addressed', weight: 20, description: 'Questions surface constraints, failure modes, non-goals, and potential blockers' },
]

export const VOTING_RUBRIC_PRD = [
  { category: 'Coverage of requirements', weight: 20, description: 'PRD fully addresses all Interview Results including features, constraints, non-goals, and acceptance criteria' },
  { category: 'Correctness / feasibility', weight: 20, description: 'Requirements are technically sound, internally consistent, and achievable' },
  { category: 'Testability', weight: 20, description: 'Each requirement and acceptance criterion is specific, measurable, and verifiable' },
  { category: 'Minimal complexity / good decomposition', weight: 20, description: 'Epics and user stories are well-structured, deduplicated, and appropriately scoped with detailed implementation steps' },
  { category: 'Risks / edge cases addressed', weight: 20, description: 'Error states, performance constraints, security concerns, and failure modes are explicitly documented' },
]

export const VOTING_RUBRIC_BEADS = [
  { category: 'Coverage of PRD requirements', weight: 20, description: 'Every in-scope user story and acceptance criterion maps to at least one bead with explicit verification steps' },
  { category: 'Correctness / feasibility of technical approach', weight: 20, description: 'Bead descriptions are technically sound, implementation steps are achievable, and test commands are valid and runnable' },
  { category: 'Quality and isolation of bead-scoped tests', weight: 20, description: 'Each bead defines its own targeted tests (not the full suite), with clear test commands and unambiguous pass/fail criteria' },
  { category: 'Minimal complexity / good dependency management', weight: 20, description: 'Beads are the smallest independently-completable units, no circular or missing dependency edges, no oversized beads' },
  { category: 'Risks / edge cases addressed', weight: 20, description: 'Failure modes, retry scenarios, edge cases from the PRD, and anti-patterns are captured in each bead Context & Architectural Guidance' },
]

export function getVotingRubricForPhase(phase: string) {
  if (phase.startsWith('interview')) return VOTING_RUBRIC_INTERVIEW
  if (phase.startsWith('prd')) return VOTING_RUBRIC_PRD
  if (phase.startsWith('beads')) return VOTING_RUBRIC_BEADS
  return VOTING_RUBRIC_INTERVIEW // default fallback
}

// Keep backward compat alias
export const VOTING_RUBRIC = VOTING_RUBRIC_INTERVIEW
