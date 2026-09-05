import { closeTag, openTag, PROTOCOL_TAGS } from '../../structuredOutput/protocolTags'

export interface BeadChecks {
  tests: string
  lint: string
  typecheck: string
  qualitative: string
}

export interface BeadCompletionMarker {
  bead_id: string
  status: 'done' | 'error'
  checks: BeadChecks
  reason?: string
}

export const BEAD_STATUS_MARKER = openTag(PROTOCOL_TAGS.BEAD_STATUS)
export const BEAD_STATUS_END = closeTag(PROTOCOL_TAGS.BEAD_STATUS)
export const REQUIRED_GATES: (keyof BeadChecks)[] = ['tests', 'lint', 'typecheck', 'qualitative']

export function buildCompletionInstructions() {
  return [
    'When you finish a bead, end your response with exactly one JSON marker in these tags and nothing else after it:',
    `${BEAD_STATUS_MARKER}{"bead_id":"<bead-id>","status":"done","checks":{"tests":"pass","lint":"pass","typecheck":"pass","qualitative":"pass"}}${BEAD_STATUS_END}`,
    'If you cannot complete the bead, use the same JSON shape with `"status":"error"` and include a short `"reason"` field.',
    'Inside the marker, return only the machine-readable object. Do not add markdown fences, commentary, or wrapper keys.',
    'Self-check before sending: exactly one marker, valid bead_id, valid status, and all four required checks present.',
    'Do not use plain-text COMPLETE/FAILED markers.',
  ].join('\n')
}
