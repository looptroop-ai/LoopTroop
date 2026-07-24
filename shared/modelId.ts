/**
 * OpenCode model IDs are catalog IDs in the form provider/model. OpenRouter
 * also documents request-level suffixes such as :floor and :nitro, but those
 * suffixes are not valid OpenCode model IDs and must not be persisted here.
 */
const OPENROUTER_SUFFIX_PATTERN = /:(?:free|thinking|extended|nitro|floor|exacto)$/

export function normalizeModelId(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!trimmed.startsWith('openrouter/')) return trimmed
  return trimmed.replace(OPENROUTER_SUFFIX_PATTERN, '')
}
