export const DEFAULT_GLOBAL_RULES = `
CRITICAL OUTPUT RULE:
Your response must contain ONLY the requested artifact in the exact format specified.
Do not include explanations, commentary, or meta-discussion outside the artifact.
If you need to communicate issues, use structured fields within the artifact format.

CONTEXT REFRESH:
You are operating in a fresh session with no prior conversation history.
All context needed for this task is provided in this prompt.
Do not reference or assume any prior interactions.
`.trim()

export const DEFAULT_SAME_SESSION_RULES = `
CRITICAL OUTPUT RULE:
Your response must contain ONLY the requested artifact in the exact format specified.
Do not include explanations, commentary, or meta-discussion outside the artifact.
If you need to communicate issues, use structured fields within the artifact format.

EXISTING SESSION:
You are continuing in an existing session.
Use the current session history together with the prompt context provided below.
Do not claim or assume that this is a fresh session.
`.trim()

export const DEFAULT_CONVERSATIONAL_RULES = `
MULTI-TURN SESSION:
This is a multi-turn conversational session. You will receive user responses to your questions and should adapt your next output accordingly.

STRUCTURED OUTPUT RULE:
Each response must use the structured tag format specified in the instructions.
You may include brief conversational commentary inside the designated fields, but all questions and progress data must be wrapped in the specified tags.

Do not output raw YAML outside of the designated tags.
`.trim()

export type GlobalRuleId =
  | 'GENERAL_GLOBAL_RULES'
  | 'GENERAL_SAME_SESSION_RULES'
  | 'GENERAL_CONVERSATIONAL_RULES'

export const DEFAULT_GLOBAL_RULE_TEXTS: Record<GlobalRuleId, string> = {
  GENERAL_GLOBAL_RULES: DEFAULT_GLOBAL_RULES,
  GENERAL_SAME_SESSION_RULES: DEFAULT_SAME_SESSION_RULES,
  GENERAL_CONVERSATIONAL_RULES: DEFAULT_CONVERSATIONAL_RULES,
}

export const GLOBAL_RULE_DESCRIPTIONS: Record<GlobalRuleId, string> = {
  GENERAL_GLOBAL_RULES: 'Global rules (fresh session)',
  GENERAL_SAME_SESSION_RULES: 'Global rules (continued session)',
  GENERAL_CONVERSATIONAL_RULES: 'Global rules (multi-turn conversation)',
}

const globalRuleOverrides = new Map<GlobalRuleId, string>()

/**
 * Applied by the prompt template store when a user has customized a rule block.
 * Passing `null` clears the override and restores the built-in default.
 */
export function setGlobalRuleOverride(id: GlobalRuleId, text: string | null): void {
  if (text === null) {
    globalRuleOverrides.delete(id)
    return
  }
  globalRuleOverrides.set(id, text)
}

export function clearGlobalRuleOverrides(): void {
  globalRuleOverrides.clear()
}

export function getGlobalRuleText(id: GlobalRuleId): string {
  return globalRuleOverrides.get(id) ?? DEFAULT_GLOBAL_RULE_TEXTS[id]
}
