import type { RefinementChange } from '@shared/refinementChanges'
import type { StructuredRetryDiagnostic } from '@shared/structuredRetryDiagnostics'
import { contentSha256 } from '../lib/contentHash'
import { looksLikePromptEcho, looksLikeStructuredPromptSchemaEcho } from '../lib/promptEcho'
import type { PrdDocument, PrdDraftMetrics, StructuredOutputResult } from './types'
import { normalizeInterviewDocumentOutput } from './interviewDocument'
import {
  isRecord,
  collectStructuredCandidates,
  normalizeKey,
  unwrapExplicitWrapperRecord,
  parseYamlOrJsonCandidate,
  toStringArray,
  getValueByAliases,
  getNestedRecord,
  getRequiredString,
  buildYamlDocument,
  appendStructuredCandidateRecoveryWarning,
  collectAliasConflictWarnings,
} from './yamlUtils'
import { parseRefinementChanges } from './refinementChanges'
import { buildStructuredOutputFailure } from './failure'
import { getErrorMessage } from '@shared/typeGuards'
import { normalizeCommandSpec, type CommandSpec } from '@shared/commandSpec'
import { detectHostContext } from '../lib/hostContext'

const PRD_NESTED_MAPPING_CHILDREN = {
  source_interview: ['content_sha256'],
  product: ['problem_statement', 'target_users'],
  scope: ['in_scope', 'out_of_scope'],
  technical_requirements: [
    'architecture_constraints',
    'data_model',
    'api_contracts',
    'security_constraints',
    'performance_constraints',
    'reliability_constraints',
    'error_handling_rules',
    'tooling_assumptions',
  ],
  approval: ['approved_by', 'approved_at'],
  verification: ['required_commands'],
} as const

const PRD_SEQUENCE_ITEM_PRIMARY_KEYS = {
  epics: {
    primaryKey: 'id',
    childKeys: ['title', 'name', 'objective', 'goal', 'implementation_steps', 'implementationSteps', 'steps', 'user_stories', 'userStories', 'stories'],
  },
  user_stories: {
    primaryKey: 'id',
    childKeys: ['title', 'name', 'acceptance_criteria', 'acceptanceCriteria', 'implementation_steps', 'implementationSteps', 'steps', 'verification'],
  },
  stories: {
    primaryKey: 'id',
    childKeys: ['title', 'name', 'acceptance_criteria', 'acceptanceCriteria', 'implementation_steps', 'implementationSteps', 'steps', 'verification'],
  },
} as const

const PRD_PROMPT_ECHO_ERROR = 'PRD output echoed the prompt instead of returning structured PRD YAML'

function readOptionalString(record: Record<string, unknown>, aliases: string[]): string {
  const value = getValueByAliases(record, aliases)
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeVerification(
  record: Record<string, unknown>,
  repairWarnings: string[],
): { required_commands: CommandSpec[] } {
  const verification = getNestedRecord(record, ['verification'])
  const rawCommands = getValueByAliases(verification, ['requiredcommands', 'required_commands', 'commands'])
  const commands = Array.isArray(rawCommands) ? rawCommands : []
  const host = detectHostContext()
  return {
    required_commands: commands.map((value, index) => {
      const normalized = normalizeCommandSpec(value, host)
      if (normalized.warning) {
        repairWarnings.push(`verification.required_commands[${index}]: ${normalized.warning}`)
      }
      return normalized.command
    }),
  }
}

function normalizeStatus(value: unknown, repairWarnings: string[]): PrdDocument['status'] {
  const raw = typeof value === 'string' ? value.trim() : ''
  const normalized = normalizeKey(raw)
  if (!raw || normalized === 'draft') return 'draft'
  if (normalized === 'approved') return 'approved'
  repairWarnings.push(`Normalized unsupported PRD status "${raw}" to draft.`)
  return 'draft'
}

function normalizeSchemaVersion(value: unknown, repairWarnings: string[]): number {
  const next = Number(value)
  if (Number.isInteger(next) && next > 0) return next
  if (value !== undefined) {
    repairWarnings.push('Normalized invalid schema_version to 1.')
  }
  return 1
}

function allocateDeterministicId(
  rawId: string,
  fallbackBase: string,
  usedIds: Set<string>,
  repairWarnings: string[],
  missingMessage: string,
  duplicateMessage: (original: string, replacement: string) => string,
): string {
  if (rawId && !usedIds.has(rawId)) {
    usedIds.add(rawId)
    return rawId
  }

  let candidate = fallbackBase
  let suffix = 2
  while (usedIds.has(candidate)) {
    candidate = `${fallbackBase}-${suffix}`
    suffix += 1
  }

  if (!rawId) {
    repairWarnings.push(`${missingMessage} Filled with ${candidate}.`)
  } else {
    repairWarnings.push(duplicateMessage(rawId, candidate))
  }

  usedIds.add(candidate)
  return candidate
}

function normalizeUserStory(
  value: unknown,
  epicIndex: number,
  storyIndex: number,
  usedStoryIds: Set<string>,
  repairWarnings: string[],
): PrdDocument['epics'][number]['user_stories'][number] {
  if (!isRecord(value)) {
    throw new Error(`Epic user story at index ${storyIndex} is not an object`)
  }

  const rawId = readOptionalString(value, ['id', 'storyid'])
  const id = allocateDeterministicId(
    rawId,
    `US-${epicIndex + 1}-${storyIndex + 1}`,
    usedStoryIds,
    repairWarnings,
    `User story at epic ${epicIndex + 1}, index ${storyIndex} was missing id.`,
    (original, replacement) => `Renumbered duplicate user story id ${original} to ${replacement}.`,
  )

  return {
    id,
    title: getRequiredString(value, ['title', 'name'], `user story title at index ${storyIndex}`),
    acceptance_criteria: toStringArray(getValueByAliases(value, ['acceptancecriteria', 'acceptance_criteria'])),
    implementation_steps: toStringArray(getValueByAliases(value, ['implementationsteps', 'implementation_steps', 'steps'])),
    verification: normalizeVerification(value, repairWarnings),
  }
}

function normalizeEpic(
  value: unknown,
  index: number,
  usedEpicIds: Set<string>,
  usedStoryIds: Set<string>,
  repairWarnings: string[],
): PrdDocument['epics'][number] {
  if (!isRecord(value)) throw new Error(`Epic at index ${index} is not an object`)

  const rawStories = getValueByAliases(value, ['userstories', 'user_stories', 'stories'])
  const userStories = Array.isArray(rawStories)
    ? rawStories.map((story, storyIndex) => normalizeUserStory(story, index, storyIndex, usedStoryIds, repairWarnings))
    : []

  if (userStories.length === 0) {
    throw new Error(`Epic at index ${index} is missing user stories`)
  }

  const rawId = readOptionalString(value, ['id', 'epicid'])
  const id = allocateDeterministicId(
    rawId,
    `EPIC-${index + 1}`,
    usedEpicIds,
    repairWarnings,
    `Epic at index ${index} was missing id.`,
    (original, replacement) => `Renumbered duplicate epic id ${original} to ${replacement}.`,
  )

  return {
    id,
    title: getRequiredString(value, ['title', 'name'], `epic title at index ${index}`),
    objective: getRequiredString(value, ['objective', 'goal'], `epic objective at index ${index}`),
    implementation_steps: toStringArray(getValueByAliases(value, ['implementationsteps', 'implementation_steps', 'steps'])),
    user_stories: userStories,
  }
}

function ensureInterviewArtifactForPrd(
  interviewContent: string | undefined,
  ticketId: string,
): string {
  if (!interviewContent?.trim()) {
    throw new Error('Canonical interview artifact is required for PRD normalization')
  }

  const result = normalizeInterviewDocumentOutput(interviewContent, { ticketId })
  if (!result.ok) {
    throw new Error(`Interview artifact is invalid: ${result.error}`)
  }

  return result.normalizedContent
}

function unwrapPrdArtifactObjectWrapper(value: unknown): unknown {
  if (!isRecord(value)) return value

  const artifact = getValueByAliases(value, ['artifact'])
  if (!isRecord(artifact)) return value

  const nestedPrd = getValueByAliases(artifact, ['prd'])
  if (!isRecord(nestedPrd)) return value

  return {
    ...value,
    ...nestedPrd,
    artifact: 'prd',
  }
}

export function getPrdDraftMetrics(document: Pick<PrdDocument, 'epics'>): PrdDraftMetrics {
  return {
    epicCount: document.epics.length,
    userStoryCount: document.epics.reduce((sum, epic) => sum + epic.user_stories.length, 0),
  }
}

export function normalizePrdYamlOutput(
  rawContent: string,
  options: {
    ticketId: string
    interviewContent?: string
    losingDraftMeta?: Array<{ memberId: string }>
  },
): StructuredOutputResult<PrdDocument & { changes?: RefinementChange[] }> {
  if (looksLikePromptEcho(rawContent)) {
    return buildStructuredOutputFailure(
      rawContent,
      PRD_PROMPT_ECHO_ERROR,
    )
  }

  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['schema_version', 'artifact', 'product', 'scope', 'technical_requirements', 'epics'],
  })
  let lastError = 'No PRD content found'
  let lastErrorCause: unknown = null
  let preferredPromptEchoError: string | undefined
  let preferredPromptEchoRetryDiagnostic: StructuredRetryDiagnostic | undefined

  for (const candidate of candidates) {
    const repairWarnings: string[] = []
    const releaseAliasConflicts = collectAliasConflictWarnings(repairWarnings)

    try {
      if (looksLikeStructuredPromptSchemaEcho(candidate, {
        rootKeys: ['schema_version', 'ticket_id', 'artifact', 'product', 'scope', 'technical_requirements', 'epics'],
      })) {
        const failure = buildStructuredOutputFailure(candidate, PRD_PROMPT_ECHO_ERROR)
        preferredPromptEchoError ??= failure.error
        preferredPromptEchoRetryDiagnostic ??= failure.retryDiagnostic
        continue
      }

      const parsed = unwrapPrdArtifactObjectWrapper(unwrapExplicitWrapperRecord(parseYamlOrJsonCandidate(candidate, {
        nestedMappingChildren: PRD_NESTED_MAPPING_CHILDREN,
        sequenceItemPrimaryKeys: PRD_SEQUENCE_ITEM_PRIMARY_KEYS,
        allowTrailingTerminalNoise: true,
        repairWarnings,
      }), [
        'prd',
        'document',
        'output',
        'result',
        'data',
      ]))
      if (!isRecord(parsed)) throw new Error('PRD output is not a YAML/JSON object')

      // Extract changes before PRD validation (changes is not part of the PRD schema)
      const rawChanges = getValueByAliases(parsed, ['changes'])
      if (rawChanges !== undefined) {
        delete (parsed as Record<string, unknown>).changes
      }
      const parsedRefinementChanges = parseRefinementChanges(rawChanges, options.losingDraftMeta)
      repairWarnings.push(...parsedRefinementChanges.repairWarnings)

      const product = getNestedRecord(parsed, ['product'])
      const scope = getNestedRecord(parsed, ['scope'])
      const technicalRequirements = getNestedRecord(parsed, ['technicalrequirements', 'technical_requirements'])
      const sourceInterview = getNestedRecord(parsed, ['sourceinterview', 'source_interview'])
      const approval = getNestedRecord(parsed, ['approval'])
      const rawEpics = getValueByAliases(parsed, ['epics'])
      const usedEpicIds = new Set<string>()
      const usedStoryIds = new Set<string>()
      const epics = Array.isArray(rawEpics)
        ? rawEpics.map((epic, index) => normalizeEpic(epic, index, usedEpicIds, usedStoryIds, repairWarnings))
        : []

      if (epics.length === 0) {
        throw new Error('PRD is missing epics')
      }

      const normalizedInterviewContent = ensureInterviewArtifactForPrd(options.interviewContent, options.ticketId)
      const runtimeInterviewHash = contentSha256(normalizedInterviewContent ?? '')
      const providedTicketId = readOptionalString(parsed, ['ticketid', 'ticket_id'])
      const providedInterviewHash = readOptionalString(sourceInterview, ['contentsha256', 'content_sha256'])
      const runtimeTicketId = options.ticketId.trim()
      const canonicalTicketId = runtimeTicketId || providedTicketId
      if (!providedTicketId) {
        repairWarnings.push('Filled missing ticket_id from runtime context.')
      } else if (providedTicketId !== runtimeTicketId) {
        repairWarnings.push(`Canonicalized ticket_id from ${providedTicketId} to ${runtimeTicketId}.`)
      }
      if (providedInterviewHash && providedInterviewHash !== runtimeInterviewHash) {
        repairWarnings.push('Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.')
      }

      const document: PrdDocument = {
        schema_version: normalizeSchemaVersion(getValueByAliases(parsed, ['schemaversion', 'schema_version']), repairWarnings),
        ticket_id: canonicalTicketId,
        artifact: 'prd',
        status: normalizeStatus(getValueByAliases(parsed, ['status']), repairWarnings),
        source_interview: {
          content_sha256: runtimeInterviewHash,
        },
        product: {
          problem_statement: getRequiredString(product, ['problemstatement', 'problem_statement'], 'product.problem_statement'),
          target_users: toStringArray(getValueByAliases(product, ['targetusers', 'target_users'])),
        },
        scope: {
          in_scope: toStringArray(getValueByAliases(scope, ['inscope', 'in_scope'])),
          out_of_scope: toStringArray(getValueByAliases(scope, ['outofscope', 'out_of_scope'])),
        },
        technical_requirements: {
          architecture_constraints: toStringArray(getValueByAliases(technicalRequirements, ['architectureconstraints', 'architecture_constraints'])),
          data_model: toStringArray(getValueByAliases(technicalRequirements, ['datamodel', 'data_model'])),
          api_contracts: toStringArray(getValueByAliases(technicalRequirements, ['apicontracts', 'api_contracts'])),
          security_constraints: toStringArray(getValueByAliases(technicalRequirements, ['securityconstraints', 'security_constraints'])),
          performance_constraints: toStringArray(getValueByAliases(technicalRequirements, ['performanceconstraints', 'performance_constraints'])),
          reliability_constraints: toStringArray(getValueByAliases(technicalRequirements, ['reliabilityconstraints', 'reliability_constraints'])),
          error_handling_rules: toStringArray(getValueByAliases(technicalRequirements, ['errorhandlingrules', 'error_handling_rules'])),
          tooling_assumptions: toStringArray(getValueByAliases(technicalRequirements, ['toolingassumptions', 'tooling_assumptions'])),
        },
        epics,
        risks: toStringArray(getValueByAliases(parsed, ['risks'])),
        approval: {
          approved_by: readOptionalString(approval, ['approvedby', 'approved_by']),
          approved_at: readOptionalString(approval, ['approvedat', 'approved_at']),
        },
      }

      const valueWithChanges = parsedRefinementChanges.changes.length > 0
        ? { ...document, changes: parsedRefinementChanges.changes }
        : document
      appendStructuredCandidateRecoveryWarning(repairWarnings, rawContent, candidate)

      return {
        ok: true,
        value: valueWithChanges,
        normalizedContent: buildYamlDocument(document),
        repairApplied: candidate !== rawContent.trim() || repairWarnings.length > 0,
        repairWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
      if (/echoed the prompt/i.test(lastError)) {
        const failure = buildStructuredOutputFailure(candidate, lastError, { cause: error })
        preferredPromptEchoError ??= failure.error
        preferredPromptEchoRetryDiagnostic ??= failure.retryDiagnostic
      }
    } finally {
      releaseAliasConflicts()
    }
  }

  if (preferredPromptEchoError) {
    return buildStructuredOutputFailure(rawContent, preferredPromptEchoError, {
      retryDiagnostic: preferredPromptEchoRetryDiagnostic,
    })
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? PRD_PROMPT_ECHO_ERROR
      : lastError,
    { cause: lastErrorCause },
  )
}
