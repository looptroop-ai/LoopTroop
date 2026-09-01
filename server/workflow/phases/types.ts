import type { DraftResult, MemberOutcome, Vote, VotePresentationOrder } from '../../council/types'
import type { PromptPart } from '../../opencode/types'
import type { TicketState } from '../../opencode/contextBuilder'

/** Intermediate data stored between draft→vote→refine state machine phases. */
export interface PhaseIntermediateData {
  drafts: DraftResult[]
  fullAnswers?: DraftResult[]
  memberOutcomes: Record<string, MemberOutcome>
  contextBuilder?: (step: 'vote' | 'refine') => PromptPart[]
  worktreePath: string
  /**
   * The council *stage* — `prd_draft`, `beads`, `interview` — not a workflow
   * status, despite the name it shares with one. Narrowing this to
   * `WorkflowPhaseId` was tried and does not compile.
   */
  phase: string
  ticketState?: TicketState
  votes?: Vote[]
  presentationOrders?: Record<string, VotePresentationOrder>
  winnerId?: string
}

export type StructuredLogAudience = 'all' | 'ai' | 'debug'
export type StructuredLogKind = 'milestone' | 'reasoning' | 'text' | 'assistant' | 'tool' | 'step' | 'session' | 'prompt' | 'error' | 'test'
export type StructuredLogOp = 'append' | 'upsert' | 'finalize'
import type { PromptTimeoutKind } from '@shared/promptTimeout'
export type { PromptTimeoutKind }

export interface StructuredLogFields extends Record<string, unknown> {
  entryId: string
  fingerprint?: string
  audience: StructuredLogAudience
  kind: StructuredLogKind
  op: StructuredLogOp
  source: string
  modelId?: string
  variant?: string
  sessionId?: string
  beadId?: string
  beadIteration?: number
  timeoutMs?: number
  deadlineAt?: string
  timeoutKind?: PromptTimeoutKind
  streaming?: boolean
  suppressDebugMirror?: boolean
}

export interface OpenCodeStreamState {
  seenFirstActivity: boolean
  liveKinds: Map<string, StructuredLogKind>
  liveContents: Map<string, string>
  liveStreamEmissions: Map<string, {
    lastEmittedAt: number
  }>
  todoStatuses: Map<string, string>
  liveTextMessages: Map<string, {
    entryId: string
    partOrder: string[]
    partTexts: Map<string, string>
  }>
  textPartToMessageIds: Map<string, string>
  finalizedTextEntryIds: Set<string>
  finalizedDetailEntryIds: Set<string>
}
