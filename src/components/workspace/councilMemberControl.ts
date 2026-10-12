import { createContext, useRef, useState } from 'react'
import {
  COUNCIL_DRAFTING_CONTROL_PHASES,
  type CouncilMemberControlPhase,
  type CouncilMemberRetryPart,
} from '@shared/councilMembers'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { useCouncilMemberControl, type CouncilMemberControlAction } from '@/hooks/useCouncilMemberControl'
import { isFailedCouncilOutcome } from './artifactCompanionUtils'
import type { CouncilMemberArtifactChip, CouncilOutcome, CouncilRoundMeta } from './councilArtifacts'

/** The council step whose models a person may stop or restart right now. */
export interface CouncilMemberControlScope {
  ticketId: string
  phase: CouncilMemberControlPhase
}

/**
 * Provided by the live council view only, and only while the ticket is in the
 * step it shows and the version shown is the current one. Review screens and
 * archived versions render the same panels without it, so they offer nothing.
 */
export const CouncilMemberControlContext = createContext<CouncilMemberControlScope | null>(null)

export interface CouncilRoundMember {
  memberId: string
  outcome?: CouncilOutcome
}

/**
 * Whether the round can still take a stop or a retry. A step ends the moment no
 * model is still working, and the server refuses both from then on.
 */
export function isCouncilRoundOpen(meta: CouncilRoundMeta | null, round: readonly CouncilRoundMember[]): boolean {
  return meta !== null && !meta.isFinal && round.some((member) => member.outcome === 'pending')
}

export interface CouncilMemberConfirmCopy {
  question: string
  consequence: string
  /** Set only when a stop leaves the step short of the results it needs. */
  warning: string | null
  confirmLabel: string
  destructive: boolean
}

/** What one model's controls offer, and what each confirmation says. */
export interface CouncilMemberControl {
  memberId: string
  canStop: boolean
  /** Sent with a retry. Only `DRAFTING_PRD` has parts. */
  part: CouncilMemberRetryPart | undefined
  stop: CouncilMemberConfirmCopy
  retry: CouncilMemberConfirmCopy
}

/** What a retry throws away when the model had finished. */
type CouncilMemberResult = 'draft' | 'answers' | 'vote'
/** How much of the step a retry redoes. Only `DRAFTING_PRD` can keep a part. */
type RetryScope = 'step' | 'both_parts' | 'draft_only'

const FINISHED_RESULT_NAMES: Record<CouncilMemberResult, string> = {
  draft: 'draft',
  answers: 'answers',
  vote: 'vote',
}

/** "Its finished draft is", "Its finished answers and PRD draft are", ... thrown away for good. */
function describeFinishedResultsLost(lost: readonly CouncilMemberResult[]): string {
  const names = lost.map((result, index) => (
    // The PRD draft is named as such once answers come first.
    index > 0 && result === 'draft' ? 'PRD draft' : FINISHED_RESULT_NAMES[result]
  ))
  const plural = names.length > 1 || lost[0] === 'answers'
  return `Its finished ${names.join(' and ')} ${plural ? 'are' : 'is'} thrown away for good.`
}

const RETRY_SCOPE: Record<RetryScope, string> = {
  step: 'It starts this step again with a full new time limit.',
  both_parts: 'It redoes both parts with a full new time limit.',
  draft_only: 'It keeps its Part 1 answers and redoes only the PRD draft, with a full new time limit.',
}

function buildStopCopy(
  name: string,
  memberId: string,
  round: readonly CouncilRoundMember[],
  minQuorum: number | null,
  /** Finished results the stop throws away too: a PRD model's Part 1 answers. */
  finishedLost: readonly CouncilMemberResult[],
): CouncilMemberConfirmCopy {
  const othersWorking = round.some((member) => member.outcome === 'pending' && member.memberId !== memberId)
  // What can still arrive once this model stops: the finished results and the
  // other models still working. A failed, timed out or stopped model is done.
  const reachable = round.filter((member) => (
    member.outcome === 'completed' || (member.outcome === 'pending' && member.memberId !== memberId)
  )).length
  const needed = minQuorum === null ? '' : `This step needs ${minQuorum} ${minQuorum === 1 ? 'result' : 'results'} and ${reachable === 0 ? 'none' : `only ${reachable}`} can still arrive`
  return {
    question: `Stop ${name}?`,
    consequence: [
      finishedLost.length > 0 ? describeFinishedResultsLost(finishedLost) : null,
      othersWorking
        ? 'Its unfinished work is thrown away and the step goes on with the other models.'
        : 'Its unfinished work is thrown away and the step moves on without it.',
    ].filter(Boolean).join(' '),
    warning: minQuorum !== null && reachable < minQuorum
      ? othersWorking
        ? `${needed}. Unless you retry another model in time, the step will fail and the ticket will stop with an error.`
        : `${needed}, so the step will fail and the ticket will stop with an error. You can retry the whole step from there.`
      : null,
    confirmLabel: 'Stop model',
    destructive: true,
  }
}

function buildRetryCopy(
  name: string,
  working: boolean,
  lost: readonly CouncilMemberResult[],
  scope: RetryScope,
): CouncilMemberConfirmCopy {
  const sentences: string[] = []
  if (lost.length > 0) sentences.push(describeFinishedResultsLost(lost))
  if (working) sentences.push('Its unfinished work is thrown away.')
  sentences.push(RETRY_SCOPE[scope])
  if (lost.length > 0) sentences.push(`If the new run fails, ${name} counts as failed.`)
  return {
    question: `${working ? 'Restart' : 'Retry'} ${name}?`,
    consequence: sentences.join(' '),
    warning: null,
    confirmLabel: working ? 'Restart model' : 'Retry model',
    destructive: lost.length > 0,
  }
}

function buildMemberControl({ memberId, working, lost, stopLoses = [], round, minQuorum, scope, part }: {
  memberId: string
  /** Whether the model is still working on this step, in any part of it. */
  working: boolean
  /** Finished results a retry would throw away, in the order they were made. */
  lost: readonly CouncilMemberResult[]
  /** Finished results a stop would throw away. */
  stopLoses?: readonly CouncilMemberResult[]
  /** Every member as the step's quorum counts them. */
  round: readonly CouncilRoundMember[]
  minQuorum: number | null
  scope: RetryScope
  part: CouncilMemberRetryPart | undefined
}): CouncilMemberControl {
  const name = getModelDisplayName(memberId)
  return {
    memberId,
    canStop: working,
    part,
    stop: buildStopCopy(name, memberId, round, minQuorum, stopLoses),
    retry: buildRetryCopy(name, working, lost, scope),
  }
}

const DRAFTING_CONTROL_PHASES: readonly string[] = COUNCIL_DRAFTING_CONTROL_PHASES

/**
 * The controls a drafting step's member dialog offers for `chip`, or null when
 * it offers none: another status, or a round that is over.
 *
 * `draftChips` are what the quorum counts, which in `DRAFTING_PRD` are the Part 2
 * chips. A model still on Part 1 is pending there too, so they also say whether
 * anyone is still working. `fullAnswerChips` are the Part 1 chips, empty
 * elsewhere.
 */
export function getDraftMemberControl(
  phase: string,
  chip: CouncilMemberArtifactChip,
  draftChips: readonly CouncilMemberArtifactChip[],
  fullAnswerChips: readonly CouncilMemberArtifactChip[],
  meta: CouncilRoundMeta | null,
): CouncilMemberControl | null {
  if (!DRAFTING_CONTROL_PHASES.includes(phase)) return null
  const round = draftChips.map((draft) => ({ memberId: draft.modelId, outcome: draft.outcome }))
  if (meta === null || !isCouncilRoundOpen(meta, round)) return null

  if (phase !== 'DRAFTING_PRD') {
    return buildMemberControl({
      memberId: chip.modelId,
      working: chip.outcome === 'pending',
      lost: chip.outcome === 'completed' ? ['draft'] : [],
      round,
      minQuorum: meta.minQuorum,
      scope: 'step',
      part: undefined,
    })
  }

  // One model, two chips. The model is working while its PRD draft (Part 2) is
  // pending, whichever part it is on, so both chips offer Stop then.
  const isFullAnswers = fullAnswerChips.some((answers) => answers.key === chip.key)
  const answersFinished = fullAnswerChips.find((answers) => answers.modelId === chip.modelId)?.outcome === 'completed'
  const draftOutcome = draftChips.find((draft) => draft.modelId === chip.modelId)?.outcome
  // Part 1 redoes both parts. Part 2 keeps Part 1 answers that passed validation.
  const keepsAnswers = !isFullAnswers && answersFinished
  return buildMemberControl({
    memberId: chip.modelId,
    working: draftOutcome === 'pending',
    lost: [
      ...(answersFinished && !keepsAnswers ? ['answers' as const] : []),
      ...(draftOutcome === 'completed' ? ['draft' as const] : []),
    ],
    // A stop throws away everything the model did in this step, Part 1 included.
    stopLoses: answersFinished ? ['answers'] : [],
    round,
    minQuorum: meta.minQuorum,
    scope: keepsAnswers ? 'draft_only' : 'both_parts',
    part: isFullAnswers ? 'full_answers' : 'prd_draft',
  })
}

/** The controls on one voter's badge. The caller checks the round is open. */
export function getVoteMemberControl(
  voterId: string,
  round: readonly CouncilRoundMember[],
  minQuorum: number | null,
): CouncilMemberControl {
  const outcome = round.find((member) => member.memberId === voterId)?.outcome
  return buildMemberControl({
    memberId: voterId,
    working: outcome === 'pending',
    lost: outcome === 'completed' ? ['vote'] : [],
    round,
    minQuorum,
    scope: 'step',
    part: undefined,
  })
}

/**
 * What to say after a stop the model beat: the server answers with how the
 * turn really ended, and anything but `stopped` means the stop did nothing.
 */
export function describeStopResult(memberId: string, outcome: unknown): string | null {
  const name = getModelDisplayName(memberId)
  if (outcome === 'completed') return `${name} finished before it could be stopped.`
  if (isFailedCouncilOutcome(outcome) && outcome !== 'stopped') return `${name} ended on its own before it could be stopped.`
  return null
}

export interface CouncilMemberControlRequest {
  action: CouncilMemberControlAction
  memberId: string
  part?: CouncilMemberRetryPart
}

/**
 * The open confirmation for one set of member controls, and the request it sends.
 *
 * Nothing is sent until the person confirms. A stop the model beat leaves a
 * notice; any refusal stays in `error` until the confirmation is cancelled or
 * another one is opened.
 */
export function useCouncilMemberConfirmation(scope: CouncilMemberControlScope) {
  const control = useCouncilMemberControl()
  const [request, setRequest] = useState<CouncilMemberControlRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Set synchronously, so a second click landing before the next render cannot
  // send the request twice.
  const sending = useRef(false)

  return {
    request,
    notice,
    isPending: control.isPending,
    error: control.error,
    // A reset mutation never calls the `onSettled` given to `mutate`, so the
    // guard is cleared here too rather than left set for good.
    open(next: CouncilMemberControlRequest) {
      control.reset()
      sending.current = false
      setNotice(null)
      setRequest(next)
    },
    cancel() {
      control.reset()
      sending.current = false
      setRequest(null)
    },
    confirm() {
      if (!request || sending.current) return
      sending.current = true
      const sent = request
      control.mutate({ ...sent, ticketId: scope.ticketId, phase: scope.phase }, {
        onSuccess: (result) => {
          setRequest(null)
          if (sent.action === 'stop' && 'outcome' in result) setNotice(describeStopResult(sent.memberId, result.outcome))
        },
        onSettled: () => {
          sending.current = false
        },
      })
    },
  }
}

export type CouncilMemberConfirmation = ReturnType<typeof useCouncilMemberConfirmation>
