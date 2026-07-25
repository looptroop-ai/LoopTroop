import * as jsYaml from 'js-yaml'
import { isRecord } from '@shared/typeGuards'
import { commandSpecSchema, type CommandSpec } from '@shared/commandSpec'

function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : []
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function normalizeVerification(value: unknown): { required_commands: CommandSpec[] } {
  if (!isRecord(value)) {
    return { required_commands: [] }
  }

  return {
    required_commands: Array.isArray(value.required_commands)
      ? value.required_commands.flatMap((command) => {
          const parsed = commandSpecSchema.safeParse(command)
          return parsed.success ? [parsed.data] : []
        })
      : [],
  }
}

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

export type PrdApprovalDraft = Pick<PrdDocument, 'product' | 'scope' | 'technical_requirements' | 'epics' | 'risks'>

export interface PrdDocumentParseResult {
  document: PrdDocument | null
  error: string | null
}

export type PrdTechnicalRequirementKey = keyof PrdDocument['technical_requirements']

export interface PrdTechnicalSectionConfigEntry {
  key: PrdTechnicalRequirementKey
  label: string
  interviewPhase: 'Structure' | 'Assembly'
}

export interface PrdApprovalOutlineSection {
  key: 'product' | 'scope' | 'technical_requirements' | 'risks'
  label: string
  description: string
  anchorId: string
}

export interface PrdApprovalOutlineStory {
  id: string
  title: string
  anchorId: string
}

export interface PrdApprovalOutlineEpic {
  id: string
  label: string
  description: string
  anchorId: string
  userStories: PrdApprovalOutlineStory[]
}

export interface PrdApprovalOutline {
  product: PrdApprovalOutlineSection
  scope: PrdApprovalOutlineSection
  technicalRequirements: PrdApprovalOutlineSection
  risks: PrdApprovalOutlineSection
  epics: PrdApprovalOutlineEpic[]
}

export const PRD_APPROVAL_FOCUS_EVENT = 'looptroop:prd-approval-focus'

export const PRD_TECHNICAL_SECTION_CONFIG: PrdTechnicalSectionConfigEntry[] = [
  { key: 'architecture_constraints', label: 'Architecture Constraints', interviewPhase: 'Structure' },
  { key: 'data_model', label: 'Data Model', interviewPhase: 'Structure' },
  { key: 'api_contracts', label: 'API Contracts', interviewPhase: 'Structure' },
  { key: 'security_constraints', label: 'Security Constraints', interviewPhase: 'Structure' },
  { key: 'performance_constraints', label: 'Performance Constraints', interviewPhase: 'Assembly' },
  { key: 'reliability_constraints', label: 'Reliability Constraints', interviewPhase: 'Assembly' },
  { key: 'error_handling_rules', label: 'Error Handling Rules', interviewPhase: 'Assembly' },
  { key: 'tooling_assumptions', label: 'Tooling Assumptions', interviewPhase: 'Assembly' },
]

function normalizePrdUserStory(value: unknown, index: number): PrdUserStory | null {
  if (!isRecord(value)) return null

  const title = toStringValue(value.title).trim()
  if (!title) return null

  return {
    id: toStringValue(value.id).trim() || `US-${index + 1}`,
    title,
    acceptance_criteria: toStringArray(value.acceptance_criteria),
    implementation_steps: toStringArray(value.implementation_steps),
    verification: normalizeVerification(value.verification),
  }
}

function normalizePrdEpic(value: unknown, index: number): PrdEpic | null {
  if (!isRecord(value)) return null

  const title = toStringValue(value.title).trim()
  if (!title) return null

  const stories = Array.isArray(value.user_stories)
    ? value.user_stories
      .map((story, storyIndex) => normalizePrdUserStory(story, storyIndex))
      .filter((story): story is PrdUserStory => story !== null)
    : []

  return {
    id: toStringValue(value.id).trim() || `EPIC-${index + 1}`,
    title,
    objective: toStringValue(value.objective).trim(),
    implementation_steps: toStringArray(value.implementation_steps),
    user_stories: stories,
  }
}

export function normalizePrdDocumentLike(value: unknown): PrdDocument | null {
  if (!isRecord(value) || value.artifact !== 'prd' || !Array.isArray(value.epics)) {
    return null
  }

  const technicalRequirements = isRecord(value.technical_requirements) ? value.technical_requirements : {}
  const product = isRecord(value.product) ? value.product : {}
  const scope = isRecord(value.scope) ? value.scope : {}
  const sourceInterview = isRecord(value.source_interview) ? value.source_interview : {}
  const approval = isRecord(value.approval) ? value.approval : {}
  const epics = value.epics
    .map((epic, epicIndex) => normalizePrdEpic(epic, epicIndex))
    .filter((epic): epic is PrdEpic => epic !== null)

  if (epics.length === 0) {
    return null
  }

  return {
    schema_version: typeof value.schema_version === 'number' ? value.schema_version : 1,
    ticket_id: toStringValue(value.ticket_id).trim(),
    artifact: 'prd',
    status: value.status === 'approved' ? 'approved' : 'draft',
    source_interview: {
      content_sha256: toStringValue(sourceInterview.content_sha256).trim(),
    },
    product: {
      problem_statement: toStringValue(product.problem_statement).trim(),
      target_users: toStringArray(product.target_users),
    },
    scope: {
      in_scope: toStringArray(scope.in_scope),
      out_of_scope: toStringArray(scope.out_of_scope),
    },
    technical_requirements: {
      architecture_constraints: toStringArray(technicalRequirements.architecture_constraints),
      data_model: toStringArray(technicalRequirements.data_model),
      api_contracts: toStringArray(technicalRequirements.api_contracts),
      security_constraints: toStringArray(technicalRequirements.security_constraints),
      performance_constraints: toStringArray(technicalRequirements.performance_constraints),
      reliability_constraints: toStringArray(technicalRequirements.reliability_constraints),
      error_handling_rules: toStringArray(technicalRequirements.error_handling_rules),
      tooling_assumptions: toStringArray(technicalRequirements.tooling_assumptions),
    },
    epics,
    risks: toStringArray(value.risks),
    approval: {
      approved_by: toStringValue(approval.approved_by).trim(),
      approved_at: toStringValue(approval.approved_at).trim(),
    },
  }
}

export function parsePrdDocumentContent(content: string): PrdDocumentParseResult {
  if (!content.trim()) {
    return { document: null, error: 'PRD YAML is empty.' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    try {
      parsed = jsYaml.load(content)
    } catch (error) {
      return {
        document: null,
        error: error instanceof Error ? error.message : 'PRD YAML could not be parsed.',
      }
    }
  }

  const document = normalizePrdDocumentLike(parsed)
  if (!document) {
    return {
      document: null,
      error: 'PRD YAML must contain an artifact: prd document with at least one epic.',
    }
  }

  return { document, error: null }
}

export function parsePrdDocument(content: string | null | undefined): PrdDocument | null {
  if (typeof content !== 'string') return null
  return parsePrdDocumentContent(content).document
}

function cloneStory(story: PrdUserStory): PrdUserStory {
  return {
    ...story,
    acceptance_criteria: [...story.acceptance_criteria],
    implementation_steps: [...story.implementation_steps],
    verification: {
      required_commands: [...story.verification.required_commands],
    },
  }
}

function cloneEpic(epic: PrdEpic): PrdEpic {
  return {
    ...epic,
    implementation_steps: [...epic.implementation_steps],
    user_stories: epic.user_stories.map(cloneStory),
  }
}

export function buildPrdApprovalDraft(document: PrdDocument): PrdApprovalDraft {
  return {
    product: {
      problem_statement: document.product.problem_statement,
      target_users: [...document.product.target_users],
    },
    scope: {
      in_scope: [...document.scope.in_scope],
      out_of_scope: [...document.scope.out_of_scope],
    },
    technical_requirements: {
      architecture_constraints: [...document.technical_requirements.architecture_constraints],
      data_model: [...document.technical_requirements.data_model],
      api_contracts: [...document.technical_requirements.api_contracts],
      security_constraints: [...document.technical_requirements.security_constraints],
      performance_constraints: [...document.technical_requirements.performance_constraints],
      reliability_constraints: [...document.technical_requirements.reliability_constraints],
      error_handling_rules: [...document.technical_requirements.error_handling_rules],
      tooling_assumptions: [...document.technical_requirements.tooling_assumptions],
    },
    epics: document.epics.map(cloneEpic),
    risks: [...document.risks],
  }
}

export function normalizePrdApprovalDraft(value: unknown, document: PrdDocument): PrdApprovalDraft {
  const fallback = buildPrdApprovalDraft(document)
  if (!isRecord(value)) return fallback

  const normalized = normalizePrdDocumentLike({
    ...document,
    product: value.product,
    scope: value.scope,
    technical_requirements: value.technical_requirements,
    epics: value.epics,
    risks: value.risks,
  })

  return normalized ? buildPrdApprovalDraft(normalized) : fallback
}

export function buildPrdDocumentFromDraft(document: PrdDocument, draft: PrdApprovalDraft): PrdDocument {
  return {
    ...document,
    product: {
      problem_statement: draft.product.problem_statement.trim(),
      target_users: [...draft.product.target_users],
    },
    scope: {
      in_scope: [...draft.scope.in_scope],
      out_of_scope: [...draft.scope.out_of_scope],
    },
    technical_requirements: {
      architecture_constraints: [...draft.technical_requirements.architecture_constraints],
      data_model: [...draft.technical_requirements.data_model],
      api_contracts: [...draft.technical_requirements.api_contracts],
      security_constraints: [...draft.technical_requirements.security_constraints],
      performance_constraints: [...draft.technical_requirements.performance_constraints],
      reliability_constraints: [...draft.technical_requirements.reliability_constraints],
      error_handling_rules: [...draft.technical_requirements.error_handling_rules],
      tooling_assumptions: [...draft.technical_requirements.tooling_assumptions],
    },
    epics: draft.epics.map(cloneEpic),
    risks: [...draft.risks],
  }
}

export function buildPrdDocumentYaml(document: PrdDocument): string {
  return jsYaml.dump(document, {
    sortKeys: false,
    noRefs: true,
    lineWidth: -1,
  })
}

export function getPrdProductAnchorId(): string {
  return 'prd-product'
}

export function getPrdScopeAnchorId(): string {
  return 'prd-scope'
}

export function getPrdTechnicalRequirementsAnchorId(): string {
  return 'prd-technical-requirements'
}

export function getPrdTechnicalRequirementAnchorId(key: PrdTechnicalRequirementKey): string {
  return `prd-technical-${slugify(key) || 'section'}`
}

export function getPrdRisksAnchorId(): string {
  return 'prd-risks'
}

export function getPrdEpicAnchorId(epicId: string): string {
  return `prd-epic-${slugify(epicId) || 'epic'}`
}

export function getPrdUserStoryAnchorId(epicId: string, storyId: string): string {
  return `prd-story-${slugify(epicId) || 'epic'}-${slugify(storyId) || 'story'}`
}

export function getPrdStoryAnchorId(storyId: string): string {
  return getPrdUserStoryAnchorId('story', storyId)
}

export function dispatchPrdApprovalFocus(ticketId: string, anchorId: string) {
  window.dispatchEvent(new CustomEvent(PRD_APPROVAL_FOCUS_EVENT, {
    detail: { ticketId, anchorId },
  }))
}

export function buildPrdApprovalOutline(document: PrdDocument): PrdApprovalOutline {
  const technicalRequirementsCount = Object.values(document.technical_requirements).reduce(
    (count, items) => count + items.length,
    0,
  )

  return {
    product: {
      key: 'product',
      label: 'Product',
      description: document.product.problem_statement || 'Problem statement and target users.',
      anchorId: getPrdProductAnchorId(),
    },
    scope: {
      key: 'scope',
      label: 'Scope',
      description: `${document.scope.in_scope.length} in scope, ${document.scope.out_of_scope.length} out of scope.`,
      anchorId: getPrdScopeAnchorId(),
    },
    technicalRequirements: {
      key: 'technical_requirements',
      label: 'Technical Requirements',
      description: technicalRequirementsCount > 0
        ? `${technicalRequirementsCount} requirement${technicalRequirementsCount === 1 ? '' : 's'} recorded.`
        : 'Architecture, data, API, and delivery constraints.',
      anchorId: getPrdTechnicalRequirementsAnchorId(),
    },
    risks: {
      key: 'risks',
      label: 'Risks',
      description: document.risks.length > 0
        ? `${document.risks.length} risk${document.risks.length === 1 ? '' : 's'} recorded.`
        : 'Known product risks and open concerns.',
      anchorId: getPrdRisksAnchorId(),
    },
    epics: document.epics.map((epic) => ({
      id: epic.id,
      label: epic.title || epic.id,
      description: epic.objective,
      anchorId: getPrdEpicAnchorId(epic.id),
      userStories: epic.user_stories.map((story) => ({
        id: story.id,
        title: story.title,
        anchorId: getPrdUserStoryAnchorId(epic.id, story.id),
      })),
    })),
  }
}
