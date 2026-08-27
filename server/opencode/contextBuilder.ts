import type { PromptPart } from './types'
import { encode } from 'gpt-tokenizer'
import { DEFAULT_OPENCODE_TOKEN_BUDGET } from '../lib/constants'
import { logIfVerbose, warnIfVerbose } from '../runtime'
import { stripSkipReasonsFromInterviewYaml } from '../structuredOutput/interviewDocument'

// Phase allowlists — only specified sources are included
// Phase allowlists derived from cl-prompt.md PROM context_input specs
const PHASE_ALLOWLISTS: Record<string, string[]> = {
  // PROM1: "Relevant files + ticket details"
  interview_draft: ['relevant_files', 'ticket_details'],
  // PROM2: "Relevant files + ticket details + all interview drafts"
  interview_vote: ['relevant_files', 'ticket_details', 'drafts'],
  // PROM3: "Relevant files + ticket details + all interview drafts"
  interview_refine: ['relevant_files', 'ticket_details', 'drafts'],
  // PROM4: ticket details only; compiled questions and resume state are appended explicitly.
  interview_qa: ['ticket_details'],
  // PROM5: "Ticket description + collected answers + current Interview Results"
  interview_coverage: ['ticket_details', 'user_answers', 'interview'],
  // PROM10a + PROM10b: "Relevant files + ticket details + final Interview Results / Full Answers"
  prd_draft: ['relevant_files', 'ticket_details', 'interview', 'full_answers'],
  // PROM11: "Relevant files + ticket details + final Interview Results + all PRD drafts"
  prd_vote: ['relevant_files', 'ticket_details', 'interview', 'drafts'],
  // PROM12: "Relevant files + ticket details + all Full Answers artifacts + all PRD drafts"
  prd_refine: ['relevant_files', 'ticket_details', 'full_answers', 'drafts'],
  // PROM13: winner Full Answers artifact + final PRD
  prd_coverage: ['full_answers', 'prd'],
  // PROM20: "Relevant files + ticket details + final PRD"
  beads_draft: ['relevant_files', 'ticket_details', 'prd'],
  // PROM21: "Relevant files + ticket details + final PRD + all bead drafts"
  beads_vote: ['relevant_files', 'ticket_details', 'prd', 'drafts'],
  // PROM22: "Relevant files + ticket details + final PRD + all bead drafts"
  beads_refine: ['relevant_files', 'ticket_details', 'prd', 'drafts'],
  // PROM25: "Relevant files + ticket details + final PRD + refined beads draft"
  beads_expand: ['relevant_files', 'ticket_details', 'prd', 'beads_draft'],
  // PROM23: "Final PRD + semantic Beads blueprint"
  beads_coverage: ['prd', 'beads'],
  // Execution setup-plan review: approved planning context + any prior reusable setup profile + prior regenerate notes
  execution_setup_plan: ['ticket_details', 'relevant_files', 'prd', 'beads', 'execution_setup_profile', 'execution_setup_plan_notes'],
  // Execution setup-plan regenerate: same as above plus current draft plan
  execution_setup_plan_regenerate: ['ticket_details', 'relevant_files', 'prd', 'beads', 'execution_setup_profile', 'execution_setup_plan', 'execution_setup_plan_notes'],
  // Execution setup: approved setup plan + focused ticket/bead context + prior setup retry notes
  execution_setup: ['ticket_details', 'beads', 'execution_setup_plan', 'execution_setup_notes'],
  // Execution: bead data + notes from previous iterations
  coding: ['bead_data', 'bead_notes'],
  // PROM51: "Current bead data + error context from failed iteration"
  context_wipe: ['bead_data', 'error_context'],
  // PROM52: "Ticket details + PRD + Beads list + prior final-test retry notes"
  final_test: ['ticket_details', 'prd', 'beads', 'final_test_notes'],
  // Draft pull request context: concise source of why, with reports/diff appended by the PR phase.
  pull_request: ['ticket_details', 'prd'],
  // Pre-flight check (used by SCANNING_RELEVANT_FILES which generates relevant_files)
  preflight: ['ticket_details'],
}

// Token budget per call (approximate)
const DEFAULT_CONTEXT_TOKEN_BUDGET = DEFAULT_OPENCODE_TOKEN_BUDGET
// Trim order: lowest priority sources removed first
// Maps trim key to the source names used in parts[]
const TRIM_PRIORITY: { key: string; sources: string[] }[] = [
  { key: 'error_context', sources: ['error_context'] },
  { key: 'bead_notes', sources: ['bead_note'] },
  { key: 'execution_setup_plan_notes', sources: ['execution_setup_plan_note'] },
  { key: 'execution_setup_notes', sources: ['execution_setup_note'] },
  { key: 'final_test_notes', sources: ['final_test_note'] },
  { key: 'user_answers', sources: ['user_answers'] },
  { key: 'tests', sources: ['tests'] },
  { key: 'votes', sources: ['vote'] },
  { key: 'drafts', sources: ['draft'] },
  { key: 'full_answers', sources: ['full_answers'] },
  { key: 'beads_draft', sources: ['beads_draft'] },
  { key: 'beads', sources: ['beads'] },
  { key: 'interview', sources: ['interview'] },
  { key: 'prd', sources: ['prd'] },
  { key: 'relevant_files', sources: ['relevant_files'] },
  { key: 'execution_setup_plan', sources: ['execution_setup_plan'] },
  { key: 'execution_setup_profile', sources: ['execution_setup_profile'] },
  { key: 'ticket_details', sources: ['ticket_details'] },
]

function estimateTokens(text: string): number {
  return encode(text).length
}

// Context slice cache per ticket — avoids redundant file-tree reads within
// a 5-minute window for the same ticket and context slice.
const contextCache = new Map<string, { content: string; timestamp: number }>()
const CONTEXT_CACHE_TTL_MS = 300_000 // 5 minutes

const MAX_CONTEXT_CACHE_ENTRIES = 200

function getCachedContext(key: string): string | null {
  const cached = contextCache.get(key)
  if (cached && Date.now() - cached.timestamp < CONTEXT_CACHE_TTL_MS) {
    return cached.content
  }
  contextCache.delete(key)
  return null
}

function setCachedContext(key: string, content: string) {
  // Evict oldest entries if cache exceeds max size
  if (contextCache.size >= MAX_CONTEXT_CACHE_ENTRIES) {
    const oldestKey = contextCache.keys().next().value
    if (oldestKey !== undefined) contextCache.delete(oldestKey)
  }
  contextCache.set(key, { content, timestamp: Date.now() })
}

function formatTicketDetails(title: string, description: string): string {
  const detail = description.trim() || 'No description provided.'
  return [
    '## Primary User Requirement For This Ticket',
    'This is the exact requirement provided by the user for this ticket. Treat it as the primary source of truth for scope and intent.',
    '',
    `# Ticket: ${title}`,
    detail,
  ].join('\n')
}

interface ContextSourcePart {
  source: string
  content: string
  order: number
}

function sortContextParts(parts: ContextSourcePart[]): ContextSourcePart[] {
  const priority = (source: string): number => {
    if (source === 'ticket_details') return 0
    return 1
  }

  return [...parts].sort((a, b) => {
    const priorityDiff = priority(a.source) - priority(b.source)
    if (priorityDiff !== 0) return priorityDiff
    return a.order - b.order
  })
}

export interface TicketState {
  ticketId: string
  title?: string
  description?: string
  relevantFiles?: string
  interview?: string
  fullAnswers?: string[]
  prd?: string
  beads?: string
  beadsDraft?: string
  drafts?: string[]
  votes?: string[]
  beadData?: string
  beadNotes?: string[]
  executionSetupProfile?: string
  executionSetupPlan?: string
  executionSetupPlanNotes?: string[]
  executionSetupNotes?: string[]
  finalTestNotes?: string[]
  userAnswers?: string
  tests?: string
  errorContext?: string
}

export function buildMinimalContext(
  phase: string,
  ticketState: TicketState,
): PromptPart[] {
  const allowlist = PHASE_ALLOWLISTS[phase]
  if (!allowlist) {
    throw new Error(
      `Unknown phase: ${phase}. Valid phases: ${Object.keys(PHASE_ALLOWLISTS).join(', ')}`,
    )
  }

  logIfVerbose(`[contextBuilder] buildMinimalContext phase=${phase} ticket=${ticketState.ticketId} allowlist=[${allowlist.join(',')}]`)

  const parts: ContextSourcePart[] = []
  let order = 0

  // Assemble allowed context sources
  for (const source of allowlist) {
    const cacheKey = `${ticketState.ticketId}:${source}`

    switch (source) {
      case 'ticket_details': {
        const title = ticketState.title ?? 'Untitled'
        const desc = ticketState.description ?? ''
        const content = formatTicketDetails(title, desc)
        if (!desc) {
          warnIfVerbose(`[contextBuilder] ticket_details: description is empty for ticket=${ticketState.ticketId}`)
        }
        logIfVerbose(`[contextBuilder] ticket_details: title="${title}" descLength=${desc.length}`)
        parts.push({ source, content, order: order++ })
        break
      }
      case 'relevant_files': {
        const cached = getCachedContext(cacheKey)
        const content = cached ?? ticketState.relevantFiles ?? ''
        if (!cached && ticketState.relevantFiles) setCachedContext(cacheKey, content)
        if (content) {
          logIfVerbose(`[contextBuilder] relevant_files: loaded (${content.length} chars, cached=${!!cached})`)
          parts.push({ source, content, order: order++ })
        }
        break
      }
      case 'interview': {
        const cached = getCachedContext(cacheKey)
        // Every prompt that reads the interview artifact reads it through here,
        // which makes this the one place a skip reason can be kept out of a
        // model's context. PROM10a gets the reasons back deliberately, as a
        // separate fenced part it can read but has no field to write.
        const content = cached ?? (ticketState.interview ? stripSkipReasonsFromInterviewYaml(ticketState.interview) : '')
        if (!cached && content) setCachedContext(cacheKey, content)
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'full_answers': {
        if (ticketState.fullAnswers) {
          for (const fullAnswer of ticketState.fullAnswers) {
            if (fullAnswer) parts.push({ source: 'full_answers', content: fullAnswer, order: order++ })
          }
        }
        break
      }
      case 'prd': {
        const cached = getCachedContext(cacheKey)
        const content = cached ?? ticketState.prd ?? ''
        if (!cached && ticketState.prd) setCachedContext(cacheKey, content)
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'beads': {
        const content = ticketState.beads ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'drafts': {
        if (ticketState.drafts) {
          for (const draft of ticketState.drafts) {
            parts.push({ source: 'draft', content: draft, order: order++ })
          }
        }
        break
      }
      case 'votes': {
        if (ticketState.votes) {
          for (const vote of ticketState.votes) {
            parts.push({ source: 'vote', content: vote, order: order++ })
          }
        }
        break
      }
      case 'bead_data': {
        const content = ticketState.beadData ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'bead_notes': {
        if (ticketState.beadNotes) {
          for (const note of ticketState.beadNotes) {
            parts.push({ source: 'bead_note', content: note, order: order++ })
          }
        }
        break
      }
      case 'execution_setup_profile': {
        const content = ticketState.executionSetupProfile ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'execution_setup_plan': {
        const content = ticketState.executionSetupPlan ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'execution_setup_plan_notes': {
        if (ticketState.executionSetupPlanNotes) {
          for (const note of ticketState.executionSetupPlanNotes) {
            parts.push({ source: 'execution_setup_plan_note', content: note, order: order++ })
          }
        }
        break
      }
      case 'execution_setup_notes': {
        if (ticketState.executionSetupNotes) {
          for (const note of ticketState.executionSetupNotes) {
            parts.push({ source: 'execution_setup_note', content: note, order: order++ })
          }
        }
        break
      }
      case 'final_test_notes': {
        if (ticketState.finalTestNotes) {
          for (const note of ticketState.finalTestNotes) {
            parts.push({ source: 'final_test_note', content: note, order: order++ })
          }
        }
        break
      }
      case 'user_answers': {
        const content = ticketState.userAnswers ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'tests': {
        const content = ticketState.tests ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'error_context': {
        const content = ticketState.errorContext ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
      case 'beads_draft': {
        const content = ticketState.beadsDraft ?? ''
        if (content) parts.push({ source, content, order: order++ })
        break
      }
    }
  }

  const orderedParts = sortContextParts(parts)

  // Apply token budget and trimming
  let totalTokens = orderedParts.reduce((sum, p) => sum + estimateTokens(p.content), 0)

  if (totalTokens > DEFAULT_CONTEXT_TOKEN_BUDGET) {
    // Trim in priority order (lowest priority trimmed first)
    for (const { key, sources } of TRIM_PRIORITY) {
      if (totalTokens <= DEFAULT_CONTEXT_TOKEN_BUDGET) break
      const matchSources = [key, ...sources]
      const idx = orderedParts.findIndex((p) => matchSources.includes(p.source))
      if (idx !== -1) {
        const part = orderedParts[idx]!
        totalTokens -= estimateTokens(part.content)
        orderedParts.splice(idx, 1)
      }
    }
  }

  logIfVerbose(`[contextBuilder] phase=${phase} assembled ${orderedParts.length} parts, totalTokens=${orderedParts.reduce((s, p) => s + estimateTokens(p.content), 0)}`)
  if (orderedParts.length === 0) {
    warnIfVerbose(`[contextBuilder] WARNING: context is empty for phase=${phase} ticket=${ticketState.ticketId}`)
  }

  // Convert to PromptParts
  return orderedParts.map((p) => ({
    type: 'text' as const,
    content: p.content,
    source: p.source,
  }))
}

// Clear cache for a specific ticket
export function clearContextCache(ticketId: string) {
  for (const key of contextCache.keys()) {
    if (key.startsWith(`${ticketId}:`)) {
      contextCache.delete(key)
    }
  }
}

// Export for testing
export { contextCache, PHASE_ALLOWLISTS }
