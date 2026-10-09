import type { TriStateOption } from './TriStateSetting'

const ON: TriStateOption = {
  value: true,
  label: 'On',
  tooltip: 'A model can stop a step and ask you a question. The run waits for your answer, and carries on without one when the wait runs out. The interview never uses this; it asks its own questions.',
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
export const AI_QUESTION_WAIT_HELP = "Applies when AI questions is On. Choose a wait of 1–60 whole minutes. Waiting does not use up the step's working time. A step can take its full timeout plus the time it spent waiting on you."
