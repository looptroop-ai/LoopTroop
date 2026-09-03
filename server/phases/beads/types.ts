import type { CommandSpec } from '@shared/commandSpec'

/** Field 4. The scheduler only runs `pending` and only finishes on `done`. */
export const BEAD_STATUSES = ['pending', 'in_progress', 'done', 'error'] as const

export type BeadStatus = (typeof BEAD_STATUSES)[number]

export function isBeadStatus(value: unknown): value is BeadStatus {
  return typeof value === 'string' && (BEAD_STATUSES as readonly string[]).includes(value)
}

/** Status spellings earlier releases and some models still emit. */
export const BEAD_STATUS_LEGACY_ALIASES: Readonly<Record<string, BeadStatus>> = Object.freeze({
  completed: 'done',
  failed: 'error',
  skipped: 'done',
})

/**
 * The canonical status a legacy spelling means, or `undefined`.
 *
 * Indexing the map directly reads through the prototype, so a bead whose status
 * was the string `constructor` resolved to a function rather than to nothing.
 * Case is folded because models write `Completed` and `DONE`, and a status whose
 * only fault is its capitalisation is a formatting problem, not a wrong answer.
 */
export function resolveBeadStatusAlias(value: string): BeadStatus | undefined {
  const folded = value.trim().toLowerCase()
  return Object.hasOwn(BEAD_STATUS_LEGACY_ALIASES, folded)
    ? BEAD_STATUS_LEGACY_ALIASES[folded]
    : undefined
}

export interface BeadDependencies {
  blocked_by: string[]
  blocks: string[]
}

export interface BeadContextGuidance {
  patterns: string[]
  anti_patterns: string[]
}

export interface QaOriginEvidenceRef {
  id: string
  originalName: string
  mediaType: string
  size: number
  sha256: string
  relativePath: string
}

export interface QaOriginSourceItem {
  itemId: string
  lineageId: string
  behavior: string
  observation: string
  expectedResult: string
  evidence: QaOriginEvidenceRef[]
  links: Array<{ id: string; url: string; label?: string }>
}

export interface QaOrigin {
  schemaVersion: 1
  actionId: string
  sourceTicketId: string
  sourceTicketExternalId: string
  version: number
  modelId: string | null
  modelSupportsImages: boolean | null
  createdFromManualQaAt: string
  sourceItems: QaOriginSourceItem[]
  imageDelivery?: 'attached' | 'references_only'
}

import type { BeadNoteEntry } from '@shared/beadNotes'
export type { BeadNoteEntry }

export interface Bead {
  // Subset fields (draft phase — PROM20)
  id: string                              // Field 1 (draft uses simple kebab-case; PROM25 assigns hierarchical ID)
  title: string                           // Field 2
  prdRefs: string[]                       // Field 7 — PRD epic/story references
  description: string                     // Field 9
  contextGuidance: BeadContextGuidance    // Field 10 — patterns and anti-patterns
  acceptanceCriteria: string[]            // Field 11
  tests: string[]                         // Field 14
  testCommands: CommandSpec[]             // Field 15
  testCommandReason?: string              // Required only when testCommands is empty

  // Expanded fields (terminal expansion phase — PROM25)
  priority: number                        // Field 3 — sequential execution order
  status: BeadStatus                      // Field 4
  issueType: string                       // Field 5 — "task", "bug", "chore", etc.
  externalRef: string                     // Field 6 — parent ticket ID
  labels: string[]                        // Field 8 — must map to at least one epic and story
  dependencies: BeadDependencies          // Field 12 — blocked_by + blocks
  targetFiles: string[]                   // Field 13
  failedIterationNotes: BeadNoteEntry[]   // Field 16 — machine-generated Ralph-loop history
  userRetryNotes: BeadNoteEntry[]         // Field 17 — user-authored retry guidance
  finalizationFailureNotes: BeadNoteEntry[] // Field 18 — machine-generated finalization diagnostics
  iteration: number                       // Field 19 — starts at 1 for the first execution attempt
  createdAt: string                       // Field 20 — set when beads are approved
  updatedAt: string                       // Field 21
  completedAt: string                     // Field 22 — filled when status=done
  startedAt: string                       // Field 23 — set on first iteration, preserved across retries
  beadStartCommit: string | null          // Field 24 — git SHA for worktree reset
  qaOrigin?: QaOrigin                     // Typed Manual QA provenance.
}

export type BeadSubset = Pick<Bead, 'id' | 'title' | 'prdRefs' | 'description' | 'contextGuidance' | 'acceptanceCriteria' | 'tests' | 'testCommands' | 'testCommandReason'>
