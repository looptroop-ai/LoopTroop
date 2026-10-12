import type { Context } from 'hono'
import type {
  CouncilMemberControlErrorResponse,
  CouncilMemberRetryResponse,
  CouncilMemberStopResponse,
} from '@shared/councilMembers'
import { getErrorMessage } from '@shared/typeGuards'
import type { WorkflowPhaseId } from '@shared/workflowMeta'
import {
  CouncilMemberControlError,
  retryCouncilMember,
  stopCouncilMember,
} from '../../council/memberControl'
import { getTicketContext } from '../../storage/tickets'
import { attributeMemberQuestions } from '../../workflow/questionWindows'
import { emitRoutePhaseLog, getTicketParam } from './routeUtils'
import { councilMemberRetrySchema, councilMemberStopSchema } from './schemas'

/**
 * Files the member's open AI questions under the person's decision.
 *
 * Runs inside the stop or retry, after its checks and right before the member
 * is interrupted, so the question is closed by the same session stop that ends
 * the model's turn and cannot be answered or refused by anything in between.
 */
function attributeQuestionsTo(
  ticketId: string,
  phase: WorkflowPhaseId,
  memberId: string,
  resolution: 'member_stopped' | 'member_restarted',
): () => void {
  return () => {
    attributeMemberQuestions(ticketId, phase, memberId, {
      actor: 'user',
      resolution,
      reason: resolution === 'member_stopped'
        ? 'You stopped this model while its question was open.'
        : 'You restarted this model while its question was open.',
    })
  }
}

function respondWithControlError(c: Context, error: unknown) {
  if (error instanceof CouncilMemberControlError) {
    const status = error.code === 'STOP_UNCONFIRMED' ? 500 : 409
    return c.json({ error: error.message, code: error.code } satisfies CouncilMemberControlErrorResponse, status)
  }
  return c.json({
    error: 'Could not reach that council model',
    details: getErrorMessage(error),
  } satisfies CouncilMemberControlErrorResponse, 500)
}

export async function handleStopCouncilMember(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketContext(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = councilMemberStopSchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid council member stop payload', details: parsed.error.flatten() }, 400)
  }
  const { phase, memberId } = parsed.data

  try {
    const outcome = await stopCouncilMember(ticketId, phase, memberId, attributeQuestionsTo(ticketId, phase, memberId, 'member_stopped'))
    emitRoutePhaseLog(
      ticketId,
      phase,
      'info',
      outcome === 'stopped'
        ? `You stopped ${memberId}. The step goes on without it.`
        : `${memberId} finished before the stop reached it.`,
      { modelId: memberId },
    )
    return c.json({ success: true, phase, memberId, outcome } satisfies CouncilMemberStopResponse)
  } catch (error) {
    return respondWithControlError(c, error)
  }
}

export async function handleRetryCouncilMember(c: Context) {
  const ticketId = getTicketParam(c)
  if (!getTicketContext(ticketId)) return c.json({ error: 'Ticket not found' }, 404)

  const body = await c.req.json().catch(() => ({}))
  const parsed = councilMemberRetrySchema.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'Invalid council member retry payload', details: parsed.error.flatten() }, 400)
  }
  const { phase, memberId } = parsed.data
  const part = phase === 'DRAFTING_PRD' ? parsed.data.part ?? 'prd_draft' : undefined

  try {
    await retryCouncilMember(ticketId, phase, memberId, part, attributeQuestionsTo(ticketId, phase, memberId, 'member_restarted'))
    // Which part restarts is logged by the step itself when the new attempt
    // begins: a PRD restart from Part 2 redoes both parts when Part 1 is unusable.
    emitRoutePhaseLog(ticketId, phase, 'info', `You restarted ${memberId}, with a full new time limit.`, { modelId: memberId })
    return c.json({ success: true, phase, memberId } satisfies CouncilMemberRetryResponse)
  } catch (error) {
    return respondWithControlError(c, error)
  }
}
