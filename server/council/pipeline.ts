import type { OpenCodeAdapter } from '../opencode/adapter'
import type { CouncilMember, CouncilResult, DraftResult, MemberOutcome } from './types'
import { throwIfAborted } from './types'
import type { Message, PromptPart } from '../opencode/types'
import { generateDrafts } from './drafter'
import { conductVoting, selectWinner } from './voter'
import { refineDraft } from './refiner'
import { requireWinnerDraft } from './draftUtils'
import { checkMemberResponseQuorum, checkQuorum } from './quorum'
import { COUNCIL_RESPONSE_TIMEOUT_MS } from '../lib/constants'

export interface OpenCodeSessionLog {
  stage: 'draft' | 'vote' | 'refine'
  memberId: string
  sessionId: string
  response: string
  messages: Message[]
}

interface PipelineOptions {
  phase: string
  members: CouncilMember[]
  contextParts: PromptPart[]
  projectPath: string
  minQuorum?: number
  draftTimeout?: number
  signal?: AbortSignal
  /** Optional callback to rebuild context between council steps. */
  contextBuilder?: (step: 'vote' | 'refine', drafts: DraftResult[]) => PromptPart[]
  /** Optional callback to stream complete OpenCode transcript per council session. */
  onOpenCodeSessionLog?: (entry: OpenCodeSessionLog) => void
}

export async function runCouncilPipeline(
  adapter: OpenCodeAdapter,
  options: PipelineOptions,
): Promise<CouncilResult> {
  const {
    phase,
    members,
    contextParts,
    projectPath,
    minQuorum = 2,
    draftTimeout = COUNCIL_RESPONSE_TIMEOUT_MS,
    signal,
    contextBuilder,
    onOpenCodeSessionLog,
  } = options

  // Step 1: Draft — parallel generation
  throwIfAborted(signal)
  const draftRun = await generateDrafts(
    adapter,
    members,
    contextParts,
    projectPath,
    draftTimeout,
    signal,
    onOpenCodeSessionLog,
    undefined,
    undefined,
    undefined,
  )

  // Step 2: Quorum check
  throwIfAborted(signal)
  const quorum = checkQuorum(draftRun.drafts, minQuorum)
  if (!quorum.passed) {
    throw new Error(`Council quorum not met for ${phase}: ${quorum.message}`)
  }

  // Per arch.md §9.1: rebuild context between council steps when a builder is provided
  const voteContext = contextBuilder ? contextBuilder('vote', draftRun.drafts) : contextParts

  // Step 3: Vote — parallel anonymized voting
  throwIfAborted(signal)
  const voteRun = await conductVoting(
    adapter,
    members,
    draftRun.drafts,
    voteContext,
    projectPath,
    phase,
    draftTimeout,
    signal,
    onOpenCodeSessionLog,
  )
  const voteQuorum = checkMemberResponseQuorum(voteRun.memberOutcomes, minQuorum)
  if (!voteQuorum.passed) {
    throw new Error(`Council voting quorum not met for ${phase}: ${voteQuorum.message}`)
  }
  if (voteRun.votes.length === 0) {
    throw new Error(`Council voting failed for ${phase}: no valid vote responses received`)
  }

  // Step 4: Select winner
  throwIfAborted(signal)
  const { winnerId } = selectWinner(voteRun.votes, members)
  const winnerDraft = requireWinnerDraft(draftRun.drafts, winnerId, `Council ${phase}`)
  const losingDrafts = draftRun.drafts.filter(d => d.memberId !== winnerId && d.outcome === 'completed')

  // Step 5: Refine — sequential
  throwIfAborted(signal)
  const refineContext = contextBuilder ? contextBuilder('refine', draftRun.drafts) : contextParts
  const refinementRun = await refineDraft(
    adapter,
    winnerDraft,
    losingDrafts,
    refineContext,
    projectPath,
    draftTimeout,
    signal,
    onOpenCodeSessionLog,
  )
  const refinedContent = refinementRun.content

  // Build outcome map
  const memberOutcomes: Record<string, MemberOutcome> = {}
  for (const draft of draftRun.drafts) {
    memberOutcomes[draft.memberId] = draft.outcome
  }

  return {
    phase,
    drafts: draftRun.drafts,
    votes: voteRun.votes,
    presentationOrders: voteRun.presentationOrders,
    winnerId,
    winnerContent: winnerDraft.content,
    refinedContent,
    memberOutcomes,
  }
}
