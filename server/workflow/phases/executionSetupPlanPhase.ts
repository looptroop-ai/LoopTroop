import type { TicketContext, TicketEvent } from '../../machines/types'
import type { PromptPart } from '../../opencode/types'
import { withCommandLoggingAsync } from '../../log/commandLogger'
import { ensureActivePhaseAttempt } from '../../storage/ticketPhaseAttempts'
import { getTicketPaths } from '../../storage/tickets'
import { throwIfAborted } from '../../council/types'
import { persistUiArtifactCompanionArtifact } from '../artifactCompanions'
import { adapter } from './state'
import {
  emitAiMilestone,
  emitOpenCodePromptLog,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  emitPhaseLog,
  createOpenCodeStreamState,
  resolveAiResponseRuntimeSettings,
  resolveStructuredRetryRuntimeSettings,
} from './helpers'
import type { OpenCodeStreamState } from './types'
import { handleMockExecutionUnsupported } from './executionPhase'
import { isMockOpenCodeMode } from '../../opencode/factory'
import { generateExecutionSetupPlan } from '../../phases/executionSetupPlan/generator'
import {
  EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
  type ExecutionSetupPlan,
  type ExecutionSetupPlanGenerationResult,
  type ExecutionSetupPlanReport,
} from '../../phases/executionSetupPlan/types'
import {
  appendExecutionSetupPlanNotes,
  readExecutionSetupPlan,
  readExecutionSetupPlanNotes,
  saveExecutionSetupPlan,
  writeExecutionSetupPlanReport,
} from '../../phases/executionSetupPlan/document'
import {
  PROM_EXECUTION_SETUP_PLAN,
  PROM_EXECUTION_SETUP_PLAN_REGENERATE,
} from '../../prompts/index'
import { enrichGeneratedExecutionSetupPlan } from '../../phases/executionSetupPlan/hookEvidence'
import { validateExecutionSetupWorkspaceInputs } from '../../phases/executionSetup/workspaceInputs'

function buildExecutionSetupPlanReport(input: {
  generatedBy: string
  generation: ExecutionSetupPlanGenerationResult
  notes: string[]
  source: 'auto' | 'regenerate'
}): ExecutionSetupPlanReport {
  return {
    status: input.generation.plan ? 'draft' : 'failed',
    ready: input.generation.plan !== null,
    generatedAt: new Date().toISOString(),
    generatedBy: input.generatedBy,
    summary: input.generation.plan?.summary,
    plan: input.generation.plan,
    modelOutput: input.generation.output,
    errors: [...input.generation.parse.errors],
    structuredOutput: input.generation.structuredOutput,
    rawAttempts: input.generation.rawAttempts,
    notes: input.notes,
    source: input.source,
  }
}

function buildRegenerateContext(
  baseContext: PromptPart[],
  currentPlan: ExecutionSetupPlan | null,
  note: string | null,
  notes: string[],
): PromptPart[] {
  const extra: PromptPart[] = []
  if (currentPlan) {
    extra.push({
      type: 'text',
      source: 'execution_setup_plan',
      content: JSON.stringify({
        schema_version: currentPlan.schemaVersion,
        ticket_id: currentPlan.ticketId,
        artifact: currentPlan.artifact,
        status: currentPlan.status,
        summary: currentPlan.summary,
        readiness: {
          status: currentPlan.readiness.status,
          actions_required: currentPlan.readiness.actionsRequired,
          evidence: currentPlan.readiness.evidence,
          gaps: currentPlan.readiness.gaps,
        },
        temp_roots: currentPlan.tempRoots,
        workspace_inputs: currentPlan.workspaceInputs,
        workspace_probes: currentPlan.workspaceProbes,
        git_hooks: {
          policy: currentPlan.gitHooks.policy,
          detected: currentPlan.gitHooks.detected,
          validation_commands: currentPlan.gitHooks.validationCommands,
        },
        steps: currentPlan.steps,
        project_commands: {
          prepare: currentPlan.projectCommands.prepare,
          test_full: currentPlan.projectCommands.testFull,
          lint_full: currentPlan.projectCommands.lintFull,
          typecheck_full: currentPlan.projectCommands.typecheckFull,
        },
        quality_gate_policy: {
          tests: currentPlan.qualityGatePolicy.tests,
          lint: currentPlan.qualityGatePolicy.lint,
          typecheck: currentPlan.qualityGatePolicy.typecheck,
          full_project_fallback: currentPlan.qualityGatePolicy.fullProjectFallback,
        },
        cautions: currentPlan.cautions,
      }, null, 2),
    })
  }
  if (note) {
    extra.push({
      type: 'text',
      source: 'execution_setup_plan_note',
      content: note,
    })
  }
  if (notes.length > 0) {
    extra.push({
      type: 'text',
      source: 'execution_setup_plan_notes',
      content: JSON.stringify(notes, null, 2),
    })
  }
  return [...baseContext, ...extra]
}

async function generateAndPersistExecutionSetupPlan(input: {
  ticketId: string
  context: TicketContext
  signal: AbortSignal
  source: 'auto' | 'regenerate'
  currentPlan?: ExecutionSetupPlan | null
  note?: string | null
}): Promise<ExecutionSetupPlanReport> {
  const paths = getTicketPaths(input.ticketId)
  if (!paths) {
    throw new Error(`Ticket workspace not initialized: missing ticket paths for ${input.context.externalId}`)
  }

  const planModelId = input.context.lockedMainImplementer
  if (!planModelId) {
    throw new Error('No locked main implementer is configured for execution setup planning')
  }

  const aiResponseSettings = resolveAiResponseRuntimeSettings(input.context)
  const streamStates = new Map<string, OpenCodeStreamState>()
  const baseContext = await adapter.assembleCouncilContext(input.ticketId, 'execution_setup_plan')
  const workspaceLocations: PromptPart = {
    type: 'text',
    source: 'workspace_locations',
    content: JSON.stringify({
      original_checkout: paths.projectRoot,
      ticket_worktree: paths.worktreePath,
    }, null, 2),
  }
  const notes = input.note
    ? appendExecutionSetupPlanNotes(input.ticketId, [input.note])
    : readExecutionSetupPlanNotes(input.ticketId)
  const promptContext = input.source === 'regenerate'
    ? buildRegenerateContext([...baseContext, workspaceLocations], input.currentPlan ?? null, input.note ?? null, notes)
    : [...baseContext, workspaceLocations]

  emitPhaseLog(
    input.ticketId,
    input.context.externalId,
    'WAITING_EXECUTION_SETUP_APPROVAL',
    'info',
    input.source === 'auto'
      ? 'Auditing workspace readiness and drafting the execution setup plan for review.'
      : 'Regenerating the readiness assessment and execution setup plan from user commentary.',
  )

  const phaseAttempt = ensureActivePhaseAttempt(input.ticketId, 'WAITING_EXECUTION_SETUP_APPROVAL')

  const generation = await generateExecutionSetupPlan(
    adapter,
    promptContext,
    paths.worktreePath,
    input.signal,
    {
      ticketId: input.ticketId,
      model: planModelId,
      variant: input.context.lockedMainImplementerVariant ?? undefined,
      timeoutMs: aiResponseSettings.timeoutMs,
      structuredRetryCount: resolveStructuredRetryRuntimeSettings(input.context).structuredRetryCount,
      phaseAttempt,
      promptTemplate: input.source === 'regenerate'
        ? PROM_EXECUTION_SETUP_PLAN_REGENERATE
        : PROM_EXECUTION_SETUP_PLAN,
      onSessionCreated: (sessionId) => {
        emitAiMilestone(
          input.ticketId,
          input.context.externalId,
          'WAITING_EXECUTION_SETUP_APPROVAL',
          `${input.source === 'auto' ? 'Setup-plan draft' : 'Setup-plan regenerate'} session created for ${planModelId} (session=${sessionId}).`,
          `${sessionId}:execution-setup-plan:${input.source}`,
          {
            modelId: planModelId,
            sessionId,
            source: `model:${planModelId}`,
          },
        )
      },
      onOpenCodeStreamEvent: ({ sessionId, event }) => {
        const streamState = streamStates.get(sessionId) ?? createOpenCodeStreamState()
        streamStates.set(sessionId, streamState)
        emitOpenCodeStreamEvent(
          input.ticketId,
          input.context.externalId,
          'WAITING_EXECUTION_SETUP_APPROVAL',
          planModelId,
          sessionId,
          event,
          streamState,
        )
      },
      onPromptDispatched: ({ event }) => {
        emitOpenCodePromptLog(
          input.ticketId,
          input.context.externalId,
          'WAITING_EXECUTION_SETUP_APPROVAL',
          planModelId,
          event,
        )
      },
      onPromptCompleted: ({ stage, event }) => {
        emitOpenCodeSessionLogs(
          input.ticketId,
          input.context.externalId,
          'WAITING_EXECUTION_SETUP_APPROVAL',
          planModelId,
          event.session.id,
          stage,
          event.response,
          event.messages,
          streamStates.get(event.session.id),
        )
      },
    },
  )

  if (generation.plan) {
    try {
      generation.plan = enrichGeneratedExecutionSetupPlan(input.ticketId, {
        ...generation.plan,
        workspaceInputs: validateExecutionSetupWorkspaceInputs({
          projectRoot: paths.projectRoot,
          worktreePath: paths.worktreePath,
          workspaceInputs: generation.plan.workspaceInputs,
        }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      generation.parse.errors.push(message)
      generation.parse.plan = null
      generation.plan = null
    }
  }

  const report = buildExecutionSetupPlanReport({
    generatedBy: planModelId,
    generation,
    notes,
    source: input.source,
  })

  if (report.plan) {
    saveExecutionSetupPlan(input.ticketId, report.plan)
  }

  writeExecutionSetupPlanReport(input.ticketId, JSON.stringify(report))

  persistUiArtifactCompanionArtifact(
    input.ticketId,
    'WAITING_EXECUTION_SETUP_APPROVAL',
    EXECUTION_SETUP_PLAN_ARTIFACT_TYPE,
    {
      response: report.modelOutput,
      normalizedContent: report.plan ? JSON.stringify(report.plan) : null,
      parsed: report.plan,
      structuredOutput: report.structuredOutput,
      rawAttempts: report.rawAttempts,
      status: report.status,
      errors: report.errors,
      notes,
      source: report.source,
    },
  )

  emitPhaseLog(
    input.ticketId,
    input.context.externalId,
    'WAITING_EXECUTION_SETUP_APPROVAL',
    report.ready ? 'info' : 'error',
    report.ready
      ? 'Execution setup readiness plan is ready for review.'
      : `Execution setup plan generation failed: ${report.errors.join('; ') || 'validation failed'}`,
  )

  return report
}

export async function handleExecutionSetupPlanApprovalState(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal: AbortSignal,
) {
  if (isMockOpenCodeMode()) {
    await handleMockExecutionUnsupported(ticketId, context, 'WAITING_EXECUTION_SETUP_APPROVAL', sendEvent)
    return
  }

  return withCommandLoggingAsync(
    ticketId, context.externalId, 'WAITING_EXECUTION_SETUP_APPROVAL',
    async () => {
      throwIfAborted(signal, ticketId)
      const existingPlan = readExecutionSetupPlan(ticketId)
      if (existingPlan.plan) return

      const report = await generateAndPersistExecutionSetupPlan({
        ticketId,
        context,
        signal,
        source: 'auto',
      })
      throwIfAborted(signal, ticketId)

      if (report.ready) {
        sendEvent({ type: 'EXECUTION_SETUP_PLAN_READY' })
        return
      }

      sendEvent({ type: 'EXECUTION_SETUP_PLAN_FAILED', errors: report.errors })
    },
    (phase, type, content) => emitPhaseLog(ticketId, context.externalId, phase, type, content, { source: 'system', audience: 'all' }),
  )
}

export async function regenerateExecutionSetupPlanDraft(input: {
  ticketId: string
  context: TicketContext
  commentary: string
  currentPlan?: ExecutionSetupPlan | null
}) {
  const signal = AbortSignal.timeout(120000)
  return withCommandLoggingAsync(
    input.ticketId,
    input.context.externalId,
    'WAITING_EXECUTION_SETUP_APPROVAL',
    async () => await generateAndPersistExecutionSetupPlan({
      ticketId: input.ticketId,
      context: input.context,
      signal,
      source: 'regenerate',
      currentPlan: input.currentPlan ?? null,
      note: input.commentary,
    }),
    (phase, type, content) => emitPhaseLog(input.ticketId, input.context.externalId, phase, type, content, { source: 'system', audience: 'all' }),
  )
}
