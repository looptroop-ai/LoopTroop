import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  CouncilMemberControlPhase,
  CouncilMemberRetryPart,
  CouncilMemberRetryRequest,
  CouncilMemberRetryResponse,
  CouncilMemberStopResponse,
} from '@shared/councilMembers'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { getTicketSkipsQueryKey } from './useTicketSkips'

export type CouncilMemberControlAction = 'stop' | 'retry'

export interface CouncilMemberControlVariables {
  ticketId: string
  action: CouncilMemberControlAction
  phase: CouncilMemberControlPhase
  memberId: string
  /** Only a retry in `DRAFTING_PRD` sends it. */
  part?: CouncilMemberRetryPart
}

export async function controlCouncilMember({
  ticketId,
  action,
  phase,
  memberId,
  part,
}: CouncilMemberControlVariables): Promise<CouncilMemberStopResponse | CouncilMemberRetryResponse> {
  const body: CouncilMemberRetryRequest = action === 'retry' && part ? { phase, memberId, part } : { phase, memberId }
  const res = await fetch(apiTicketPath(ticketId, 'council', 'members', action), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  await throwIfNotOk(res, action === 'stop' ? 'Could not stop the model' : 'Could not restart the model')
  return res.json()
}

/** Stops or restarts one council model while its step keeps running. */
export function useCouncilMemberControl() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: controlCouncilMember,
    // On a refusal too: "the step is no longer running" or "that model already
    // finished" means this screen is behind the server, and the fresh artifacts
    // are what take the stale buttons away. Returned, so the request reads as
    // done only once the chips show its result.
    // The ticket too: stopping the last working model ends the step and moves the ticket on.
    // And the skip trail: the model's open AI questions close with it.
    onSettled: (_result, _error, variables) => Promise.all([
      queryClient.invalidateQueries({ queryKey: ['ticket-artifacts', variables.ticketId] }),
      queryClient.invalidateQueries({ queryKey: ['ticket', variables.ticketId] }),
      queryClient.invalidateQueries({ queryKey: getTicketSkipsQueryKey(variables.ticketId) }),
    ]),
  })
}
