import type { TicketContext, TicketEvent } from '../../machines/types'
import type { TicketState } from '../../opencode/contextBuilder'
import { buildMinimalContext } from '../../opencode/contextBuilder'
import { SessionManager } from '../../opencode/sessionManager'
import { getPendingSessionContinuationForTicketPhase } from '../../opencode/sessionContinuation'
import { buildSameSessionPromptFromTemplate, PROM_EXECUTION_SETUP_NOTE } from '../../prompts/index'
import { withCommandLoggingAsync } from '../../log/commandLogger'
import { getLatestPhaseArtifact, getTicketPaths, upsertLatestPhaseArtifact } from '../../storage/tickets'
import { throwIfAborted } from '../../council/types'
import {
  runOpenCodeSessionPrompt,
  type OpenCodePromptCompletedEvent,
  type OpenCodePromptDispatchEvent,
} from '../runOpenCodePrompt'
import { persistUiArtifactCompanionArtifact } from '../artifactCompanions'
import { adapter } from './state'
import {
  emitAiMilestone,
  emitOpenCodePromptLog,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  emitPhaseLog,
  createOpenCodeStreamState,
  resolveExecutionSetupRuntimeSettings,
  resolveStructuredRetryRuntimeSettings,
} from './helpers'
import type { OpenCodeStreamState } from './types'
import { handleMockExecutionUnsupported } from './executionPhase'
import { recordWorktreeStartCommit, resetWorktreeToCommit, WORKTREE_RESET_PRESERVE_PATHS } from '../../phases/execution/gitOps'
import { executeExecutionSetupWithRetries } from '../../phases/executionSetup/executor'
import { readExecutionSetupPlan } from '../../phases/executionSetupPlan/document'
import { flattenExecutionSetupPlanCommands } from '../../phases/executionSetupPlan/types'
import {
  clearExecutionSetupRuntimeArtifacts,
  describeExecutionSetupPaths,
  writeExecutionSetupProfileMirror,
} from '../../phases/executionSetup/storage'
import {
  getExecutionSetupCommandWrapper,
  hasExecutionSetupProjectCommands,
  repairExecutionSetupCommandWrapper,
} from '../../phases/executionSetup/runtimeProfile'
import {
  EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
  EXECUTION_SETUP_REPORT_ARTIFACT_TYPE,
  EXECUTION_SETUP_RETRY_NOTES_ARTIFACT_TYPE,
  parseExecutionSetupRetryNotes,
  serializeExecutionSetupProfile,
  serializeExecutionSetupRetryNotes,
  type ExecutionSetupGenerationResult,
  type ExecutionSetupProfile,
  type ExecutionSetupReport,
  type ExecutionSetupResult,
} from '../../phases/executionSetup/types'
import {
  buildGeneratedNoiseWarning,
  buildWorktreeDirtyError,
  getExecutionSetupCommitExcludedRoots,
  summarizeWorktreeChanges,
} from '../../git/worktreeChanges'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { quoteShellArg, runShellCommand } from '../../lib/shellCommand'
import { existsSync, readFileSync } from 'node:fs'
import { discoverGitHooks } from '../../git/hookDiscovery'
import type { ExecutionSetupCommandReceiptPayload } from '../../structuredOutput/types'
import { isVersionOnlyWorkspaceProbeCommand } from '../../phases/executionSetup/workspaceProbe'
import { materializeExecutionSetupWorkspaceInputs } from '../../phases/executionSetup/workspaceInputs'

const SETUP_WRAPPER_VALIDATION_TIMEOUT_MS = 10_000
const SETUP_PROBE_TIMEOUT_MS = 30_000

function readExecutionSetupAttempt(content: string | null | undefined): number {
  if (!content) return 0
  try {
    const parsed = JSON.parse(content) as { attempt?: unknown }
    return typeof parsed.attempt === 'number' && Number.isInteger(parsed.attempt) && parsed.attempt > 0
      ? parsed.attempt
      : 0
  } catch {
    return 0
  }
}

function allChecksPass(result: ExecutionSetupResult): boolean {
  return Object.values(result.checks).every((value) => value === 'pass')
}

function buildFailedSetupChecksError(result: ExecutionSetupResult): string {
  const checkLabels: Record<keyof ExecutionSetupResult['checks'], string> = {
    workspace: 'workspace',
    tooling: 'required tools',
    tempScope: 'temporary-file safety',
    policy: 'setup policy',
  }
  const failedChecks = Object.entries(result.checks)
    .filter(([, value]) => value === 'fail')
    .map(([key]) => checkLabels[key as keyof ExecutionSetupResult['checks']])
  const failedArea = failedChecks.length === 1
    ? `the ${failedChecks[0]} check failed`
    : `these required checks failed: ${failedChecks.join(', ')}`
  const explanation = result.summary.trim() || result.profile.summary.trim()
  return `Workspace setup cannot continue because ${failedArea}.${explanation ? ` ${explanation}` : ''}`
}

function buildExecutionSetupReport(input: {
  preparedBy: string
  generation: ExecutionSetupGenerationResult
  errors: string[]
  profile?: ExecutionSetupProfile | null
  approvedPlanCommands?: string[]
  worktreeWarnings?: string[]
}): ExecutionSetupReport {
  const profile = input.profile ?? input.generation.result?.profile ?? null
  const approvedPlanCommands = [...new Set(input.approvedPlanCommands ?? [])]
  const executionAddedCommands = approvedPlanCommands.length > 0 && profile
    ? profile.bootstrapCommands.filter((command) => !approvedPlanCommands.includes(command))
    : profile?.bootstrapCommands ?? []
  return {
    status: input.errors.length === 0 && input.generation.result ? 'ready' : 'failed',
    ready: input.errors.length === 0 && input.generation.result !== null,
    checkedAt: new Date().toISOString(),
    preparedBy: input.preparedBy,
    summary: input.generation.result?.summary ?? profile?.summary,
    profile,
    checks: input.generation.result?.checks ?? null,
    modelOutput: input.generation.output,
    errors: input.errors,
    ...(input.worktreeWarnings?.length ? { worktreeWarnings: input.worktreeWarnings } : {}),
    structuredOutput: input.generation.structuredOutput,
    rawAttempts: input.generation.rawAttempts,
    approvedPlanCommands,
    executionAddedCommands,
  }
}

function addProfileCautions(profile: ExecutionSetupProfile, cautions: string[]): ExecutionSetupProfile {
  if (cautions.length === 0) return profile
  return {
    ...profile,
    cautions: [...new Set([...profile.cautions, ...cautions])],
  }
}

function summarizeSetupCommandFailure(input: {
  label: string
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}): string {
  const status = input.timedOut
    ? `timed out after ${input.durationMs}ms`
    : `exit code ${input.exitCode ?? 'no exit code'}`
  const output = [input.stderr.trim(), input.stdout.trim()].filter(Boolean).join('\n').slice(0, 2000)
  return `${input.label}: ${input.command} (${status})${output ? `\n${output}` : ''}`
}

function hasDeclaredBeadTestCommands(beadsPath: string): boolean {
  if (!existsSync(beadsPath)) return false
  try {
    return readFileSync(beadsPath, 'utf8').split('\n').filter(Boolean).some((line) => {
      const bead = JSON.parse(line) as { testCommands?: unknown }
      return Array.isArray(bead.testCommands) && bead.testCommands.some((command) => typeof command === 'string' && command.trim())
    })
  } catch {
    return false
  }
}

function toCommandReceipt(id: string, command: string, result: Awaited<ReturnType<typeof runShellCommand>>): ExecutionSetupCommandReceiptPayload {
  const outputExcerpt = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n').slice(0, 2000)
  return {
    id,
    command,
    ...(result.effectiveCommand ? { effectiveCommand: result.effectiveCommand } : {}),
    setupWrapperApplied: result.setupWrapperApplied,
    status: result.timedOut ? 'timed_out' : result.exitCode === 0 ? 'passed' : 'failed',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    outputExcerpt,
  }
}

async function validateExecutionSetupRuntimeProfile(input: {
  ticketId: string
  worktreePath: string
  beadsPath: string
  profile: ExecutionSetupProfile
  signal: AbortSignal
}): Promise<{ errors: string[]; profile: ExecutionSetupProfile }> {
  const errors: string[] = []
  const workspaceProbeReceipts: ExecutionSetupCommandReceiptPayload[] = []
  const hookValidationReceipts: ExecutionSetupCommandReceiptPayload[] = []
  const wrapperPath = getExecutionSetupCommandWrapper(input.profile, input.worktreePath)
  const declaresReusableExecution = Boolean(wrapperPath) || hasExecutionSetupProjectCommands(input.profile)

  if (declaresReusableExecution && input.profile.toolingProbeCommands.length === 0) {
    errors.push(
      'Execution setup profile must include non-mutating tooling_probe_commands when it declares a command wrapper or project command families.',
    )
  }

  if (wrapperPath) {
    throwIfAborted(input.signal, input.ticketId)
    const noOpCommand = `${quoteShellArg(process.execPath)} -e ${quoteShellArg('process.exit(0)')}`
    const result = await runShellCommand({
      command: noOpCommand,
      cwd: input.worktreePath,
      timeoutMs: SETUP_WRAPPER_VALIDATION_TIMEOUT_MS,
      commandWrapper: wrapperPath,
      forceWrapper: true,
    })
    if (result.exitCode !== 0 || result.timedOut) {
      errors.push(summarizeSetupCommandFailure({
        label: `Execution setup wrapper validation failed for ${wrapperPath}`,
        command: noOpCommand,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      }))
      return { errors, profile: input.profile }
    }
  }

  for (const probeCommand of input.profile.toolingProbeCommands) {
    throwIfAborted(input.signal, input.ticketId)
    const result = await runShellCommand({
      command: probeCommand,
      cwd: input.worktreePath,
      timeoutMs: SETUP_PROBE_TIMEOUT_MS,
      ...(wrapperPath ? { commandWrapper: wrapperPath } : {}),
    })
    if (result.exitCode !== 0 || result.timedOut) {
      errors.push(summarizeSetupCommandFailure({
        label: 'Execution setup tooling probe failed',
        command: probeCommand,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      }))
    }
  }

  const requiresWorkspaceProbe = hasExecutionSetupProjectCommands(input.profile)
    || hasDeclaredBeadTestCommands(input.beadsPath)
  const functionalWorkspaceProbes = input.profile.workspaceProbes.filter(
    (probe) => !isVersionOnlyWorkspaceProbeCommand(probe.command),
  )
  if (requiresWorkspaceProbe && functionalWorkspaceProbes.length === 0) {
    errors.push('Execution setup profile must include at least one repository-level workspace_probe when project commands or bead test commands are declared; tool version probes alone are insufficient.')
  }
  for (const probe of input.profile.workspaceProbes) {
    throwIfAborted(input.signal, input.ticketId)
    const result = await runShellCommand({
      command: probe.command,
      cwd: input.worktreePath,
      timeoutMs: SETUP_PROBE_TIMEOUT_MS,
      ...(wrapperPath ? { commandWrapper: wrapperPath } : {}),
    })
    workspaceProbeReceipts.push(toCommandReceipt(probe.id, probe.command, result))
    if (result.exitCode !== 0 || result.timedOut) {
      errors.push(summarizeSetupCommandFailure({
        label: `Execution setup workspace probe failed (${probe.id})`,
        command: probe.command,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      }))
    }
  }

  if (input.profile.gitHooks.policy === 'validate_explicitly') {
    for (const validation of input.profile.gitHooks.validationCommands) {
      throwIfAborted(input.signal, input.ticketId)
      const result = await runShellCommand({
        command: validation.command,
        cwd: input.worktreePath,
        timeoutMs: SETUP_PROBE_TIMEOUT_MS,
        ...(wrapperPath ? { commandWrapper: wrapperPath } : {}),
      })
      hookValidationReceipts.push(toCommandReceipt(validation.id, validation.command, result))
      if (result.exitCode !== 0 || result.timedOut) {
        errors.push(summarizeSetupCommandFailure({
          label: `Explicit Git hook validation failed (${validation.hook})`,
          command: validation.command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timedOut: result.timedOut,
        }))
      }
    }
  }
  if (input.profile.gitHooks.policy !== 'validate_explicitly' && input.profile.gitHooks.validationCommands.length > 0) {
    hookValidationReceipts.push(...input.profile.gitHooks.validationCommands.map((validation) => ({
      id: validation.id,
      command: validation.command,
      status: 'skipped' as const,
      exitCode: null,
      durationMs: 0,
      outputExcerpt: `Explicit validation is disabled by policy ${input.profile.gitHooks.policy}.`,
    })))
  }
  if (hookValidationReceipts.length === 0) {
    hookValidationReceipts.push({
      id: 'git-hook-policy',
      command: '',
      status: 'skipped',
      exitCode: null,
      durationMs: 0,
      outputExcerpt: input.profile.gitHooks.policy === 'validate_explicitly'
        ? 'No explicit Git hook validation commands were approved.'
        : `Explicit validation is disabled by policy ${input.profile.gitHooks.policy}.`,
    })
  }

  return {
    errors,
    profile: {
      ...input.profile,
      workspaceProbeReceipts,
      gitHooks: {
        ...input.profile.gitHooks,
        validationReceipts: hookValidationReceipts,
      },
    },
  }
}

function validateExecutionSetupToolingFailureEvidence(input: {
  result: ExecutionSetupResult
  profile: ExecutionSetupProfile
}): string[] {
  if (input.result.checks.tooling !== 'fail') return []

  const requirements = input.profile.toolRequirements ?? []
  const failedProvisioningRequirements = requirements.filter((requirement) => requirement.status === 'failed')
  const countDistinctFailedStrategies = (requirement: (typeof failedProvisioningRequirements)[number]): number => (
    new Set(requirement.provisioningAttempts
      .filter((attempt) => (
        attempt.strategy.trim().length > 0
        && attempt.commands.some((command) => command.trim().length > 0)
      ))
      .map((attempt) => attempt.strategy.trim().toLowerCase())).size
  )
  const hasFailedProvisioningEvidence = failedProvisioningRequirements
    .some((requirement) => countDistinctFailedStrategies(requirement) >= 2)
  const hasNoSafePathEvidence = requirements.some((requirement) => (
    requirement.status === 'not_provisionable'
    && requirement.failureReason.trim().length > 0
  ))

  if (hasFailedProvisioningEvidence || hasNoSafePathEvidence) return []

  if (failedProvisioningRequirements.length > 0) {
    return [
      'Execution setup tooling failure must include persistent tool_requirements evidence: failed requirements need at least two distinct provisioning_attempts strategies with non-empty commands, or use not_provisionable with a failure_reason when no safe temp-root provisioning path exists.',
    ]
  }

  return [
    'Execution setup tooling failure must include tool_requirements evidence: record a failed requirement with at least two distinct provisioning_attempts strategies and non-empty commands, or a not_provisionable requirement with failure_reason before returning checks.tooling=fail.',
  ]
}

async function generateExecutionSetupRetryNote(input: {
  ticketId: string
  context: TicketContext
  generation: ExecutionSetupGenerationResult
  report: ExecutionSetupReport
  signal: AbortSignal
  model: string
  variant?: string
  onPromptDispatched?: (event: OpenCodePromptDispatchEvent) => void
  onPromptCompleted?: (event: OpenCodePromptCompletedEvent) => void
}): Promise<string | null> {
  const ticketState: TicketState = {
    ticketId: input.context.externalId,
    title: input.context.title,
    description: '',
  }

  const errorContext = {
    type: 'text' as const,
    source: 'error_context',
    content: [
      '## Execution Setup Attempt Failure',
      input.report.errors.join('\n') || 'Unknown failure',
      '',
      '## Last Output',
      input.generation.output.slice(0, 4000),
    ].join('\n'),
  }

  const prompt = buildSameSessionPromptFromTemplate(
    PROM_EXECUTION_SETUP_NOTE,
    [...buildMinimalContext('preflight', ticketState), errorContext],
  )

  const response = await runOpenCodeSessionPrompt({
    adapter,
    session: input.generation.session,
    parts: [{ type: 'text', content: prompt }],
    signal: input.signal,
    timeoutMs: 60000,
    timeoutKind: 'execution_setup',
    model: input.model,
    variant: input.variant,
    erroredSessionPolicy: 'discard_errored_session_output',
    toolPolicy: PROM_EXECUTION_SETUP_NOTE.toolPolicy,
    onPromptDispatched: (event) => {
      input.onPromptDispatched?.(event)
    },
    onPromptCompleted: (event) => {
      input.onPromptCompleted?.(event)
    },
  })

  return response.response.trim() || null
}

export async function handleExecutionSetup(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  if (isMockOpenCodeMode()) {
    await handleMockExecutionUnsupported(ticketId, context, 'PREPARING_EXECUTION_ENV', sendEvent)
    return
  }

  return withCommandLoggingAsync(
    ticketId, context.externalId, 'PREPARING_EXECUTION_ENV',
    async () => {
      const paths = getTicketPaths(ticketId)
      if (!paths) throw new Error(`Ticket workspace not initialized: missing ticket paths for ${context.externalId}`)

      const setupModelId = context.lockedMainImplementer
      if (!setupModelId) {
        throw new Error('No locked main implementer is configured for execution setup')
      }

      const runtimeSettings = resolveExecutionSetupRuntimeSettings(context)
      const approvedPlan = readExecutionSetupPlan(ticketId).plan
      if (!approvedPlan) {
        throw new Error('Approved execution setup plan is missing')
      }
      const materializeApprovedInputs = () => materializeExecutionSetupWorkspaceInputs({
        projectRoot: paths.projectRoot,
        worktreePath: paths.worktreePath,
        workspaceInputs: approvedPlan.workspaceInputs,
      })
      const materialized = materializeApprovedInputs()
      if (materialized.copiedPaths.length > 0) {
        emitPhaseLog(
          ticketId,
          context.externalId,
          'PREPARING_EXECUTION_ENV',
          'info',
          `Materialized ${materialized.copiedPaths.length} approved workspace input${materialized.copiedPaths.length === 1 ? '' : 's'}.`,
          { paths: materialized.copiedPaths },
        )
      }
      const phaseStartCommit = recordWorktreeStartCommit(paths.worktreePath)
      const approvedPlanCommands = flattenExecutionSetupPlanCommands(approvedPlan)
      const sessionManager = new SessionManager(adapter)
      const streamStates = new Map<string, OpenCodeStreamState>()
      const existingRetryNotesArtifact = getLatestPhaseArtifact(
        ticketId,
        EXECUTION_SETUP_RETRY_NOTES_ARTIFACT_TYPE,
        'PREPARING_EXECUTION_ENV',
      )
      let retryNotes = parseExecutionSetupRetryNotes(existingRetryNotesArtifact?.content)
      const previousReportAttempt = readExecutionSetupAttempt(getLatestPhaseArtifact(
        ticketId,
        EXECUTION_SETUP_REPORT_ARTIFACT_TYPE,
        'PREPARING_EXECUTION_ENV',
      )?.content)
      const pendingContinuation = getPendingSessionContinuationForTicketPhase(
        ticketId,
        'PREPARING_EXECUTION_ENV',
      )

      const report = await executeExecutionSetupWithRetries(
        adapter,
        async () => await adapter.assembleCouncilContext(ticketId, 'execution_setup'),
        paths.worktreePath,
        signal,
        {
          ticketId,
          model: setupModelId,
          variant: context.lockedMainImplementerVariant ?? undefined,
          maxIterations: runtimeSettings.maxIterations,
          timeoutMs: runtimeSettings.timeoutMs,
          structuredRetryCount: resolveStructuredRetryRuntimeSettings(context).structuredRetryCount,
          initialRetryNotes: retryNotes,
          initialAttempt: Math.max(retryNotes.length, previousReportAttempt) + 1,
          additionalManualIterations: pendingContinuation?.additionalRetryAttempts ?? 0,
        },
        {
          evaluateGeneration: async ({ generation }) => {
            const errors = [...generation.parse.errors]
            const result = generation.result
            const worktreeWarnings: string[] = []
            let profile = result?.profile ?? null

            if (profile) {
              profile = repairExecutionSetupCommandWrapper(profile, paths.worktreePath).profile
              const hookDiscovery = discoverGitHooks(paths.worktreePath)
              profile = {
                ...profile,
                workspaceInputs: approvedPlan.workspaceInputs,
                workspaceProbes: approvedPlan.workspaceProbes,
                gitHooks: {
                  policy: approvedPlan.gitHooks.policy,
                  detected: hookDiscovery.detected,
                  validationCommands: approvedPlan.gitHooks.validationCommands,
                },
              }
            }

            if (result && !allChecksPass(result)) {
              errors.push(buildFailedSetupChecksError(result))
            }

            if (profile) {
              if (result) {
                errors.push(...validateExecutionSetupToolingFailureEvidence({
                  result,
                  profile,
                }))
              }

              if (result && allChecksPass(result) && errors.length === 0) {
                const validation = await validateExecutionSetupRuntimeProfile({
                  ticketId,
                  worktreePath: paths.worktreePath,
                  beadsPath: paths.beadsPath,
                  profile,
                  signal,
                })
                errors.push(...validation.errors)
                profile = validation.profile
              }

              try {
                const setupExcludedRoots = getExecutionSetupCommitExcludedRoots(paths.worktreePath, profile)
                const changeSummary = summarizeWorktreeChanges(paths.worktreePath, {
                  setupExcludedRoots,
                })

                if (changeSummary.hasCommittableChanges) {
                  errors.push(buildWorktreeDirtyError(changeSummary.committable.map(entry => entry.path)))
                }

                if (changeSummary.generatedNoise.length > 0) {
                  const warning = buildGeneratedNoiseWarning(changeSummary.generatedNoise)
                  worktreeWarnings.push(warning)
                  profile = addProfileCautions(profile, [warning])
                }
              } catch (err) {
                errors.push(`Failed to inspect setup worktree cleanliness: ${err instanceof Error ? err.message : 'Unknown error'}`)
              }
            }

            return buildExecutionSetupReport({
              preparedBy: setupModelId,
              generation,
              errors,
              profile,
              approvedPlanCommands,
              worktreeWarnings,
            })
          },
          generateRetryNote: async ({ generation, report }) => {
            try {
              return await generateExecutionSetupRetryNote({
                ticketId,
                context,
                generation,
                report,
                signal,
                model: setupModelId,
                variant: context.lockedMainImplementerVariant ?? undefined,
                onPromptDispatched: (event) => {
                  emitOpenCodePromptLog(
                    ticketId,
                    context.externalId,
                    'PREPARING_EXECUTION_ENV',
                    setupModelId,
                    event,
                  )
                },
                onPromptCompleted: (event) => {
                  emitOpenCodeSessionLogs(
                    ticketId,
                    context.externalId,
                    'PREPARING_EXECUTION_ENV',
                    setupModelId,
                    event.session.id,
                    'execution_setup_note',
                    event.response,
                    event.messages,
                  )
                },
              })
            } catch {
              return null
            }
          },
          onAttemptStart: (attempt, metadata) => {
            emitPhaseLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              'info',
              metadata.isManualContinuationAttempt
                ? `Resuming execution setup session for user-requested attempt ${attempt} (configured automatic budget ${metadata.baseMaxIterations}).`
                : metadata.isExtraToolingPersistenceAttempt
                ? `Starting execution setup tooling persistence attempt ${attempt} (extra ${metadata.extraToolingPersistenceAttempt} of ${metadata.maxExtraToolingPersistenceAttempts}; base budget ${metadata.baseMaxIterations}).`
                : runtimeSettings.maxIterations > 0
                ? `Starting execution setup attempt ${attempt} of ${runtimeSettings.maxIterations}.`
                : `Starting execution setup attempt ${attempt} with unlimited retry budget.`,
            )
          },
          onAttemptComplete: async ({ attempt, report, generation }) => {
            emitPhaseLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              report.ready ? 'info' : 'error',
              report.ready
                ? `Execution setup attempt ${attempt} produced a reusable setup profile.`
                : `Execution setup attempt ${attempt} failed: ${report.errors.join('; ') || 'validation failed'}`,
            )

            for (const warning of report.worktreeWarnings ?? []) {
              emitPhaseLog(
                ticketId,
                context.externalId,
                'PREPARING_EXECUTION_ENV',
                'info',
                warning,
              )
            }

            if (report.ready) {
              await sessionManager.completeSession(generation.session.id)
            }
          },
          onRetryAnalysisStart: ({ attempt }) => {
            emitPhaseLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              'info',
              `Analyzing execution setup attempt ${attempt} failure before the retry decision.`,
              {
                source: 'system',
                audience: 'all',
                kind: 'milestone',
                attempt,
              },
            )
          },
          onSessionCreated: (sessionId, attempt) => {
            emitAiMilestone(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              `Execution setup attempt ${attempt} session created for ${setupModelId} (session=${sessionId}).`,
              `${sessionId}:execution-setup-created:${attempt}`,
              {
                attempt,
                modelId: setupModelId,
                sessionId,
                source: `model:${setupModelId}`,
              },
            )
          },
          onOpenCodeStreamEvent: ({ sessionId, event }) => {
            const streamState = streamStates.get(sessionId) ?? createOpenCodeStreamState()
            streamStates.set(sessionId, streamState)
            emitOpenCodeStreamEvent(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              setupModelId,
              sessionId,
              event,
              streamState,
            )
          },
          onPromptDispatched: ({ event }) => {
            emitOpenCodePromptLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              setupModelId,
              event,
            )
          },
          onPromptCompleted: ({ stage, event }) => {
            emitOpenCodeSessionLogs(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              setupModelId,
              event.session.id,
              stage,
              event.response,
              event.messages,
              streamStates.get(event.session.id),
            )
          },
          onStructuredRetryStart: ({ attempt, retryAttempt, sessionId }) => {
            emitPhaseLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              'info',
              `Correcting the structured execution setup result for attempt ${attempt} (correction ${retryAttempt}).`,
              {
                source: 'system',
                audience: 'all',
                kind: 'milestone',
                attempt,
                retryAttempt,
                sessionId,
              },
            )
          },
          onFailedAttempt: async ({ note, notes, canRetry }) => {
            retryNotes = notes
            upsertLatestPhaseArtifact(
              ticketId,
              EXECUTION_SETUP_RETRY_NOTES_ARTIFACT_TYPE,
              'PREPARING_EXECUTION_ENV',
              serializeExecutionSetupRetryNotes(notes),
            )
            emitPhaseLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              'info',
              canRetry
                ? 'Appended an execution setup retry note for the next attempt.'
                : 'Appended an execution setup retry note before blocking.',
              { note },
            )
          },
          beforeRetry: async ({ generation, nextAttempt }) => {
            await sessionManager.abandonSession(generation.session.id)
            resetWorktreeToCommit(paths.worktreePath, phaseStartCommit, {
              preservePaths: [...WORKTREE_RESET_PRESERVE_PATHS],
            })
            materializeApprovedInputs()
            clearExecutionSetupRuntimeArtifacts(ticketId, { preserveToolCache: true })
            emitPhaseLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              'info',
              `Reset worktree to the execution-setup start commit before attempt ${nextAttempt}.`,
              {
                commit: phaseStartCommit,
                nextAttempt,
              },
            )
          },
          onRetriesExhausted: ({ attempt, reason }) => {
            emitPhaseLog(
              ticketId,
              context.externalId,
              'PREPARING_EXECUTION_ENV',
              'error',
              reason === 'repeated_tooling_failure'
                ? `Execution setup stopped after ${attempt} attempts because the same tooling blocker repeated after provisioning failed.`
                : reason === 'not_provisionable'
                ? `Execution setup stopped after attempt ${attempt} because the agent found no safe temporary provisioning path.`
                : `Execution setup retries exhausted after ${attempt} attempt${attempt === 1 ? '' : 's'}.`,
            )
          },
        },
      )
      throwIfAborted(signal, ticketId)

      if (report.ready && report.profile) {
        writeExecutionSetupProfileMirror(ticketId, report.profile)
        upsertLatestPhaseArtifact(
          ticketId,
          EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
          'PREPARING_EXECUTION_ENV',
          serializeExecutionSetupProfile(report.profile),
        )
      }

      upsertLatestPhaseArtifact(
        ticketId,
        EXECUTION_SETUP_REPORT_ARTIFACT_TYPE,
        'PREPARING_EXECUTION_ENV',
        JSON.stringify(report),
      )

      persistUiArtifactCompanionArtifact(
        ticketId,
        'PREPARING_EXECUTION_ENV',
        EXECUTION_SETUP_PROFILE_ARTIFACT_TYPE,
        {
          response: report.modelOutput,
          normalizedContent: report.profile ? serializeExecutionSetupProfile(report.profile) : null,
          parsed: report.profile ? { profile: report.profile, checks: report.checks, summary: report.summary } : null,
          structuredOutput: report.structuredOutput,
          rawAttempts: report.rawAttempts,
          status: report.status,
          errors: report.errors,
          worktreeWarnings: report.worktreeWarnings,
          retryNotes: retryNotes,
          attemptHistory: report.attemptHistory,
          approvedPlanCommands: report.approvedPlanCommands,
          executionAddedCommands: report.executionAddedCommands,
        },
      )

      if (report.ready) {
        const pathInfo = describeExecutionSetupPaths(ticketId)
        emitPhaseLog(
          ticketId,
          context.externalId,
          'PREPARING_EXECUTION_ENV',
          'info',
          `Execution setup profile is ready${pathInfo ? ` at ${pathInfo.profilePath}` : ''}.`,
        )
        sendEvent({ type: 'EXECUTION_SETUP_READY' })
        return
      }

      sendEvent({ type: 'EXECUTION_SETUP_FAILED', errors: report.errors })
    },
    (phase, type, content) => emitPhaseLog(ticketId, context.externalId, phase, type, content, { source: 'system', audience: 'all' }),
  )
}
