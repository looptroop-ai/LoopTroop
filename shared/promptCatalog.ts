import { WORKFLOW_GROUPS, WORKFLOW_PHASES, type WorkflowGroupId } from './workflowMeta'

/** Pseudo-prompt IDs for the cross-cutting rule blocks prepended to every prompt. */
export const GLOBAL_RULE_PROMPT_IDS = [
  'GENERAL_GLOBAL_RULES',
  'GENERAL_SAME_SESSION_RULES',
  'GENERAL_CONVERSATIONAL_RULES',
] as const

export type GlobalRulePromptId = (typeof GLOBAL_RULE_PROMPT_IDS)[number]

export interface PromptCatalogEntry {
  /** Prompt template id, matching a key of `ALL_PROMPTS` on the server. */
  id: string
  /** Workflow status (a `WORKFLOW_PHASES[].id`) during which this prompt is sent. */
  status: string
  /** Optional qualifier when several prompts run inside the same status. */
  step?: string
  /** Sort order within the status. */
  order: number
}

/**
 * Maps every prompt template to the workflow status that sends it.
 *
 * Kept as an explicit table rather than derived at runtime so the Prompts UI can
 * group prompts without booting the workflow engine. A unit test asserts this
 * stays in sync with `ALL_PROMPTS`.
 */
export const PROMPT_CATALOG: PromptCatalogEntry[] = [
  { id: 'PROM0', status: 'SCANNING_RELEVANT_FILES', order: 0 },

  { id: 'PROM1', status: 'COUNCIL_DELIBERATING', order: 0 },
  { id: 'PROM2', status: 'COUNCIL_VOTING_INTERVIEW', order: 0 },
  { id: 'PROM3', status: 'COMPILING_INTERVIEW', order: 0 },
  { id: 'PROM4', status: 'WAITING_INTERVIEW_ANSWERS', order: 0 },
  { id: 'PROM5', status: 'VERIFYING_INTERVIEW_COVERAGE', order: 0 },

  { id: 'PROM10a', status: 'DRAFTING_PRD', step: 'Answering skipped questions', order: 0 },
  { id: 'PROM10b', status: 'DRAFTING_PRD', step: 'Generating PRD drafts', order: 1 },
  { id: 'PROM11', status: 'COUNCIL_VOTING_PRD', order: 0 },
  { id: 'PROM12', status: 'REFINING_PRD', order: 0 },
  { id: 'PROM13', status: 'VERIFYING_PRD_COVERAGE', order: 0 },
  { id: 'PROM13b', status: 'VERIFYING_PRD_COVERAGE', step: 'Applying coverage fixes', order: 1 },

  { id: 'PROM20', status: 'DRAFTING_BEADS', order: 0 },
  { id: 'PROM21', status: 'COUNCIL_VOTING_BEADS', order: 0 },
  { id: 'PROM22', status: 'REFINING_BEADS', order: 0 },
  { id: 'PROM23', status: 'VERIFYING_BEADS_COVERAGE', order: 0 },
  { id: 'PROM24', status: 'VERIFYING_BEADS_COVERAGE', step: 'Applying coverage fixes', order: 1 },
  { id: 'PROM25', status: 'EXPANDING_BEADS', order: 0 },

  { id: 'PROM_EXECUTION_CAPABILITY_PROBE', status: 'PRE_FLIGHT_CHECK', order: 0 },
  { id: 'PROM_EXECUTION_SETUP_PLAN', status: 'GENERATING_EXECUTION_SETUP_PLAN', order: 0 },
  {
    id: 'PROM_EXECUTION_SETUP_PLAN_REGENERATE',
    status: 'GENERATING_EXECUTION_SETUP_PLAN',
    step: 'Regenerating after feedback',
    order: 1,
  },
  { id: 'PROM_EXECUTION_SETUP', status: 'PREPARING_EXECUTION_ENV', order: 0 },
  {
    id: 'PROM_EXECUTION_SETUP_NOTE',
    status: 'PREPARING_EXECUTION_ENV',
    step: 'Retry note',
    order: 1,
  },

  { id: 'PROM_CODING', status: 'CODING', order: 0 },
  { id: 'PROM51', status: 'CODING', step: 'Context wipe / failure note', order: 1 },

  { id: 'PROM52', status: 'RUNNING_FINAL_TEST', order: 0 },
  { id: 'PROM53', status: 'RUNNING_FINAL_TEST', step: 'Retry note', order: 1 },

  { id: 'PROM_MANUAL_QA_FIX_BEADS', status: 'WAITING_MANUAL_QA', order: 0 },

  { id: 'PROM54', status: 'BLOCKED_ERROR', step: 'Session continuation', order: 0 },
]

/**
 * A prompt template that could not be loaded, and why.
 *
 * The server's template store produces these and the SPA's prompts screen
 * renders them, so both used to declare the same record independently.
 */
export interface PromptLoadWarning {
  id: string
  message: string
}

export interface PromptGroupStatus {
  status: string
  label: string
  promptIds: string[]
}

export interface PromptGroup {
  id: WorkflowGroupId | 'general'
  label: string
  statuses: PromptGroupStatus[]
}

const statusMeta = new Map(WORKFLOW_PHASES.map((phase) => [phase.id, phase]))

/**
 * Some workflow labels embed runtime placeholders (e.g. "Implementing (Bead ?/?)").
 * The Prompts screen is static, so strip them for a clean heading.
 */
function stripRuntimePlaceholders(label: string): string {
  return label.replace(/\s*\((?:[^()]*\?[^()]*|reason)\)/gi, '').trim()
}

export function promptStatusLabel(status: string): string {
  const label = statusMeta.get(status)?.label
  return label ? stripRuntimePlaceholders(label) : status
}

export function promptGroupIdForStatus(status: string): WorkflowGroupId | 'general' {
  return statusMeta.get(status)?.groupId ?? 'general'
}

export function catalogEntry(promptId: string): PromptCatalogEntry | undefined {
  return PROMPT_CATALOG.find((entry) => entry.id === promptId)
}

/**
 * Build the sidebar/main-area structure for the Prompts screen: workflow groups
 * in workflow order, each containing its statuses and the prompts they send,
 * followed by a trailing "General" group for the shared rule blocks.
 */
export function buildPromptGroups(): PromptGroup[] {
  const groups: PromptGroup[] = []

  for (const group of WORKFLOW_GROUPS) {
    const statuses: PromptGroupStatus[] = []
    for (const phase of WORKFLOW_PHASES) {
      if (phase.groupId !== group.id) continue
      const promptIds = PROMPT_CATALOG
        .filter((entry) => entry.status === phase.id)
        .sort((a, b) => a.order - b.order)
        .map((entry) => entry.id)
      if (promptIds.length === 0) continue
      statuses.push({ status: phase.id, label: promptStatusLabel(phase.id), promptIds })
    }
    if (statuses.length === 0) continue
    groups.push({ id: group.id, label: group.label, statuses })
  }

  groups.push({
    id: 'general',
    label: 'General',
    statuses: [
      {
        status: 'GENERAL',
        label: 'Applied to every prompt',
        promptIds: [...GLOBAL_RULE_PROMPT_IDS],
      },
    ],
  })

  return groups
}
