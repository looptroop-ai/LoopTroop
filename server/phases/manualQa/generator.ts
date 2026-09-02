import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { TicketContext, TicketEvent } from '../../machines/types'
import { readBeadsFile } from '../beads/beadsFile'
import type { Bead } from '../beads/types'
import { getLatestPhaseArtifact, getTicketByRef, getTicketPaths, insertPhaseArtifact, resolvePhaseAttempt } from '../../storage/tickets'
import { runOpenCodePrompt } from '../../workflow/runOpenCodePrompt'
import { adapter } from '../../workflow/phases/state'
import {
  createOpenCodeStreamState,
  emitAiMilestone,
  emitOpenCodePromptLog,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  resolveAiResponseRuntimeSettings,
  resolveStructuredRetryRuntimeSettings,
} from '../../workflow/phases/helpers'
import { prepareManualQaCheckpoint } from './checkpoint'
import { deriveManualQaPrdCriteria, computeManualQaCoverage } from './coverage'
import { readManualQaPrd, type ManualQaPrd } from './prd'
import { MANUAL_QA_CHECKLIST_TAG, parseManualQaChecklistOutput } from './parser'
import {
  allocateNextManualQaVersion,
  appendManualQaEvent,
  completeManualQaReservation,
  getManualQaChecklistHash,
  listManualQaVersions,
  persistManualQaChecklist,
  persistManualQaCoverage,
  readManualQaChecklist,
  readManualQaCoverage,
  readManualQaResults,
  readManualQaSummary,
  reserveManualQaVersion,
} from './storage'
import { focusedDiffMetadata } from './focusedDiff'

export function resolveManualQaGenerationVersion(ticketDir: string): number {
  const root = resolve(ticketDir, 'manual-qa')
  if (existsSync(root)) {
    const reserved = readdirSync(root)
      .map((name) => name.match(/^generation-reservation-v([1-9]\d*)\.json$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(Number)
      .sort((left, right) => right - left)
    for (const version of reserved) {
      const summary = readManualQaSummary(ticketDir, version)
      if (!summary || summary.outcome === 'failed') return version
    }
  }
  return allocateNextManualQaVersion(ticketDir)
}

export function restoreManualQaGenerationArtifacts(ticketDir: string, version: number): {
  checklist: NonNullable<ReturnType<typeof readManualQaChecklist>>
  coverage: NonNullable<ReturnType<typeof readManualQaCoverage>>
} | null {
  const checklist = readManualQaChecklist(ticketDir, version)
  if (!checklist) return null
  let coverage = readManualQaCoverage(ticketDir, version)
  if (!coverage) {
    coverage = computeManualQaCoverage(checklist, deriveManualQaPrdCriteria(readManualQaPrd(ticketDir)))
    persistManualQaCoverage(ticketDir, coverage)
  }
  return { checklist, coverage }
}

function compactBeads(beadsPath: string): Array<Pick<Bead,
  'id' | 'title' | 'description' | 'prdRefs' | 'targetFiles' | 'acceptanceCriteria' | 'tests' | 'labels' | 'issueType'
>> {
  return readBeadsFile(beadsPath).map((bead) => ({
    id: bead.id,
    title: bead.title,
    description: bead.description,
    prdRefs: bead.prdRefs,
    targetFiles: bead.targetFiles,
    acceptanceCriteria: bead.acceptanceCriteria,
    tests: bead.tests,
    labels: bead.labels,
    issueType: bead.issueType,
  }))
}

export function buildGenerationPrompt(input: {
  context: TicketContext
  ticketDescription: string
  prd: ManualQaPrd
  beads: ReturnType<typeof compactBeads>
  finalTestReport: string
  previousQa: unknown
  diffMetadata: string
}): string {
  return [
    '# Manual QA checklist generation',
    'Create a concise human-run checklist for the implemented user-facing behavior.',
    'LoopTroop will never start, stop, preview, or control the user application. Do not instruct LoopTroop to do so.',
    'Use only the supplied ticket/PRD/bead/final-test/previous-QA context. You may use read-only tools for focused diff inspection, but do not dump the repository.',
    '',
    `Return exactly one <${MANUAL_QA_CHECKLIST_TAG}> tagged YAML document with this strict shape:`,
    'summary: string',
    'not_applicable_prd_refs:',
    '  - ref: <epic-id>/<story-id>/AC-<1-based-index>',
    '    reason: why this criterion cannot be meaningfully verified by a human',
    'items:',
    '  - lineage_id: stable-kebab-id',
    '    prior_item_ids: [prior version item IDs]',
    '    title: concise human-facing check title',
    '    source: prd | bead | previous_qa | implementation_diff',
    '    behavior: string',
    '    severity: required | optional',
    '    recheck_state: new | pending_recheck | previously_passed',
    '    prerequisites: [string]',
    '    actions: [string] # at least one',
    '    expected_result: string',
    '    watch_notes: [string]',
    '    bead_refs: [bead-id]',
    '    prd_refs:',
    '      - ref: <epic-id>/<story-id>/AC-<1-based-index>',
    '        coverage: full | partial',
    'Do not add fields. Use only valid PRD criterion refs shown below. Every criterion may be covered, not applicable to Manual QA with a concrete reason, or genuinely uncovered. Coverage gaps are advisory; never invent refs.',
    'Use not_applicable_prd_refs only for automated, build-only, internal, or otherwise non-user-observable criteria. Never use it to conceal a missing human check.',
    'Quote every YAML string containing #, : followed by a space, brackets, braces, or other YAML-sensitive punctuation so user-visible text is preserved exactly.',
    '',
    'First-round and newly introduced items must use recheck_state: new and have no prior_item_ids.',
    'Later-round rules: preserve relevant lineage/structure; failed/fixed or affected passed/waived items become pending_recheck; unaffected passed items may be previously_passed; omit unaffected waived items; add items only for newly affected user-facing behavior.',
    '',
    '## Ticket',
    JSON.stringify({
      id: input.context.externalId,
      title: input.context.title,
      description: input.ticketDescription,
    }, null, 2),
    '',
    '## Approved PRD',
    JSON.stringify(input.prd, null, 2),
    '',
    '## Selected bead fields',
    JSON.stringify(input.beads, null, 2),
    '',
    '## Current final-test report',
    input.finalTestReport || 'No report content available.',
    '',
    '## Latest previous Manual QA artifacts',
    JSON.stringify(input.previousQa, null, 2),
    '',
    '## Focused candidate diff metadata',
    input.diffMetadata,
  ].join('\n')
}

function shouldPersistManualQaGenerationArtifact(existingContent: string | null | undefined, version: number): boolean {
  return !existingContent?.includes(`"version":${version}`)
}

export function resolveManualQaGenerationArtifactRepairs(input: {
  checklistContent?: string | null
  coverageContent?: string | null
  version: number
}): { checklist: boolean; coverage: boolean } {
  return {
    checklist: shouldPersistManualQaGenerationArtifact(input.checklistContent, input.version),
    coverage: shouldPersistManualQaGenerationArtifact(input.coverageContent, input.version),
  }
}

function persistGenerationArtifacts(ticketId: string, version: number, checklistContent: string, coverage: unknown): void {
  const phase = 'GENERATING_QA_CHECKLIST'
  const phaseAttempt = resolvePhaseAttempt(ticketId, phase)
  const existingChecklist = getLatestPhaseArtifact(ticketId, 'manual_qa_checklist', phase, phaseAttempt)
  const existingCoverage = getLatestPhaseArtifact(ticketId, 'manual_qa_coverage', phase, phaseAttempt)
  const repairs = resolveManualQaGenerationArtifactRepairs({
    checklistContent: existingChecklist?.content,
    coverageContent: existingCoverage?.content,
    version,
  })
  if (repairs.checklist) {
    insertPhaseArtifact(ticketId, {
      phase,
      phaseAttempt,
      artifactType: 'manual_qa_checklist',
      content: JSON.stringify({ version, checklist: checklistContent }),
    })
  }
  if (repairs.coverage) {
    insertPhaseArtifact(ticketId, {
      phase,
      phaseAttempt,
      artifactType: 'manual_qa_coverage',
      content: JSON.stringify(coverage),
    })
  }
}

function persistGenerationReservationArtifact(ticketId: string, version: number, actionId: string): void {
  const phase = 'GENERATING_QA_CHECKLIST'
  const phaseAttempt = resolvePhaseAttempt(ticketId, phase)
  const existing = getLatestPhaseArtifact(ticketId, 'manual_qa_generation_reservation', phase, phaseAttempt)
  if (existing?.content.includes(`"version":${version}`)) return
  insertPhaseArtifact(ticketId, {
    phase,
    phaseAttempt,
    artifactType: 'manual_qa_generation_reservation',
    content: JSON.stringify({ version, actionId, state: 'reserved' }),
  })
}

export async function handleManualQaChecklistGeneration(
  ticketId: string,
  context: TicketContext,
  sendEvent: (event: TicketEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const paths = getTicketPaths(ticketId)
  if (!paths) throw new Error(`Ticket storage was not found: ${ticketId}`)
  const phase = 'GENERATING_QA_CHECKLIST'
  const phaseAttempt = resolvePhaseAttempt(ticketId, phase)
  const milestone = (message: string, suffix: string) => emitAiMilestone(
    ticketId,
    context.externalId,
    phase,
    message,
    suffix,
    { source: 'system', phaseAttempt },
  )
  milestone('Preparing the next Manual QA checklist round.', 'started')
  const version = resolveManualQaGenerationVersion(paths.ticketDir)
  const reservation = reserveManualQaVersion(paths.ticketDir, ticketId, version)
  milestone(`Reserved Manual QA v${version}.`, `v${version}:reserved`)
  persistGenerationReservationArtifact(ticketId, version, reservation.actionId)
  appendManualQaEvent(paths.ticketDir, {
    schemaVersion: 1,
    eventId: `generation-v${version}-reserved`,
    eventType: 'generation_reserved',
    ticketId: context.externalId,
    version,
    actionId: reservation.actionId,
    createdAt: reservation.createdAt,
    data: {},
  })

  milestone('Creating the clean checkpoint and workspace baseline.', `v${version}:checkpoint-started`)
  prepareManualQaCheckpoint(ticketId, version)
  milestone('Checkpoint and workspace baseline are ready.', `v${version}:checkpoint-ready`)

  const restored = restoreManualQaGenerationArtifacts(paths.ticketDir, version)
  if (restored) {
    const { checklist: existingChecklist, coverage: existingCoverage } = restored
    const checklistHash = getManualQaChecklistHash(paths.ticketDir, version)
    if (!checklistHash) throw new Error('Existing Manual QA checklist hash is unavailable.')
    completeManualQaReservation(paths.ticketDir, reservation, checklistHash)
    persistGenerationArtifacts(ticketId, version, JSON.stringify(existingChecklist), existingCoverage)
    appendManualQaEvent(paths.ticketDir, {
      schemaVersion: 1,
      eventId: `checklist-v${version}-ready`,
      eventType: 'checklist_ready',
      ticketId: context.externalId,
      version,
      actionId: reservation.actionId,
      createdAt: existingChecklist.generatedAt,
      data: { checklistHash },
    })
    milestone(`Restored and validated the existing Manual QA v${version} checklist artifacts.`, `v${version}:restored`)
    sendEvent({ type: 'QA_CHECKLIST_READY' })
    return
  }

  const model = context.lockedMainImplementer?.trim()
  if (!model) throw new Error('Manual QA generation requires the locked main implementer model.')
  const prd = readManualQaPrd(paths.ticketDir)
  const ticket = getTicketByRef(ticketId)
  if (!ticket) throw new Error(`Ticket was not found: ${ticketId}`)
  const criteria = deriveManualQaPrdCriteria(prd)
  const priorVersion = listManualQaVersions(paths.ticketDir).filter((candidate) => candidate < version).at(-1)
  const previousQa = priorVersion
    ? {
        checklist: readManualQaChecklist(paths.ticketDir, priorVersion),
        results: readManualQaResults(paths.ticketDir, priorVersion),
        coverage: readManualQaCoverage(paths.ticketDir, priorVersion),
        summary: readManualQaSummary(paths.ticketDir, priorVersion),
      }
    : null
  const finalTestReport = getLatestPhaseArtifact(ticketId, 'final_test_report', 'RUNNING_FINAL_TEST')?.content ?? ''
  const basePrompt = buildGenerationPrompt({
    context,
    ticketDescription: ticket.description ?? '',
    prd,
    beads: compactBeads(paths.beadsPath),
    finalTestReport,
    previousQa,
    diffMetadata: focusedDiffMetadata(paths.worktreePath, ticket.runtime.baseBranch),
  })
  milestone('Assembled ticket, PRD, bead, test, prior-QA, and focused-diff context.', `v${version}:context-ready`)
  const timeoutMs = resolveAiResponseRuntimeSettings(context).timeoutMs
  const maxRetries = resolveStructuredRetryRuntimeSettings(context).structuredRetryCount
  let correction = ''
  let lastError = 'Manual QA checklist generation failed.'

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let sessionId = ''
    const streamState = createOpenCodeStreamState()
    milestone(
      attempt === 0 ? 'Generating the Manual QA checklist with read-only repository tools.' : `Retrying checklist structured output (attempt ${attempt + 1}).`,
      `v${version}:model-attempt:${attempt + 1}`,
    )
    const result = await runOpenCodePrompt({
      adapter,
      projectPath: paths.worktreePath,
      parts: [{ type: 'text', content: `${basePrompt}${correction}` }],
      signal,
      timeoutMs,
      timeoutKind: 'ai_response',
      model,
      variant: context.lockedMainImplementerVariant ?? undefined,
      toolPolicy: 'read_only',
      sessionOwnership: {
        ticketId,
        phase: 'GENERATING_QA_CHECKLIST',
        phaseAttempt: resolvePhaseAttempt(ticketId, 'GENERATING_QA_CHECKLIST'),
        memberId: model,
        step: attempt === 0 ? 'generate' : `structured-retry-${attempt}`,
        forceFresh: attempt > 0,
      },
      onSessionCreated: (session) => { sessionId = session.id },
      onPromptDispatched: (event) => emitOpenCodePromptLog(ticketId, context.externalId, phase, model, event),
      onStreamEvent: (event) => {
        if (sessionId) emitOpenCodeStreamEvent(ticketId, context.externalId, phase, model, sessionId, event, streamState)
      },
    })
    emitOpenCodeSessionLogs(
      ticketId,
      context.externalId,
      phase,
      model,
      result.session.id,
      'Manual QA checklist generation',
      result.response,
      result.messages,
      streamState,
    )
    const parsed = parseManualQaChecklistOutput(result.response, {
      ticketId: context.externalId,
      version,
      prdCriteria: criteria,
      previousChecklist: priorVersion ? readManualQaChecklist(paths.ticketDir, priorVersion) : null,
      previousResults: priorVersion ? readManualQaResults(paths.ticketDir, priorVersion) : null,
    })
    if (parsed.ok) {
      const checklistHash = persistManualQaChecklist(paths.ticketDir, parsed.value)
      const coverage = computeManualQaCoverage(parsed.value, criteria)
      persistManualQaCoverage(paths.ticketDir, coverage)
      completeManualQaReservation(paths.ticketDir, reservation, checklistHash)
      persistGenerationArtifacts(ticketId, version, parsed.normalizedContent, coverage)
      appendManualQaEvent(paths.ticketDir, {
        schemaVersion: 1,
        eventId: `checklist-v${version}-ready`,
        eventType: 'checklist_ready',
        ticketId: context.externalId,
        version,
        actionId: reservation.actionId,
        createdAt: parsed.value.generatedAt,
        data: { checklistHash },
      })
      milestone(`Validated and persisted Manual QA v${version} checklist and PRD coverage.`, `v${version}:persisted`)
      sendEvent({ type: 'QA_CHECKLIST_READY' })
      return
    }
    lastError = parsed.error
    correction = [
      '\n\n## Structured-output correction',
      `The previous response was invalid: ${parsed.error}`,
      `Return a corrected response in exactly one <${MANUAL_QA_CHECKLIST_TAG}> tag. Formatting repairs may not invent checklist content, actions, observations, or expected results.`,
      'Previous invalid response (for correction only):',
      result.response.slice(0, 50_000),
    ].join('\n')
  }
  throw new Error(lastError)
}
