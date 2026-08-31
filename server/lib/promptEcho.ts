import { stripTranscriptPrefixes } from '@shared/transcriptPrefix'


const COMMON_PROMPT_ECHO_MARKERS = [
  'CRITICAL OUTPUT RULE:',
  'CONTEXT REFRESH:',
  '## System Role',
  '## Task',
  '## Instructions',
  '## Expected Output Format',
  '## Context',
]

const HARD_PROMPT_ECHO_MARKERS = [
  'CRITICAL OUTPUT RULE:',
  'CONTEXT REFRESH:',
]

const STRUCTURED_PROMPT_SCHEMA_MARKERS = [
  '## Expected Output Format',
  '## Context',
  '### ticket_details',
  '# Ticket:',
]

/** The shared strip, plus the trim the echo markers below are matched against. */
export function stripPromptEchoTranscriptPrefixes(content: string): string {
  return stripTranscriptPrefixes(content).trim()
}

export function looksLikePromptEcho(content: string, extraMarkers: string[] = []): boolean {
  const normalized = stripPromptEchoTranscriptPrefixes(content)
  if (!normalized) return false

  const allMarkers = [...COMMON_PROMPT_ECHO_MARKERS, ...extraMarkers]
  let totalHits = 0
  let hardHits = 0

  for (const marker of allMarkers) {
    if (!normalized.includes(marker)) continue
    totalHits += 1
    if (HARD_PROMPT_ECHO_MARKERS.includes(marker)) {
      hardHits += 1
    }
  }

  return hardHits >= 1 && totalHits >= 2
}

export function looksLikeStructuredPromptSchemaEcho(
  content: string,
  options?: {
    rootKeys?: string[]
  },
): boolean {
  const normalized = stripPromptEchoTranscriptPrefixes(content)
  if (!normalized) return false
  if (looksLikePromptEcho(normalized)) return true

  const trimmed = normalized.trimStart().toLowerCase()
  const rootKeys = options?.rootKeys ?? []
  const startsWithStructuredArtifact = rootKeys.length === 0
    ? /^[a-z_][\w-]*\s*:/i.test(trimmed)
    : rootKeys.some((key) => trimmed.startsWith(`${key.toLowerCase()}:`))

  if (!startsWithStructuredArtifact) return false

  return normalized.split('\n').some((line) => (
    STRUCTURED_PROMPT_SCHEMA_MARKERS.some((marker) => line.startsWith(marker))
  ))
}
