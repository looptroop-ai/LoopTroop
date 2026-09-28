import * as jsYaml from 'js-yaml'
import { MAX_RELEVANT_FILES_CHARS } from '../lib/constants'

export interface RelevantFileEntry {
  path: string
  rationale: string
  relevance: 'high' | 'medium' | 'low'
  likely_action: 'read' | 'modify' | 'create'
  content: string
  content_preview: string
}

export interface RelevantFilesData {
  file_count: number
  files: RelevantFileEntry[]
}

export const MAX_TOTAL_CHARS = MAX_RELEVANT_FILES_CHARS

const RELEVANCE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 }

/**
 * Wrap parsed relevant files data with metadata for artifact storage.
 * Enforces MAX_TOTAL_CHARS by truncating lowest-relevance files.
 */
export function buildRelevantFilesArtifact(ticketId: string, parsed: RelevantFilesData): string {
  const files = [...parsed.files]

  // Truncate if over budget by removing lowest-relevance files
  // Budget is computed from rationale + content_preview (the lightweight fields)
  let totalChars = files.reduce((sum, f) => sum + f.rationale.length + f.content_preview.length, 0)
  if (totalChars > MAX_TOTAL_CHARS) {
    // Sort by relevance (high first) so popping trims the least relevant.
    files.sort((a, b) => (RELEVANCE_ORDER[a.relevance] ?? 2) - (RELEVANCE_ORDER[b.relevance] ?? 2))
    while (totalChars > MAX_TOTAL_CHARS && files.length > 0) {
      const removed = files.pop()!
      totalChars -= removed.rationale.length + removed.content_preview.length
    }
    // Re-sort by relevance (high first) for the final artifact
    files.sort((a, b) => (RELEVANCE_ORDER[a.relevance] ?? 2) - (RELEVANCE_ORDER[b.relevance] ?? 2))
  }

  const artifact = {
    ticket_id: ticketId,
    artifact: 'relevant_files',
    file_count: files.length,
    files: files.map((f) => ({
      path: f.path,
      rationale: f.rationale,
      relevance: f.relevance,
      likely_action: f.likely_action,
      content_preview: f.content_preview,
    })),
  }

  return jsYaml.dump(artifact, { lineWidth: 120, noRefs: true }) as string
}
