import type { CommandSpec } from './commandSpec'

/**
 * The PRD artifact's shape, written once.
 *
 * The server declared this inline in `structuredOutput/types.ts` and the client
 * declared a structurally identical copy in `src/lib/prdDocument.ts`, with the
 * epics and stories spelled out inline on one side and named on the other. Two
 * declarations meant display, approval and the phase writer could drift about
 * what a valid PRD is; the type now lives here and both sides re-export it.
 */

export interface PrdUserStory {
  id: string
  title: string
  acceptance_criteria: string[]
  implementation_steps: string[]
  verification: {
    required_commands: CommandSpec[]
  }
}

export interface PrdEpic {
  id: string
  title: string
  objective: string
  implementation_steps: string[]
  user_stories: PrdUserStory[]
}

export interface PrdDocument {
  schema_version: number
  ticket_id: string
  artifact: 'prd'
  status: 'draft' | 'approved'
  source_interview: {
    content_sha256: string
  }
  product: {
    problem_statement: string
    target_users: string[]
  }
  scope: {
    in_scope: string[]
    out_of_scope: string[]
  }
  technical_requirements: {
    architecture_constraints: string[]
    data_model: string[]
    api_contracts: string[]
    security_constraints: string[]
    performance_constraints: string[]
    reliability_constraints: string[]
    error_handling_rules: string[]
    tooling_assumptions: string[]
  }
  epics: PrdEpic[]
  risks: string[]
  approval: {
    approved_by: string
    approved_at: string
  }
}

export type PrdTechnicalRequirementKey = keyof PrdDocument['technical_requirements']
