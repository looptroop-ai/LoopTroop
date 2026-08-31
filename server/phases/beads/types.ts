import type { CommandSpec } from '@shared/commandSpec'

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
  status: 'pending' | 'in_progress' | 'done' | 'error'  // Field 4
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
