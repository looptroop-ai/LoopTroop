/**
 * Which board column a ticket belongs in.
 *
 * Shared rather than living in `src/lib/` because the server derives it too, for
 * the ticket list and the acknowledgement signature. Two copies of this rule
 * would drift the first time one of them learned about a new kind of blocker,
 * and the symptom would be a card sitting in the wrong column with nothing to
 * explain it.
 */

import { getWorkflowPhaseMeta, type KanbanPhase } from './workflowMeta'

export interface KanbanPhaseInput {
  /** True while a model is waiting on an answer to an AI question. */
  hasPendingQuestion?: boolean
}

/**
 * A pending AI question moves a working ticket into Needs Input.
 *
 * The workflow status does not change — the model is still mid-step, and moving
 * the state machine for something a person might answer in ten seconds would be
 * a lie about where the run is. The board is a view, so this is the right layer
 * for it: the ticket is genuinely waiting on you, and that is what the column
 * means.
 *
 * Only `in_progress` is redirected. A ticket already in Needs Input for an
 * approval stays there, and a done or todo ticket has no live model to ask.
 */
export function resolveKanbanPhase(status: string, input: KanbanPhaseInput = {}): KanbanPhase {
  const base = getWorkflowPhaseMeta(status)?.kanbanPhase ?? 'todo'
  if (input.hasPendingQuestion && base === 'in_progress') return 'needs_input'
  return base
}
