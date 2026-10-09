import type { TriStateOption } from './TriStateSetting'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS } from '@shared/aiQuestions'

const ON: TriStateOption = {
  value: true,
  label: 'On',
  tooltip: 'A model can pause a step and ask you a question. The run waits for your answer, and carries on without one when the wait runs out. The interview never uses this; it asks its own questions.',
}

const OFF: TriStateOption = {
  value: false,
  label: 'Off',
  tooltip: 'Models never ask. A step that would have asked keeps going and decides on its own. The wait controls are disabled, and your chosen duration is kept for when questions are enabled again.',
}

const INHERIT: TriStateOption = {
  value: null,
  label: 'Inherit',
  tooltip: 'Follow the level above: the project for a ticket, the configuration for a project. Change it there and this follows.',
}

/** For the configuration screen, which is the top of the cascade. */
export const AI_QUESTIONS_OPTIONS: readonly TriStateOption[] = [ON, OFF]

/** For a project or a ticket, either of which can hand the choice upward. */
export const AI_QUESTIONS_INHERITABLE_OPTIONS: readonly TriStateOption[] = [INHERIT, ON, OFF]

export const AI_QUESTION_WAIT_HINT = 'How long a question waits before the run carries on.'
export const AI_QUESTION_WAIT_DISABLED_HINT = 'AI questions are Off. Your selected wait is kept.'
export const AI_QUESTION_WAIT_HELP = `Applies when AI questions are On. Choose a wait of ${AI_QUESTION_WINDOW_MIN_MS / 60_000}–${AI_QUESTION_WINDOW_MAX_MS / 60_000} whole minutes. Custom rounds an inherited wait to the nearest whole minute. Waiting does not use up the step's working time. A step can take its full timeout plus the time it spent waiting on you.`
