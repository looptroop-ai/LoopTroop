import { randomUUID } from 'node:crypto'
import type { OpenCodeAdapter } from '../opencode/adapter'
import type {
  CouncilMember,
  DraftResult,
  DraftStructuredOutputMeta,
  MemberOutcome,
  RawAttempt,
  Vote,
  VotePresentationOrder,
  VoteScore,
  VoterDetail,
  VotingPhaseResult,
} from './types'
import { CancelledError } from './types'
import type { Message, PromptPart, StreamEvent } from '../opencode/types'
import type { OpenCodeToolPolicy } from '../opencode/toolPolicy'
import { VOTING_RUBRIC, getVotingRubricForPhase } from './types'
import { formatPromptText, runOpenCodePrompt, type OpenCodePromptDispatchEvent } from '../workflow/runOpenCodePrompt'
import { createWorkBudget } from '../workflow/workBudget'
import { buildStructuredRetryPrompt, normalizeVoteScorecardOutput } from '../structuredOutput'
import { buildStructuredOutputMetadata } from '../structuredOutput/metadata'
import { resolveStructuredRetryDiagnostic } from '../lib/structuredRetryDiagnostics'
import { getStructuredRetryDecision } from '../lib/structuredOutputRetry'
import { normalizeStructuredRetryCount, shouldRetryStructuredOutput } from '../lib/structuredRetryPolicy'
import { appendAcceptedRawAttempt, appendRejectedRawAttempt } from '../lib/structuredRawAttempts'
import { PHASE_DEADLINE_ERROR, isAbortError, isPhaseDeadlineError, isAiResponseTimeoutError } from './draftUtils'
import { getErrorMessage } from '@shared/typeGuards'

function buildStrictVoteSchemaReminder(rubric: typeof VOTING_RUBRIC): string {
  return [
    'Output strict machine-readable YAML with top-level `draft_scores` keyed by the exact presented draft labels (`Draft 1`, `Draft 2`, etc.).',
    `For each draft, include only these integer fields: ${rubric.map(item => `\`${item.category}\``).join(', ')}, and \`total_score\`.`,
    'Each rubric score must be an integer from 0 to 20. `total_score` must equal the sum of the rubric scores for that draft.',
    'Do not output prose, markdown fences, rankings, winners, comments, or extra keys.',
  ].join('\n')
}

interface PresentedDraft {
  draftId: string
  content: string
}

function hashSeed(seed: string): number {
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function createSeededRandom(seed: string) {
  let state = hashSeed(seed) || 1
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Anonymize and randomize drafts per voter with a replayable seed.
export function buildVotePresentationOrder(
  drafts: DraftResult[],
  seed: string,
): PresentedDraft[] {
  const shuffled = drafts
    .filter(draft => draft.outcome === 'completed' && draft.content)
    .map(draft => ({ draftId: draft.memberId, content: draft.content }))
  const nextRandom = createSeededRandom(seed)

  for (let index = shuffled.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(nextRandom() * (index + 1))
    const current = shuffled[index]
    shuffled[index] = shuffled[swapIndex]!
    shuffled[swapIndex] = current!
  }

  return shuffled.map((draft, index) => ({
    draftId: draft.draftId,
    content: `Draft ${index + 1}:\n${draft.content}`,
  }))
}

export async function conductVoting(
  adapter: OpenCodeAdapter,
  voters: CouncilMember[],
  drafts: DraftResult[],
  contextParts: PromptPart[],
  projectPath: string,
  phase?: string,
  timeoutMs?: number,
  signal?: AbortSignal,
  onOpenCodeSessionLog?: (entry: {
    stage: 'draft' | 'vote' | 'refine'
    memberId: string
    sessionId: string
    response: string
    messages: Message[]
  }) => void,
  onOpenCodeStreamEvent?: (entry: {
    stage: 'vote'
    memberId: string
    sessionId: string
    event: StreamEvent
  }) => void,
  onOpenCodePromptDispatched?: (entry: {
    stage: 'vote'
    memberId: string
    event: OpenCodePromptDispatchEvent
  }) => void,
  onVoteProgress?: (entry: {
    memberId: string
    outcome: MemberOutcome
    votes: Vote[]
    error?: string
    rawResponse?: string
    normalizedResponse?: string
    structuredOutput?: DraftStructuredOutputMeta
    rawAttempts?: RawAttempt[]
  }) => void,
  buildPromptForVoter?: (entry: {
    voter: CouncilMember
    anonymizedDrafts: PresentedDraft[]
    rubric: typeof VOTING_RUBRIC
  }) => PromptPart[],
  sessionOwnership?: {
    ticketId: string
    phase: string
    phaseAttempt?: number
  },
  toolPolicy: OpenCodeToolPolicy = 'default',
  maxStructuredRetries: number = 1,
): Promise<VotingPhaseResult> {
  const votes: Vote[] = []
  const validDrafts = drafts.filter(d => d.outcome === 'completed' && d.content)
  const rubric = phase ? getVotingRubricForPhase(phase) : VOTING_RUBRIC
  const presentationOrders: Record<string, VotePresentationOrder> = {}
  const memberOutcomes = voters.reduce<Record<string, MemberOutcome>>((outcomes, voter) => {
    outcomes[voter.modelId] = 'pending'
    return outcomes
  }, {})
  const finalizedMembers = new Set<string>()
  const voterDetailMap = new Map<string, VoterDetail>()
  // One budget for the round. Same reason as the drafter: this timer is its own
  // `Promise.race`, invisible to the prompt timer, so a voter blocked on a
  // question would otherwise lose the round while waiting for an answer.
  const budget = createWorkBudget({
    ...(sessionOwnership?.ticketId ? { ticketId: sessionOwnership.ticketId } : {}),
    ...(timeoutMs && timeoutMs > 0 ? { totalMs: timeoutMs } : {}),
    scope: 'council_member',
  })
  let deadlineReached = false

  function buildStructuredOutputMeta(
    repairApplied: boolean,
    repairWarnings: string[],
    autoRetryCount: number,
    validationError?: string,
    retryDiagnostics?: DraftStructuredOutputMeta['retryDiagnostics'],
  ): DraftStructuredOutputMeta {
    return buildStructuredOutputMetadata(undefined, {
      repairApplied,
      repairWarnings,
      autoRetryCount,
      ...(validationError ? { validationError } : {}),
      ...(retryDiagnostics && retryDiagnostics.length > 0 ? { retryDiagnostics } : {}),
    })
  }

  function recordOutcome(
    memberId: string,
    outcome: MemberOutcome,
    voterVotes: Vote[],
    error?: string,
    structuredOutput?: DraftStructuredOutputMeta,
    rawResponse?: string,
    normalizedResponse?: string,
    rawAttempts?: RawAttempt[],
  ): boolean {
    if (finalizedMembers.has(memberId)) return false

    finalizedMembers.add(memberId)
    memberOutcomes[memberId] = outcome
    voterDetailMap.set(memberId, {
      voterId: memberId,
      ...(error ? { error } : {}),
      ...(typeof rawResponse === 'string' ? { rawResponse } : {}),
      ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
      ...(structuredOutput ? { structuredOutput } : {}),
      ...(rawAttempts && rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
    })
    if (outcome === 'completed' && voterVotes.length > 0) {
      votes.push(...voterVotes)
    }
    onVoteProgress?.({
      memberId,
      outcome,
      votes: voterVotes,
      error,
      rawResponse,
      normalizedResponse,
      structuredOutput,
      ...(rawAttempts && rawAttempts.length > 0 ? { rawAttempts: [...rawAttempts] } : {}),
    })
    return true
  }

  if (validDrafts.length === 0) {
    return { votes, memberOutcomes, deadlineReached: false, presentationOrders, voterDetails: [] }
  }

  const promises = voters.map(async (voter): Promise<Vote[]> => {
    const presentationSeed = randomUUID()
    const anonymized = buildVotePresentationOrder(validDrafts, presentationSeed)
    presentationOrders[voter.modelId] = {
      seed: presentationSeed,
      order: anonymized.map(draft => draft.draftId),
    }
    const voterVotes: Vote[] = []
    let sessionId = ''
    let closed = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let response = ''
    const rawAttempts: RawAttempt[] = []

    const markTimedOut = async () => {
      if (closed) return
      closed = true
      deadlineReached = true
      if (sessionId) {
        await adapter.abortSession(sessionId)
      }
    }

    const executeVote = (async () => {
      const votingPrompt = buildPromptForVoter
        ? buildPromptForVoter({ voter, anonymizedDrafts: anonymized, rubric })
        : [
            ...contextParts,
            {
              type: 'text' as const,
              content: [
                'Score each draft on these categories (0-20 points each):',
                ...rubric.map(r => `- ${r.category} (${r.weight}pts): ${r.description}`),
                '',
                ...anonymized.map(d => d.content),
                '',
                buildStrictVoteSchemaReminder(rubric),
              ].join('\n'),
            },
          ]
      let promptParts = votingPrompt
      const initialInput = formatPromptText(votingPrompt)
      let result: Awaited<ReturnType<typeof runOpenCodePrompt>> | undefined
      let attemptCount = 0
      let lastValidationError: string | undefined
      const normalizedMaxStructuredRetries = normalizeStructuredRetryCount(maxStructuredRetries)
      const retryDiagnostics: NonNullable<DraftStructuredOutputMeta['retryDiagnostics']> = []

      while (true) {
        if (budget.expired()) {
          throw new Error(PHASE_DEADLINE_ERROR)
        }

        result = await runOpenCodePrompt({
          adapter,
          projectPath,
          parts: promptParts,
          signal,
          workBudget: budget,
          timeoutKind: 'ai_response',
          model: voter.modelId,
          variant: voter.variant,
          toolPolicy,
          ...(sessionOwnership
            ? {
                sessionOwnership: {
                  ticketId: sessionOwnership.ticketId,
                  phase: sessionOwnership.phase,
                  phaseAttempt: sessionOwnership.phaseAttempt ?? 1,
                  memberId: voter.modelId,
                },
              }
            : {}),
          onSessionCreated: (session) => {
            if (closed) {
              void adapter.abortSession(session.id)
              return
            }

            sessionId = session.id
          },
          onStreamEvent: (event) => {
            if (closed) return
            onOpenCodeStreamEvent?.({
              stage: 'vote',
              memberId: voter.modelId,
              sessionId,
              event,
            })
          },
          onPromptDispatched: (event) => {
            if (closed) return
            onOpenCodePromptDispatched?.({
              stage: 'vote',
              memberId: voter.modelId,
              event,
            })
          },
        })

        if (closed) {
          return voterVotes
        }

        response = result.response

        onOpenCodeSessionLog?.({
          stage: 'vote',
          memberId: voter.modelId,
          sessionId: result.session.id,
          response,
          messages: result.messages,
        })

        const scorecardResult = normalizeVoteScorecardOutput(
          response,
          anonymized.map((_, index) => `Draft ${index + 1}`),
          rubric.map((item) => item.category),
        )

        if (scorecardResult.ok) {
          appendAcceptedRawAttempt(rawAttempts, {
            stage: 'vote',
            rawResponse: response,
            initialInput,
          })
          const normalizedResponse = scorecardResult.repairApplied || scorecardResult.normalizedContent.trim() !== response.trim()
            ? scorecardResult.normalizedContent
            : undefined
          const structuredOutput = buildStructuredOutputMeta(
            scorecardResult.repairApplied,
            scorecardResult.repairWarnings,
            attemptCount,
            lastValidationError,
            retryDiagnostics,
          )
          for (const [draftIndex, draft] of anonymized.entries()) {
            const draftLabel = `Draft ${draftIndex + 1}`
            const normalizedScores = scorecardResult.value.draftScores[draftLabel] ?? {}
            const scores: VoteScore[] = rubric.map((rubricItem) => ({
              category: rubricItem.category,
              score: normalizedScores[rubricItem.category] ?? 0,
              justification: 'Evaluated by council member',
            }))
            voterVotes.push({
              voterId: voter.modelId,
              draftId: draft.draftId,
              scores,
              totalScore: normalizedScores.total_score ?? scores.reduce((sum, score) => sum + score.score, 0),
            })
          }
          if (!recordOutcome(voter.modelId, 'completed', voterVotes, undefined, structuredOutput, response, normalizedResponse, rawAttempts)) {
            return voterVotes
          }
          break
        }

        lastValidationError = scorecardResult.error
        const retryDecision = getStructuredRetryDecision(response, result.responseMeta)
        const rawAttempt = appendRejectedRawAttempt(rawAttempts, {
          stage: 'vote',
          rawResponse: response,
          initialInput,
          validationError: scorecardResult.error,
          failureClass: retryDecision.failureClass,
        })
        retryDiagnostics.push(resolveStructuredRetryDiagnostic({
          attempt: rawAttempt.attempt,
          rawResponse: response,
          validationError: scorecardResult.error,
          failureClass: retryDecision.failureClass,
          retryDiagnostic: scorecardResult.retryDiagnostic,
        }))
        if (!shouldRetryStructuredOutput(attemptCount, normalizedMaxStructuredRetries)) {
          const structuredOutput = buildStructuredOutputMeta(
            scorecardResult.repairApplied,
            scorecardResult.repairWarnings,
            attemptCount,
            scorecardResult.error,
            retryDiagnostics,
          )
          recordOutcome(
            voter.modelId,
            'invalid_output',
            [],
            scorecardResult.error,
            structuredOutput,
            response,
            undefined,
            rawAttempts,
          )
          return voterVotes
        }

        attemptCount += 1
        promptParts = buildStructuredRetryPrompt(votingPrompt, {
          validationError: scorecardResult.error,
          rawResponse: response,
          schemaReminder: buildStrictVoteSchemaReminder(rubric),
        })
      }

      return voterVotes
    })()

    // Cleared while suspended and re-armed on resume, so a question wait moves
    // the round's deadline instead of expiring the voter waiting on the answer.
    let unsubscribeBudget: (() => void) | undefined
    const deadlinePromise = budget.totalMs === undefined
      ? null
      : new Promise<never>((_, reject) => {
        const armRoundTimer = () => {
          if (timeoutHandle) {
            clearTimeout(timeoutHandle)
            timeoutHandle = undefined
          }
          if (closed || budget.suspended()) return
          timeoutHandle = setTimeout(() => {
            void markTimedOut()
            reject(new Error(PHASE_DEADLINE_ERROR))
          }, Math.max(0, budget.remainingMs() ?? 0))
        }
        unsubscribeBudget = budget.onChange(armRoundTimer)
        armRoundTimer()
      })

    try {
      return deadlinePromise
        ? await Promise.race([executeVote, deadlinePromise])
        : await executeVote
    } catch (error) {
      if (signal?.aborted || error instanceof CancelledError || (isAbortError(error) && signal?.aborted)) {
        throw new CancelledError()
      }

      const errorDetail = getErrorMessage(error)
      const timedOut = isPhaseDeadlineError(error) || isAiResponseTimeoutError(error) || closed
      if (timedOut) {
        deadlineReached = true
      }
      const outcome: MemberOutcome = timedOut
        ? 'timed_out'
        : 'failed'
      recordOutcome(voter.modelId, outcome, [], outcome === 'timed_out'
        ? `AI response timeout reached after ${timeoutMs}ms`
        : errorDetail,
      undefined,
      response || undefined,
      undefined,
      rawAttempts)
      return []
    } finally {
      unsubscribeBudget?.()
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
  })

  const settled = await Promise.allSettled(promises)
  budget.release()
  if (signal?.aborted) {
    throw new CancelledError()
  }

  for (const result of settled) {
    if (result.status === 'rejected') {
      throw result.reason
    }
  }

  return {
    votes,
    memberOutcomes,
    deadlineReached,
    presentationOrders,
    voterDetails: [...voterDetailMap.values()],
  }
}

// Select winner: highest score, MAI (first member) wins ties
export function selectWinner(
  votes: Vote[],
  members: CouncilMember[],
): { winnerId: string; totalScore: number } {
  const scoreMap = new Map<string, number>()

  for (const vote of votes) {
    const current = scoreMap.get(vote.draftId) ?? 0
    scoreMap.set(vote.draftId, current + vote.totalScore)
  }

  let winnerId = members[0]?.modelId ?? ''
  let winnerScore = 0

  for (const [memberId, score] of scoreMap) {
    if (score > winnerScore || (score === winnerScore && memberId === members[0]?.modelId)) {
      winnerId = memberId
      winnerScore = score
    }
  }

  return { winnerId, totalScore: winnerScore }
}
