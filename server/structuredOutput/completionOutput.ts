import type { BeadChecks } from '../phases/execution/completionSchema'
import { looksLikePromptEcho } from '../lib/promptEcho'
import { detectHostContext } from '../lib/hostContext'
import { hostContextSchema } from '@shared/hostContext'
import { normalizeCommandSpec, runtimeEnvironmentSchema } from '@shared/commandSpec'
import type {
  BeadCompletionPayload,
  ExecutionSetupPlanPayload,
  ExecutionSetupProfilePayload,
  ExecutionSetupProvisioningAttemptPayload,
  ExecutionSetupResultPayload,
  ExecutionSetupStatus,
  ExecutionSetupToolRequirementStatus,
  ExecutionSetupCommandProbePayload,
  ExecutionSetupGitHooksPayload,
  FinalTestCommandPayload,
  FinalTestFileEffect,
  FinalTestFileEffectIntent,
  StructuredOutputResult,
} from './types'
import { EXECUTION_SETUP_WORKSPACE_INPUT_CATEGORIES, isExecutionSetupWorkspaceInputCategory } from './types'
import {
  isRecord,
  normalizeKey,
  collectTaggedCandidates,
  maybeUnwrapRecord,
  unwrapExplicitWrapperRecord,
  appendStructuredCandidateRecoveryWarning,
  appendWrapperKeyRepairWarning,
  findExplicitWrapperPath,
  findMaybeUnwrappedWrapperPath,
  parseYamlOrJsonCandidate,
  shouldRecordStructuredCandidateRecovery,
  toStringArray,
  toOptionalString,
  toInteger,
  toBoolean,
  getValueByAliases,
  getRequiredString,
} from './yamlUtils'
import { buildStructuredOutputFailure } from './failure'
import { getErrorMessage } from '@shared/typeGuards'
import { DEFAULT_GIT_HOOK_POLICY, isGitHookPolicy } from '@shared/gitHookPolicy'

const COMPLETION_NESTED_MAPPING_CHILDREN = {
  checks: ['tests', 'lint', 'typecheck', 'qualitative'],
} as const

function normalizeCompletionStatus(value: unknown): 'done' | 'error' {
  const raw = getRequiredString({ status: value }, ['status'], 'status')
  const normalized = normalizeKey(raw)
  if (['completed', 'complete', 'done', 'success', 'succeeded'].includes(normalized)) {
    return 'done'
  }
  if (['failed', 'fail', 'error'].includes(normalized)) {
    return 'error'
  }
  throw new Error(`Invalid completion status: ${raw}`)
}

function normalizeCompletionCheckValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'pass' : 'fail'
  if (typeof value === 'number') {
    if (value === 1) return 'pass'
    if (value === 0) return 'fail'
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Completion marker check value must be a non-empty string')
  }

  const normalized = normalizeKey(value)
  if (['pass', 'passed', 'ok', 'success', 'true', 'complete', 'completed'].includes(normalized)) {
    return 'pass'
  }
  if (['fail', 'failed', 'false', 'error', 'timeout', 'timedout', 'notrun', 'skipped', 'pending'].includes(normalized)) {
    return 'fail'
  }
  return value.trim().toLowerCase()
}

function normalizeCompletionChecks(value: unknown): BeadChecks {
  if (!isRecord(value)) throw new Error('Completion marker missing checks object')

  const tests = getValueByAliases(value, ['tests', 'test'])
  const lint = getValueByAliases(value, ['lint', 'linter'])
  const typecheck = getValueByAliases(value, ['typecheck', 'type_check', 'type-check', 'typechecks', 'typescript'])
  const qualitative = getValueByAliases(value, ['qualitative', 'quality', 'qualitativereview', 'qualitative_review', 'review'])

  if (tests === undefined) throw new Error('Missing quality gate: tests')
  if (lint === undefined) throw new Error('Missing quality gate: lint')
  if (typecheck === undefined) throw new Error('Missing quality gate: typecheck')
  if (qualitative === undefined) throw new Error('Missing quality gate: qualitative')

  return {
    tests: normalizeCompletionCheckValue(tests),
    lint: normalizeCompletionCheckValue(lint),
    typecheck: normalizeCompletionCheckValue(typecheck),
    qualitative: normalizeCompletionCheckValue(qualitative),
  }
}

function normalizeFinalTestFileEffectIntent(value: unknown): FinalTestFileEffectIntent {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Final test file effect intent must be a non-empty string')
  }
  const normalized = normalizeKey(value)
  if (['candidate', 'include', 'included', 'commit', 'committed', 'permanent', 'keep'].includes(normalized)) {
    return 'candidate'
  }
  if (['temporary', 'temp', 'scratch', 'artifact', 'generated', 'exclude', 'excluded'].includes(normalized)) {
    return 'temporary'
  }
  if (['unexpected', 'unknown', 'unintended', 'accidental'].includes(normalized)) {
    return 'unexpected'
  }
  throw new Error(`Invalid final test file effect intent: ${value}`)
}

/**
 * Keeping the first occurrence of a path and dropping the rest hid the case that
 * matters: the same file listed twice with different intents, where one of them
 * says the file is a temporary artifact and the other says it should be
 * committed. Identical duplicates merge; a real disagreement is a validation
 * error.
 *
 * A bare string carries no intent of its own, so it defers to any entry that
 * states one instead of competing with it.
 */
function normalizeFinalTestFileEffects(value: unknown, repairWarnings?: string[]): FinalTestFileEffect[] {
  if (value === undefined || value === null) return []
  const rawEffects = Array.isArray(value) ? value : [value]
  const byPath = new Map<string, { effect: FinalTestFileEffect; explicitIntent: boolean }>()

  const record = (
    path: string,
    effect: FinalTestFileEffect,
    explicitIntent: boolean,
  ) => {
    const existing = byPath.get(path)
    if (!existing) {
      byPath.set(path, { effect, explicitIntent })
      return
    }
    if (existing.explicitIntent && explicitIntent && existing.effect.intent !== effect.intent) {
      throw new Error(`Final test file effect for ${path} declares conflicting intents "${existing.effect.intent}" and "${effect.intent}"`)
    }
    if (existing.effect.reason && effect.reason && existing.effect.reason !== effect.reason) {
      throw new Error(`Final test file effect for ${path} declares conflicting reasons`)
    }
    const winner = explicitIntent && !existing.explicitIntent ? effect : existing.effect
    const reason = winner.reason ?? existing.effect.reason ?? effect.reason
    byPath.set(path, {
      effect: { path, intent: winner.intent, ...(reason ? { reason } : {}) },
      explicitIntent: existing.explicitIntent || explicitIntent,
    })
    repairWarnings?.push(`Merged duplicate final test file effect entries for ${path}.`)
  }

  for (const rawEffect of rawEffects) {
    if (typeof rawEffect === 'string') {
      const path = rawEffect.trim()
      if (!path) continue
      record(path, { path, intent: 'candidate' }, false)
      continue
    }
    if (!isRecord(rawEffect)) {
      throw new Error('Final test file effect entries must be objects or paths')
    }
    const path = toOptionalString(getValueByAliases(rawEffect, ['path', 'file', 'filepath', 'file_path']))
    if (!path) {
      throw new Error('Final test file effect entry is missing path')
    }
    const intent = normalizeFinalTestFileEffectIntent(getValueByAliases(rawEffect, ['intent', 'kind', 'type', 'action']))
    const reason = toOptionalString(getValueByAliases(rawEffect, ['reason', 'why', 'notes', 'summary']))
    record(path, { path, intent, ...(reason ? { reason } : {}) }, true)
  }

  return [...byPath.values()].map((entry) => entry.effect)
}

export function normalizeBeadCompletionMarkerOutput(rawContent: string): StructuredOutputResult<BeadCompletionPayload> {
  const candidates = collectTaggedCandidates(rawContent, 'BEAD_STATUS')
  let lastError = 'No completion marker found'
  let lastErrorCause: unknown = null

  if (candidates.length === 0) {
    return buildStructuredOutputFailure(
      rawContent,
      looksLikePromptEcho(rawContent)
        ? 'Completion marker output echoed the prompt instead of returning a <BEAD_STATUS> artifact'
        : lastError,
    )
  }

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    try {
      const parsedCandidate = parseYamlOrJsonCandidate(candidate, {
        nestedMappingChildren: COMPLETION_NESTED_MAPPING_CHILDREN,
        repairWarnings: candidateWarnings,
      })
      const parsed = maybeUnwrapRecord(parsedCandidate, [
        'beadstatus',
        'bead_status',
        'statusmarker',
        'marker',
        'result',
        'output',
        'data',
      ])
      if (!isRecord(parsed)) throw new Error('Completion marker payload is not a YAML/JSON object')
      if (parsed !== parsedCandidate && isRecord(parsedCandidate)) {
        appendWrapperKeyRepairWarning(candidateWarnings, findMaybeUnwrappedWrapperPath(parsedCandidate, [
          'beadstatus',
          'bead_status',
          'statusmarker',
          'marker',
          'result',
          'output',
          'data',
        ]))
      }

      const beadId = getRequiredString(parsed, ['beadid', 'bead_id', 'id'], 'bead_id')
      const status = normalizeCompletionStatus(getValueByAliases(parsed, ['status']))
      const checks = normalizeCompletionChecks(getValueByAliases(parsed, ['checks', 'gates', 'qualitygates', 'quality_gates']))
      const reason = toOptionalString(getValueByAliases(parsed, ['reason', 'details', 'message']))
      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate, { tag: 'BEAD_STATUS' })

      return {
        ok: true,
        value: {
          beadId,
          status,
          checks,
          ...(reason ? { reason } : {}),
        },
        normalizedContent: JSON.stringify({
          bead_id: beadId,
          status,
          checks,
          ...(reason ? { reason } : {}),
        }),
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate, { tag: 'BEAD_STATUS' }),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Completion marker output echoed the prompt instead of returning a <BEAD_STATUS> artifact'
      : lastError,
    { cause: lastErrorCause },
  )
}

export function normalizeFinalTestCommandsOutput(
  rawContent: string,
  hostContext = detectHostContext(),
): StructuredOutputResult<FinalTestCommandPayload> {
  const candidates = collectTaggedCandidates(rawContent, 'FINAL_TEST_COMMANDS')
  let lastError = 'No final test command marker found'
  let lastErrorCause: unknown = null

  if (candidates.length === 0) {
    return buildStructuredOutputFailure(
      rawContent,
      looksLikePromptEcho(rawContent)
        ? 'Final test command output echoed the prompt instead of returning a <FINAL_TEST_COMMANDS> artifact'
        : lastError,
    )
  }

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    try {
      const parsedCandidate = parseYamlOrJsonCandidate(candidate, { repairWarnings: candidateWarnings })
      const parsed = unwrapExplicitWrapperRecord(parsedCandidate, [
        'finaltestcommands',
        'final_test_commands',
        'commandplan',
        'command_plan',
        'plan',
        'result',
        'output',
        'data',
      ])
      if (!isRecord(parsed)) throw new Error('Final test command payload is not a YAML/JSON object')
      if (parsed !== parsedCandidate && isRecord(parsedCandidate)) {
        appendWrapperKeyRepairWarning(candidateWarnings, findExplicitWrapperPath(parsedCandidate, [
          'finaltestcommands',
          'final_test_commands',
          'commandplan',
          'command_plan',
          'plan',
          'result',
          'output',
          'data',
        ]))
      }

      const rawCommands = getValueByAliases(parsed, ['commands', 'commandlist', 'command_list', 'cmds', 'cmd'])
      const commandValues = Array.isArray(rawCommands)
        ? rawCommands
        : typeof rawCommands === 'string'
          ? [rawCommands]
          : []
      if (typeof rawCommands === 'string') {
        candidateWarnings.push('Coerced commands from string to array')
      }
      const commands = commandValues.map((command) => {
        const normalized = normalizeCommandSpec(command, hostContext)
        if (normalized.warning) candidateWarnings.push(normalized.warning)
        return normalized.command
      })
      if (commands.length === 0) {
        throw new Error('No executable final test commands were provided')
      }

      const summary = toOptionalString(getValueByAliases(parsed, ['summary', 'reason', 'notes'])) ?? null

      const rawTestFiles = getValueByAliases(parsed, ['test_files', 'testfiles', 'test_file', 'testfile'])
      const testFiles = toStringArray(rawTestFiles).filter((f) => f.length > 0)
      if (typeof rawTestFiles === 'string' && testFiles.length > 0) {
        candidateWarnings.push('Coerced test_files from string to array')
      }
      const dedupedTestFiles = [...new Set(testFiles)]

      const rawModifiedFiles = getValueByAliases(parsed, [
        'modified_files',
        'modifiedfiles',
        'modified_file',
        'modifiedfile',
        'changed_files',
        'changedfiles',
      ])
      const modifiedFiles = toStringArray(rawModifiedFiles).filter((f) => f.length > 0)
      if (typeof rawModifiedFiles === 'string' && modifiedFiles.length > 0) {
        candidateWarnings.push('Coerced modified_files from string to array')
      }
      const dedupedModifiedFiles = [...new Set(
        (modifiedFiles.length > 0 ? modifiedFiles : dedupedTestFiles),
      )]

      const rawFileEffects = getValueByAliases(parsed, [
        'file_effects',
        'fileeffects',
        'file_effect',
        'fileeffect',
        'effects',
      ])
      const explicitFileEffects = normalizeFinalTestFileEffects(rawFileEffects, candidateWarnings)
      const fileEffects = explicitFileEffects.length > 0
        ? explicitFileEffects
        : dedupedModifiedFiles.map((path) => ({ path, intent: 'candidate' as const }))

      const rawTestsCount = getValueByAliases(parsed, ['tests_count', 'testscount', 'test_count', 'testcount', 'num_tests'])
      const testsCount = toInteger(rawTestsCount)

      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate, { tag: 'FINAL_TEST_COMMANDS' })

      return {
        ok: true,
        value: {
          commands,
          summary,
          testFiles: dedupedTestFiles,
          modifiedFiles: dedupedModifiedFiles,
          fileEffects,
          testsCount,
        },
        normalizedContent: JSON.stringify({
          commands,
          ...(summary ? { summary } : {}),
          ...(dedupedTestFiles.length > 0 ? { testFiles: dedupedTestFiles } : {}),
          ...(dedupedModifiedFiles.length > 0 ? { modifiedFiles: dedupedModifiedFiles } : {}),
          ...(fileEffects.length > 0 ? { fileEffects } : {}),
          ...(testsCount != null ? { testsCount } : {}),
        }),
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate, { tag: 'FINAL_TEST_COMMANDS' }),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Final test command output echoed the prompt instead of returning a <FINAL_TEST_COMMANDS> artifact'
      : lastError,
    { cause: lastErrorCause },
  )
}

function normalizeExecutionSetupStatus(value: unknown): ExecutionSetupStatus {
  const raw = getRequiredString({ status: value }, ['status'], 'status')
  const normalized = normalizeKey(raw)
  if (['ready', 'ok', 'complete', 'completed', 'success', 'succeeded'].includes(normalized)) {
    return 'ready'
  }
  if (['blocked', 'failed', 'fail', 'failure', 'error'].includes(normalized)) {
    return 'blocked'
  }
  throw new Error(`Invalid execution setup status: ${raw}`)
}

function normalizeExecutionSetupPath(value: unknown, fieldLabel: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldLabel} must be a non-empty string`)
  }
  const path = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  return path
}

function normalizeExecutionSetupPlanReadinessStatus(value: unknown): 'ready' | 'partial' | 'missing' {
  const raw = getRequiredString({ status: value }, ['status'], 'readiness.status')
  const normalized = normalizeKey(raw)
  if (['ready', 'complete', 'completed', 'ok'].includes(normalized)) {
    return 'ready'
  }
  if (['partial', 'needssetup', 'incomplete'].includes(normalized)) {
    return 'partial'
  }
  if (['missing', 'notready', 'uninitialized'].includes(normalized)) {
    return 'missing'
  }
  throw new Error(`Invalid execution setup readiness status: ${raw}`)
}

function normalizeExecutionSetupCommand(
  value: unknown,
  fieldLabel: string,
  repairWarnings?: string[],
) {
  const normalized = normalizeCommandSpec(value, detectHostContext())
  if (normalized.warning) repairWarnings?.push(`${fieldLabel}: ${normalized.warning}`)
  return normalized.command
}

function normalizeExecutionSetupCommands(
  value: unknown,
  fieldLabel: string,
  repairWarnings?: string[],
) {
  if (value === undefined || value === null) return []
  const entries = Array.isArray(value) ? value : [value]
  return entries.map((entry, index) =>
    normalizeExecutionSetupCommand(entry, `${fieldLabel}[${index}]`, repairWarnings),
  )
}

function normalizeExecutionSetupProjectCommands(
  value: unknown,
  fieldLabel: string,
  repairWarnings?: string[],
): ExecutionSetupPlanPayload['projectCommands'] {
  if (!isRecord(value)) throw new Error(`${fieldLabel} missing object`)
  return {
    prepare: normalizeExecutionSetupCommands(getValueByAliases(value, ['prepare', 'bootstrap', 'setup']), `${fieldLabel}.prepare`, repairWarnings),
    testFull: normalizeExecutionSetupCommands(getValueByAliases(value, ['testfull', 'tests']), `${fieldLabel}.test_full`, repairWarnings),
    lintFull: normalizeExecutionSetupCommands(getValueByAliases(value, ['lintfull', 'lint']), `${fieldLabel}.lint_full`, repairWarnings),
    typecheckFull: normalizeExecutionSetupCommands(getValueByAliases(value, ['typecheckfull', 'typecheck']), `${fieldLabel}.typecheck_full`, repairWarnings),
  }
}

function normalizeExecutionSetupCommandProbes(
  value: unknown,
  label: string,
  repairWarnings?: string[],
): ExecutionSetupCommandProbePayload[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}[${index}] must be an object`)
    return {
      id: getRequiredString(entry, ['id'], `${label}[${index}].id`),
      command: normalizeExecutionSetupCommand(
        getValueByAliases(entry, ['command']),
        `${label}[${index}].command`,
        repairWarnings,
      ),
      purpose: getRequiredString(entry, ['purpose'], `${label}[${index}].purpose`),
    }
  })
}

function normalizeExecutionSetupWorkspaceInputs(value: unknown): ExecutionSetupPlanPayload['workspaceInputs'] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error('workspace_inputs must be a list')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`workspace_inputs[${index}] must be an object`)
    const kind = getRequiredString(entry, ['kind', 'type'], `workspace_inputs[${index}].kind`)
    if (kind !== 'file' && kind !== 'directory') {
      throw new Error(`workspace_inputs[${index}].kind must be file or directory`)
    }
    const sourceStatus = getRequiredString(
      entry,
      ['sourcestatus', 'status'],
      `workspace_inputs[${index}].source_status`,
    )
    if (sourceStatus !== 'ignored' && sourceStatus !== 'untracked') {
      throw new Error(`workspace_inputs[${index}].source_status must be ignored or untracked`)
    }
    const category = getRequiredString(
      entry,
      ['category'],
      `workspace_inputs[${index}].category`,
    )
    if (!isExecutionSetupWorkspaceInputCategory(category)) {
      throw new Error(
        `workspace_inputs[${index}].category must be ${EXECUTION_SETUP_WORKSPACE_INPUT_CATEGORIES.slice(0, -1).join(', ')}, or ${EXECUTION_SETUP_WORKSPACE_INPUT_CATEGORIES.at(-1)}`,
      )
    }
    const allowLargeCopy = getValueByAliases(entry, ['allowlargecopy'])
    return {
      path: normalizeExecutionSetupPath(
        getValueByAliases(entry, ['path']),
        `workspace_inputs[${index}].path`,
      ),
      kind,
      sourceStatus,
      category,
      ...(typeof allowLargeCopy === 'boolean' ? { allowLargeCopy } : {}),
      reason: getRequiredString(entry, ['reason', 'rationale'], `workspace_inputs[${index}].reason`),
    }
  })
}

function normalizeExecutionSetupGitHooks(
  value: unknown,
  repairWarnings?: string[],
  preserveBackendFields = false,
): ExecutionSetupGitHooksPayload {
  if (value === undefined || value === null) {
    return { policy: DEFAULT_GIT_HOOK_POLICY, detected: [], validationCommands: [] }
  }
  if (!isRecord(value)) throw new Error('git_hooks must be an object')
  const rawDetected = getValueByAliases(value, ['detected', 'detectedhooks'])
  if (rawDetected !== undefined && rawDetected !== null && !preserveBackendFields) {
    repairWarnings?.push('Ignored model-supplied git_hooks.detected; LoopTroop discovers hook evidence from the current workspace.')
  }
  if (getValueByAliases(value, ['policy']) !== undefined && !preserveBackendFields) {
    repairWarnings?.push('Ignored model-supplied git_hooks.policy; LoopTroop applies the configured policy.')
  }
  const policyValue = getValueByAliases(value, ['policy'])
  const policy = preserveBackendFields && isGitHookPolicy(policyValue)
    ? policyValue
    : DEFAULT_GIT_HOOK_POLICY
  const detected = preserveBackendFields && Array.isArray(rawDetected)
    ? rawDetected.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`git_hooks.detected[${index}] must be an object`)
        const kind = getRequiredString(entry, ['kind'], `git_hooks.detected[${index}].kind`)
        const runnable = getRequiredString(entry, ['runnable'], `git_hooks.detected[${index}].runnable`)
        if (kind !== 'hook' && kind !== 'manager_config') {
          throw new Error(`git_hooks.detected[${index}].kind must be hook or manager_config`)
        }
        if (!['yes', 'no', 'unknown'].includes(runnable)) {
          throw new Error(`git_hooks.detected[${index}].runnable must be yes, no, or unknown`)
        }
        const managerHint = toOptionalString(getValueByAliases(entry, ['managerhint']))
        return {
          name: getRequiredString(entry, ['name'], `git_hooks.detected[${index}].name`),
          path: normalizeExecutionSetupPath(getValueByAliases(entry, ['path']), `git_hooks.detected[${index}].path`),
          source: getRequiredString(entry, ['source'], `git_hooks.detected[${index}].source`),
          kind: kind as 'hook' | 'manager_config',
          runnable: runnable as 'yes' | 'no' | 'unknown',
          ...(managerHint ? { managerHint } : {}),
        }
      })
    : []
  const rawCommands = getValueByAliases(value, ['validationcommands', 'commands'])
  const validationCommands = rawCommands === undefined || rawCommands === null
    ? []
    : Array.isArray(rawCommands)
      ? rawCommands.map((entry, index) => {
          if (!isRecord(entry)) throw new Error(`git_hooks.validation_commands[${index}] must be an object`)
          return {
            id: getRequiredString(entry, ['id'], `git_hooks.validation_commands[${index}].id`),
            hook: getRequiredString(entry, ['hook'], `git_hooks.validation_commands[${index}].hook`),
            command: normalizeExecutionSetupCommand(
              getValueByAliases(entry, ['command']),
              `git_hooks.validation_commands[${index}].command`,
              repairWarnings,
            ),
            purpose: getRequiredString(entry, ['purpose'], `git_hooks.validation_commands[${index}].purpose`),
          }
        })
      : (() => { throw new Error('git_hooks.validation_commands must be a list') })()
  return {
    policy,
    detected,
    validationCommands,
  }
}

function normalizeExecutionSetupPlanReadiness(
  value: unknown,
  defaults: { status: 'ready' | 'partial' | 'missing'; actionsRequired: boolean },
): ExecutionSetupPlanPayload['readiness'] {
  if (!isRecord(value)) {
    return {
      status: defaults.status,
      actionsRequired: defaults.actionsRequired,
      evidence: [],
      gaps: [],
    }
  }

  const rawStatus = getValueByAliases(value, ['status'])
  const status = rawStatus === undefined
    ? defaults.status
    : normalizeExecutionSetupPlanReadinessStatus(rawStatus)
  const actionsRequiredRaw = getValueByAliases(value, ['actionsrequired', 'actions_required'])
  const actionsRequired = typeof actionsRequiredRaw === 'boolean'
    ? actionsRequiredRaw
    : status !== 'ready'

  return {
    status,
    actionsRequired,
    evidence: toStringArray(getValueByAliases(value, ['evidence', 'signals', 'findings'])),
    gaps: toStringArray(getValueByAliases(value, ['gaps', 'missing', 'missingwork'])),
  }
}

/**
 * `Boolean(value)` made every non-empty string true, and serialisers quote
 * scalars often enough that `required: "false"` turned an optional setup command
 * into a mandatory one. Anything the boolean parser cannot read is a validation
 * error rather than a guess.
 */
function normalizeExecutionSetupPlanStepRequired(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false
  const parsed = toBoolean(value)
  if (parsed === null) {
    throw new Error(`${label} must be a boolean, received ${JSON.stringify(value)}`)
  }
  return parsed
}

function normalizeExecutionSetupPlanStep(
  entry: Record<string, unknown>,
  index: number,
  repairWarnings?: string[],
): ExecutionSetupPlanPayload['steps'][number] {
  const explicitId = toOptionalString(getValueByAliases(entry, ['id']))
  const derivedOrdinal = index + 1
  const id = explicitId ?? `setup-step-${derivedOrdinal}`
  if (!explicitId) {
    repairWarnings?.push(`Filled missing execution setup plan step id at index ${index} from list position.`)
  }

  const purpose = getRequiredString(entry, ['purpose', 'goal'], `steps[${index}].purpose`)
  const explicitTitle = toOptionalString(getValueByAliases(entry, ['title', 'name']))
  const title = explicitTitle ?? purpose
  if (!explicitTitle) {
    repairWarnings?.push(`Filled missing execution setup plan step title at index ${index} from existing purpose text.`)
  }

  const explicitRationale = toOptionalString(getValueByAliases(entry, ['rationale', 'reason']))
  const rationale = explicitRationale ?? purpose
  if (!explicitRationale) {
    repairWarnings?.push(`Filled missing execution setup plan step rationale at index ${index} from existing purpose text.`)
  }

  return {
    id,
    title,
    purpose,
    commands: normalizeExecutionSetupCommands(
      getValueByAliases(entry, ['commands', 'command']),
      `steps[${index}].commands`,
      repairWarnings,
    ),
    required: normalizeExecutionSetupPlanStepRequired(
      getValueByAliases(entry, ['required', 'isrequired']),
      `steps[${index}].required`,
    ),
    rationale,
    cautions: toStringArray(getValueByAliases(entry, ['cautions', 'warnings', 'notes'])),
  }
}

function normalizeExecutionSetupPlan(
  value: unknown,
  repairWarnings?: string[],
  preserveBackendFields = false,
  authoritativeTicketId?: string,
): ExecutionSetupPlanPayload {
  if (!isRecord(value)) throw new Error('Execution setup plan is missing')

  for (const [aliases, label] of [
    [['schemaversion', 'version'], 'schema_version'],
    [['ticketid'], 'ticket_id'],
    [['artifact'], 'artifact'],
    [['status'], 'status'],
    [['hostcontext'], 'host_context'],
    [['temproots', 'temproot'], 'temp_roots'],
    [['qualitygatepolicy', 'qualitypolicy'], 'quality_gate_policy'],
  ] as const) {
    if (!preserveBackendFields && getValueByAliases(value, [...aliases]) !== undefined) {
      repairWarnings?.push(`Ignored model-supplied ${label}; LoopTroop owns this setup-plan field.`)
    }
  }
  const summary = getRequiredString(value, ['summary', 'reason'], 'summary')

  const workspaceInputs = normalizeExecutionSetupWorkspaceInputs(
    getValueByAliases(value, ['workspaceinputs']),
  )
  const rawSteps = getValueByAliases(value, ['steps', 'plansteps'])
  const steps = Array.isArray(rawSteps) ? rawSteps.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`steps[${index}] must be an object`)
    return normalizeExecutionSetupPlanStep(entry, index, repairWarnings)
  }) : []

  const proposedReadiness = normalizeExecutionSetupPlanReadiness(
    getValueByAliases(value, ['readiness', 'environmentreadiness', 'environment_readiness']),
    {
      status: steps.length > 0 || workspaceInputs.length > 0 ? 'partial' : 'ready',
      actionsRequired: steps.length > 0 || workspaceInputs.length > 0,
    },
  )

  const actionsRequired = steps.length > 0 || workspaceInputs.length > 0
  const readiness = {
    status: actionsRequired ? ('partial' as const) : ('ready' as const),
    actionsRequired,
    evidence: proposedReadiness.evidence,
    gaps: actionsRequired ? proposedReadiness.gaps : [],
  }

  const projectCommands = normalizeExecutionSetupProjectCommands(
    getValueByAliases(value, ['projectcommands', 'commands']),
    'Execution setup plan project_commands',
    repairWarnings,
  )
  const rawQualityPolicy = getValueByAliases(value, ['qualitygatepolicy', 'qualitypolicy'])
  const qualityGatePolicy = preserveBackendFields && isRecord(rawQualityPolicy)
    ? {
        tests: getRequiredString(rawQualityPolicy, ['tests'], 'quality_gate_policy.tests'),
        lint: getRequiredString(rawQualityPolicy, ['lint'], 'quality_gate_policy.lint'),
        typecheck: getRequiredString(rawQualityPolicy, ['typecheck'], 'quality_gate_policy.typecheck'),
        fullProjectFallback: getRequiredString(rawQualityPolicy, ['fullprojectfallback'], 'quality_gate_policy.full_project_fallback'),
      }
    : {
    tests: 'bead-test-commands-first',
    lint: 'impacted-or-package',
    typecheck: 'impacted-or-package',
    fullProjectFallback: 'never-block-on-unrelated-baseline',
      }
  const cautions = toStringArray(getValueByAliases(value, ['cautions', 'warnings', 'notes']))
  const workspaceProbes = normalizeExecutionSetupCommandProbes(
    getValueByAliases(value, ['workspaceprobes']),
    'workspace_probes',
    repairWarnings,
  )
  const gitHooks = normalizeExecutionSetupGitHooks(
    getValueByAliases(value, ['githooks']),
    repairWarnings,
    preserveBackendFields,
  )
  const rawHostContext = getValueByAliases(value, ['hostcontext'])
  const parsedHostContext = hostContextSchema.safeParse(rawHostContext)
  const hostContext = preserveBackendFields && parsedHostContext.success
    ? parsedHostContext.data
    : detectHostContext()
  const schemaVersion = preserveBackendFields
    ? toInteger(getValueByAliases(value, ['schemaversion'])) ?? 1
    : 1
  const storedTicketId = toOptionalString(getValueByAliases(value, ['ticketid']))
  const ticketId = preserveBackendFields
    ? (storedTicketId || authoritativeTicketId || getRequiredString(value, ['ticketid'], 'ticket_id'))
    : ''
  const tempRoots = preserveBackendFields
    ? toStringArray(getValueByAliases(value, ['temproots'])).map((entry) => normalizeExecutionSetupPath(entry, 'temp_roots entry'))
    : ['.ticket/runtime/execution-setup', '.ticket/runtime/execution-setup/tool-cache']

  return {
    schemaVersion,
    ticketId,
    artifact: 'execution_setup_plan',
    status: 'draft',
    hostContext,
    summary,
    readiness,
    tempRoots,
    workspaceInputs,
    workspaceProbes,
    gitHooks,
    steps,
    projectCommands,
    qualityGatePolicy,
    cautions,
  }
}

function normalizeExecutionSetupToolRequirementStatus(value: unknown, label: string): ExecutionSetupToolRequirementStatus {
  const raw = getRequiredString({ status: value }, ['status'], label)
  const normalized = normalizeKey(raw)
  if (normalized === 'available') return 'available'
  if (['provisioned', 'prepared'].includes(normalized)) return 'provisioned'
  if (['failed', 'fail', 'error'].includes(normalized)) return 'failed'
  if (['notprovisionable', 'notpossible', 'nosafepath', 'unsupported'].includes(normalized)) {
    return 'not_provisionable'
  }
  throw new Error(`Invalid execution setup tool requirement status: ${raw}`)
}

function normalizeExecutionSetupProvisioningAttempts(
  value: unknown,
  label: string,
  repairWarnings?: string[],
): ExecutionSetupProvisioningAttemptPayload[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`)
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}[${index}] must be an object`)
    return {
      strategy: getRequiredString(entry, ['strategy', 'name', 'approach'], `${label}[${index}].strategy`),
      commands: normalizeExecutionSetupCommands(
        getValueByAliases(entry, ['commands', 'provisioningcommands', 'attemptedcommands']),
        `${label}[${index}].commands`,
        repairWarnings,
      ),
      result: getRequiredString(entry, ['result', 'status', 'outcome'], `${label}[${index}].result`),
      reason: toOptionalString(getValueByAliases(entry, ['reason', 'failure_reason', 'summary'])) ?? '',
    }
  })
}

function normalizeExecutionSetupToolRequirements(
  value: unknown,
  repairWarnings?: string[],
): ExecutionSetupProfilePayload['toolRequirements'] {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value)) throw new Error('Execution setup profile tool_requirements must be a list')
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`tool_requirements[${index}] must be an object`)
    return {
      launcher: getRequiredString(entry, ['launcher', 'command', 'tool'], `tool_requirements[${index}].launcher`),
      requiredBy: toStringArray(getValueByAliases(entry, ['requiredby', 'requiredfor', 'requiredcommands'])),
      status: normalizeExecutionSetupToolRequirementStatus(
        getValueByAliases(entry, ['status']),
        `tool_requirements[${index}].status`,
      ),
      missingProbe: toOptionalString(getValueByAliases(entry, ['missingprobe', 'probe', 'discoveryprobe'])) ?? '',
      provisioningAttempts: normalizeExecutionSetupProvisioningAttempts(
        getValueByAliases(entry, [
          'provisioningattempts',
          'provisionattempts',
          'attempts',
        ]),
        `tool_requirements[${index}].provisioning_attempts`,
        repairWarnings,
      ),
      finalProbe: toOptionalString(getValueByAliases(entry, ['finalprobe', 'verificationprobe', 'probecommand'])) ?? '',
      failureReason: toOptionalString(getValueByAliases(entry, ['failurereason', 'reason', 'blocker'])) ?? '',
    }
  })
}

function normalizeExecutionSetupProfile(value: unknown, repairWarnings?: string[]): ExecutionSetupProfilePayload {
  if (!isRecord(value)) throw new Error('Execution setup profile is missing')

  const status = normalizeExecutionSetupStatus(getValueByAliases(value, ['status']))
  const summary = getRequiredString(value, ['summary', 'reason'], 'summary')

  const tempRoots = toStringArray(getValueByAliases(value, ['temproots', 'temproot']))
    .map((entry) => normalizeExecutionSetupPath(entry, 'temp_roots entry'))

  const bootstrapCommands = normalizeExecutionSetupCommands(
    getValueByAliases(value, ['bootstrapcommands', 'bootstrap']),
    'bootstrap_commands',
    repairWarnings,
  )
  const toolingProbeCommands = normalizeExecutionSetupCommands(getValueByAliases(value, [
    'toolingprobecommands',
    'toolingprobes',
    'probecommands',
    'verificationcommands',
  ]), 'tooling_probe_commands', repairWarnings)
  const workspaceInputs: ExecutionSetupPlanPayload['workspaceInputs'] = []
  const workspaceProbes: ExecutionSetupCommandProbePayload[] = []
  const gitHooks: ExecutionSetupGitHooksPayload = {
    policy: DEFAULT_GIT_HOOK_POLICY,
    detected: [],
    validationCommands: [],
  }
  const runtimeEnvironmentValue = getValueByAliases(value, ['runtimeenvironment', 'environment'])
  const runtimeEnvironment = runtimeEnvironmentValue == null
    ? runtimeEnvironmentSchema.parse({})
    : runtimeEnvironmentSchema.parse(runtimeEnvironmentValue)
  const toolRequirements = normalizeExecutionSetupToolRequirements(getValueByAliases(value, [
    'toolrequirements',
    'toolrequirement',
    'toolingrequirements',
    'requiredtools',
  ]), repairWarnings)

  const rawReusableArtifacts = getValueByAliases(value, ['reusableartifacts', 'artifacts'])
  const reusableArtifacts = Array.isArray(rawReusableArtifacts)
    ? rawReusableArtifacts.map((entry, index) => {
        if (!isRecord(entry)) throw new Error(`reusable_artifacts[${index}] must be an object`)
        return {
          path: normalizeExecutionSetupPath(getValueByAliases(entry, ['path']), `reusable_artifacts[${index}].path`),
          kind: getRequiredString(entry, ['kind', 'type'], `reusable_artifacts[${index}].kind`),
          purpose: getRequiredString(entry, ['purpose', 'reason', 'summary'], `reusable_artifacts[${index}].purpose`),
        }
      })
    : []

  const projectCommands = normalizeExecutionSetupProjectCommands(
    getValueByAliases(value, ['projectcommands', 'commands']),
    'Execution setup profile project_commands',
    repairWarnings,
  )
  const qualityGatePolicy = {
    tests: 'bead-test-commands-first',
    lint: 'impacted-or-package',
    typecheck: 'impacted-or-package',
    fullProjectFallback: 'never-block-on-unrelated-baseline',
  }

  const cautions = toStringArray(getValueByAliases(value, ['cautions', 'warnings', 'notes']))

  return {
    schemaVersion: 1,
    ticketId: '',
    artifact: 'execution_setup_profile',
    status,
    hostContext: detectHostContext(),
    summary,
    tempRoots: [...new Set(tempRoots)],
    workspaceInputs,
    runtimeEnvironment,
    bootstrapCommands,
    toolingProbeCommands,
    workspaceProbes,
    gitHooks,
    ...(toolRequirements ? { toolRequirements } : {}),
    reusableArtifacts,
    projectCommands,
    qualityGatePolicy,
    cautions,
  }
}

function normalizeExecutionSetupChecks(value: unknown): ExecutionSetupResultPayload['checks'] {
  if (!isRecord(value)) throw new Error('Execution setup result missing checks object')
  const workspace = getValueByAliases(value, ['workspace'])
  const tooling = getValueByAliases(value, ['tooling'])
  const tempScope = getValueByAliases(value, ['tempscope'])
  const policy = getValueByAliases(value, ['policy'])
  if (workspace === undefined) throw new Error('Execution setup checks missing workspace')
  if (tooling === undefined) throw new Error('Execution setup checks missing tooling')
  if (tempScope === undefined) throw new Error('Execution setup checks missing temp_scope')
  if (policy === undefined) throw new Error('Execution setup checks missing policy')
  return {
    workspace: normalizeCompletionCheckValue(workspace),
    tooling: normalizeCompletionCheckValue(tooling),
    tempScope: normalizeCompletionCheckValue(tempScope),
    policy: normalizeCompletionCheckValue(policy),
  }
}

function toCanonicalExecutionSetupPlanPayload(value: ExecutionSetupPlanPayload): Record<string, unknown> {
  return {
    schema_version: value.schemaVersion,
    ticket_id: value.ticketId,
    artifact: value.artifact,
    status: value.status,
    host_context: value.hostContext,
    summary: value.summary,
    readiness: {
      status: value.readiness.status,
      actions_required: value.readiness.actionsRequired,
      evidence: value.readiness.evidence,
      gaps: value.readiness.gaps,
    },
    temp_roots: value.tempRoots,
    workspace_inputs: value.workspaceInputs.map((input) => ({
      path: input.path,
      kind: input.kind,
      source_status: input.sourceStatus,
      category: input.category,
      ...(input.allowLargeCopy === undefined ? {} : { allow_large_copy: input.allowLargeCopy }),
      ...(input.fileCount === undefined ? {} : { file_count: input.fileCount }),
      ...(input.totalBytes === undefined ? {} : { total_bytes: input.totalBytes }),
      reason: input.reason,
    })),
    workspace_probes: value.workspaceProbes,
    git_hooks: {
      policy: value.gitHooks.policy,
      detected: value.gitHooks.detected.map((hook) => ({
        name: hook.name,
        path: hook.path,
        source: hook.source,
        kind: hook.kind,
        runnable: hook.runnable,
        ...(hook.managerHint ? { manager_hint: hook.managerHint } : {}),
      })),
      validation_commands: value.gitHooks.validationCommands,
    },
    steps: value.steps.map((step) => ({
      id: step.id,
      title: step.title,
      purpose: step.purpose,
      commands: step.commands,
      required: step.required,
      rationale: step.rationale,
      cautions: step.cautions,
    })),
    project_commands: {
      prepare: value.projectCommands.prepare,
      test_full: value.projectCommands.testFull,
      lint_full: value.projectCommands.lintFull,
      typecheck_full: value.projectCommands.typecheckFull,
    },
    quality_gate_policy: {
      tests: value.qualityGatePolicy.tests,
      lint: value.qualityGatePolicy.lint,
      typecheck: value.qualityGatePolicy.typecheck,
      full_project_fallback: value.qualityGatePolicy.fullProjectFallback,
    },
    cautions: value.cautions,
  }
}

function toCanonicalExecutionSetupResultPayload(value: ExecutionSetupResultPayload): Record<string, unknown> {
  return {
    status: value.status,
    summary: value.summary,
    profile: {
      schema_version: value.profile.schemaVersion,
      ticket_id: value.profile.ticketId,
      artifact: value.profile.artifact,
      status: value.profile.status,
      host_context: value.profile.hostContext,
      summary: value.profile.summary,
      temp_roots: value.profile.tempRoots,
      workspace_inputs: value.profile.workspaceInputs.map((input) => ({
        path: input.path,
        kind: input.kind,
        source_status: input.sourceStatus,
        category: input.category,
        ...(input.allowLargeCopy === undefined ? {} : { allow_large_copy: input.allowLargeCopy }),
        ...(input.fileCount === undefined ? {} : { file_count: input.fileCount }),
        ...(input.totalBytes === undefined ? {} : { total_bytes: input.totalBytes }),
        reason: input.reason,
      })),
      runtime_environment: value.profile.runtimeEnvironment,
      bootstrap_commands: value.profile.bootstrapCommands,
      tooling_probe_commands: value.profile.toolingProbeCommands,
      workspace_probes: value.profile.workspaceProbes,
      ...(value.profile.workspaceProbeReceipts ? { workspace_probe_receipts: value.profile.workspaceProbeReceipts } : {}),
      git_hooks: {
        policy: value.profile.gitHooks.policy,
        detected: value.profile.gitHooks.detected.map((hook) => ({
          name: hook.name,
          path: hook.path,
          source: hook.source,
          kind: hook.kind,
          runnable: hook.runnable,
          ...(hook.managerHint ? { manager_hint: hook.managerHint } : {}),
        })),
        validation_commands: value.profile.gitHooks.validationCommands,
        ...(value.profile.gitHooks.validationReceipts ? { validation_receipts: value.profile.gitHooks.validationReceipts } : {}),
      },
      ...(value.profile.toolRequirements
        ? {
            tool_requirements: value.profile.toolRequirements.map((requirement) => ({
              launcher: requirement.launcher,
              required_by: requirement.requiredBy,
              status: requirement.status,
              missing_probe: requirement.missingProbe,
              provisioning_attempts: requirement.provisioningAttempts.map((attempt) => ({
                strategy: attempt.strategy,
                commands: attempt.commands,
                result: attempt.result,
                reason: attempt.reason,
              })),
              final_probe: requirement.finalProbe,
              failure_reason: requirement.failureReason,
            })),
          }
        : {}),
      reusable_artifacts: value.profile.reusableArtifacts.map((artifact) => ({
        path: artifact.path,
        kind: artifact.kind,
        purpose: artifact.purpose,
      })),
      project_commands: {
        prepare: value.profile.projectCommands.prepare,
        test_full: value.profile.projectCommands.testFull,
        lint_full: value.profile.projectCommands.lintFull,
        typecheck_full: value.profile.projectCommands.typecheckFull,
      },
      quality_gate_policy: {
        tests: value.profile.qualityGatePolicy.tests,
        lint: value.profile.qualityGatePolicy.lint,
        typecheck: value.profile.qualityGatePolicy.typecheck,
        full_project_fallback: value.profile.qualityGatePolicy.fullProjectFallback,
      },
      cautions: value.profile.cautions,
    },
    checks: {
      workspace: value.checks.workspace,
      tooling: value.checks.tooling,
      temp_scope: value.checks.tempScope,
      policy: value.checks.policy,
    },
  }
}

export function normalizeExecutionSetupPlanOutput(
  rawContent: string,
  options: {
    preserveBackendFields?: boolean
    authoritativeTicketId?: string
  } = {},
): StructuredOutputResult<ExecutionSetupPlanPayload> {
  const candidates = collectTaggedCandidates(rawContent, 'EXECUTION_SETUP_PLAN')
  let lastError = 'No execution setup plan marker found'
  let lastErrorCause: unknown = null

  if (candidates.length === 0) {
    return buildStructuredOutputFailure(
      rawContent,
      looksLikePromptEcho(rawContent)
        ? 'Execution setup plan output echoed the prompt instead of returning an <EXECUTION_SETUP_PLAN> artifact'
        : lastError,
    )
  }

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    let parsedCandidate: unknown
    try {
      parsedCandidate = parseYamlOrJsonCandidate(candidate, {
        repairWarnings: candidateWarnings,
      })

      const parsed = maybeUnwrapRecord(parsedCandidate, [
        'executionsetupplan',
        'execution_setup_plan',
        'plan',
        'data',
        'result',
      ])
      if (!isRecord(parsed)) {
        throw new Error('Execution setup plan payload is not a YAML/JSON object')
      }
      if (parsed !== parsedCandidate && isRecord(parsedCandidate)) {
        appendWrapperKeyRepairWarning(candidateWarnings, findMaybeUnwrappedWrapperPath(parsedCandidate, [
          'executionsetupplan',
          'execution_setup_plan',
          'plan',
          'data',
          'result',
        ]))
      }

      const value = normalizeExecutionSetupPlan(
        parsed,
        candidateWarnings,
        options.preserveBackendFields ?? false,
        options.authoritativeTicketId,
      )
      return {
        ok: true,
        value,
        normalizedContent: JSON.stringify(toCanonicalExecutionSetupPlanPayload(value)),
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate, { tag: 'EXECUTION_SETUP_PLAN' }),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Execution setup plan output echoed the prompt instead of returning an <EXECUTION_SETUP_PLAN> artifact'
      : lastError,
    { cause: lastErrorCause },
  )
}

export function normalizeExecutionSetupResultOutput(rawContent: string): StructuredOutputResult<ExecutionSetupResultPayload> {
  const candidates = collectTaggedCandidates(rawContent, 'EXECUTION_SETUP_RESULT')
  let lastError = 'No execution setup result marker found'
  let lastErrorCause: unknown = null

  if (candidates.length === 0) {
    return buildStructuredOutputFailure(
      rawContent,
      looksLikePromptEcho(rawContent)
        ? 'Execution setup output echoed the prompt instead of returning an <EXECUTION_SETUP_RESULT> artifact'
        : lastError,
    )
  }

  for (const candidate of candidates) {
    const candidateWarnings: string[] = []
    try {
      const parsedCandidate = parseYamlOrJsonCandidate(candidate, { repairWarnings: candidateWarnings })
      const parsed = unwrapExplicitWrapperRecord(parsedCandidate, [
        'executionsetupresult',
        'execution_setup_result',
        'result',
        'output',
        'data',
      ])
      if (!isRecord(parsed)) throw new Error('Execution setup payload is not a YAML/JSON object')
      if (parsed !== parsedCandidate && isRecord(parsedCandidate)) {
        appendWrapperKeyRepairWarning(candidateWarnings, findExplicitWrapperPath(parsedCandidate, [
          'executionsetupresult',
          'execution_setup_result',
          'result',
          'output',
          'data',
        ]))
      }

      const status = normalizeExecutionSetupStatus(getValueByAliases(parsed, ['status']))
      const summary = getRequiredString(parsed, ['summary', 'reason'], 'summary')
      const profile = normalizeExecutionSetupProfile(getValueByAliases(parsed, ['profile']), candidateWarnings)
      const checks = normalizeExecutionSetupChecks(getValueByAliases(parsed, ['checks']))

      if (profile.status !== status) {
        throw new Error('Execution setup result status must match profile.status')
      }

      const checkValues = Object.values(checks)
      const everyCheckPassed = checkValues.every((check) => check === 'pass')
      const atLeastOneCheckFailed = checkValues.some((check) => check === 'fail')
      if (status === 'ready' && !everyCheckPassed) {
        throw new Error('Execution setup status ready requires every setup check to pass')
      }
      if (status === 'blocked' && !atLeastOneCheckFailed) {
        throw new Error('Execution setup status blocked requires at least one setup check to fail')
      }

      appendStructuredCandidateRecoveryWarning(candidateWarnings, rawContent, candidate, { tag: 'EXECUTION_SETUP_RESULT' })

      const value = {
        status,
        summary,
        profile,
        checks,
      }

      return {
        ok: true,
        value,
        normalizedContent: JSON.stringify(toCanonicalExecutionSetupResultPayload(value)),
        repairApplied: candidateWarnings.length > 0 || shouldRecordStructuredCandidateRecovery(rawContent, candidate, { tag: 'EXECUTION_SETUP_RESULT' }),
        repairWarnings: candidateWarnings,
      }
    } catch (error) {
      lastError = getErrorMessage(error)
      lastErrorCause = error
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Execution setup output echoed the prompt instead of returning an <EXECUTION_SETUP_RESULT> artifact'
      : lastError,
    { cause: lastErrorCause },
  )
}
