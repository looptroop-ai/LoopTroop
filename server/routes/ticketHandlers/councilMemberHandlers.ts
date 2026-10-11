import type { Context } from 'hono'
import type {
  CouncilMemberControlErrorResponse,
  CouncilMemberRetryResponse,
  CouncilMemberStopResponse,
} from '@shared/councilMembers'
import { getErrorMessage } from '@shared/typeGuards'
import {
  checkCouncilMemberControl,
  CouncilMemberControlError,
  retryCouncilMember,
  stopCouncilMember,
} from '../../council/memberControl'
import { listOpenCodeSessionsForTicket } from '../../opencode/sessionManager'
import { getTicketContext } from '../../storage/tickets'
import { clearSessionWindows } from '../../workflow/questionWindows'
import { emitRoutePhaseLog, getTicketParam } from './routeUtils'
import { councilMemberRetrySchema, councilMemberStopSchema } from './schemas'

/**
 * Refuses the member's open AI questions before its session is stopped.
 *
 * Each refusal is filed under the person, with the reason they caused it. Left
 * to the session stop, the same questions would read as `session_lost`.
 */
async function refuseMemberQuestions(
  ticketId: string,
  phase: string,
  memberId: string,
  resolution: 'member_stopped' | 'member_restarted',
): Promise<void> {
  const reason = resolution === 'member_stopped'
    ? 'You stopped this model while its question was open.'
    : 'You restarted this model while its question was open.'
  const sessions = listOpenCodeSessionsForTicket(ticketId, ['active'])
    .filter((session) => session.phase === phase && session.memberId === memberId)
  for (const session of sessions) {
    await clearSessionWindows(ticketId, session.sessionId, resolution, reason)
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
    checkCouncilMemberControl(ticketId, phase, memberId, 'stop')
    await refuseMemberQuestions(ticketId, phase, memberId, 'member_stopped')
    const outcome = await stopCouncilMember(ticketId, phase, memberId)
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
  // Only PRD drafting has parts; everywhere else a retry redoes the whole turn.
  const part = phase === 'DRAFTING_PRD' ? parsed.data.part ?? 'prd_draft' : undefined

  try {
    const { working } = checkCouncilMemberControl(ticketId, phase, memberId, 'retry')
    if (working) await refuseMemberQuestions(ticketId, phase, memberId, 'member_restarted')
    await retryCouncilMember(ticketId, phase, memberId, part)
    emitRoutePhaseLog(
      ticketId,
      phase,
      'info',
      part === 'full_answers'
        ? `You restarted ${memberId} from Full Answers, with a full new time limit.`
        : part === 'prd_draft'
          ? `You restarted ${memberId}'s PRD draft, with a full new time limit.`
          : `You restarted ${memberId}, with a full new time limit.`,
      { modelId: memberId },
    )
    return c.json({ success: true, phase, memberId } satisfies CouncilMemberRetryResponse)
  } catch (error) {
    return respondWithControlError(c, error)
  }
}
