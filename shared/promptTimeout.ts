/**
 * Which budget a prompt ran out of.
 *
 * Travels on log entries, so the server writes it and the SPA reads it back.
 * It had four independent declarations — the workflow phase types, the prompt
 * runner, the log types and the SPA's log parsing — and nothing would have
 * failed to compile if one of them had gained a kind the others did not have.
 */
export const PROMPT_TIMEOUT_KINDS = [
  'ai_response',
  'council_response',
  'per_iteration',
  'execution_setup',
  'opencode_prompt',
] as const

export type PromptTimeoutKind = (typeof PROMPT_TIMEOUT_KINDS)[number]

export function isPromptTimeoutKind(value: unknown): value is PromptTimeoutKind {
  return (PROMPT_TIMEOUT_KINDS as readonly unknown[]).includes(value)
}
