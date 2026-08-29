import { clampAiQuestionWindowMs, type SettingSource } from '@shared/aiQuestions'

export type AiQuestionsOverride = boolean | null
export type AiQuestionWindowOverride = number | null

export function resolveAiQuestionsSettingLabel(
  override: AiQuestionsOverride | undefined,
  projectOverride: AiQuestionsOverride | undefined,
  globalEnabled: boolean,
): { enabled: boolean; source: SettingSource } {
  if (override !== null && override !== undefined) return { enabled: override, source: 'ticket' }
  if (projectOverride !== null && projectOverride !== undefined) return { enabled: projectOverride, source: 'project' }
  return { enabled: globalEnabled, source: 'profile' }
}

export function resolveAiQuestionWindowLabel(
  override: AiQuestionWindowOverride | undefined,
  projectOverride: AiQuestionWindowOverride | undefined,
  globalWindowMs: number,
): { windowMs: number; source: SettingSource } {
  // Clamped on the way out: a value written before the range changed, or edited
  // outside the app, still has to render as something the field can offer.
  if (override !== null && override !== undefined) return { windowMs: clampAiQuestionWindowMs(override), source: 'ticket' }
  if (projectOverride !== null && projectOverride !== undefined) return { windowMs: clampAiQuestionWindowMs(projectOverride), source: 'project' }
  return { windowMs: clampAiQuestionWindowMs(globalWindowMs), source: 'profile' }
}

/** The screen a resolved setting came from, named as the interface names it. */
export function describeSettingSource(source: SettingSource): string {
  if (source === 'ticket') return 'Ticket'
  if (source === 'project') return 'Project'
  return 'Configuration'
}
