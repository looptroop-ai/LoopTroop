import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { z } from 'zod'
import * as jsYaml from 'js-yaml'
import type { TicketContext } from '../../machines/types'
import type { Message, StreamEvent } from '../../opencode/types'
import { collectTaggedCandidates, buildYamlDocument, parseYamlOrJsonCandidate } from '../../structuredOutput/yamlUtils'
import { getLatestPhaseArtifact, getTicketByRef, getTicketPaths, resolvePhaseAttempt } from '../../storage/tickets'
import { buildPromptFromTemplate, PROM_MANUAL_QA_FIX_BEADS } from '../../prompts/index'
import { runOpenCodePrompt } from '../../workflow/runOpenCodePrompt'
import {
  createOpenCodeStreamState,
  emitAiMilestone,
  emitOpenCodePromptLog,
  emitOpenCodeSessionLogs,
  emitOpenCodeStreamEvent,
  resolveAiResponseRuntimeSettings,
  resolveStructuredRetryRuntimeSettings,
} from '../../workflow/phases/helpers'
import { adapter } from '../../workflow/phases/state'
import { safeAtomicWrite } from '../../io/atomicWrite'
import type { Bead, QaOrigin, QaOriginSourceItem } from '../beads/types'
import type {
  ManualQaChecklist,
  ManualQaDraft,
  ManualQaEvidenceRef,
  ManualQaModelCapabilitySnapshot,
} from './types'
import { getManualQaEvidenceRelativePath, getManualQaStoragePaths } from './storage'

export const MANUAL_QA_FIX_BEADS_TAG = 'MANUAL_QA_FIX_BEADS'

const CandidateSchema = z.object({
  groupId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().min(1),
  prdRefs: z.array(z.string().trim().min(1)),
  contextGuidance: z.object({
    patterns: z.array(z.string().trim().min(1)).min(1),
    anti_patterns: z.array(z.string().trim().min(1)).min(1),
  }).strict(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  tests: z.array(z.string().trim().min(1)).min(1),
  testCommands: z.array(z.string().trim().min(1)),
  testCommandReason: z.string().trim().min(1).optional(),
  labels: z.array(z.string().trim().min(1)).min(1),
  blockedByGroupIds: z.array(z.string().trim().min(1)).default([]),
  targetFiles: z.array(z.string().trim().min(1)).min(1),
}).strict().superRefine((candidate, ctx) => {
  if (candidate.testCommands.length === 0 && !candidate.testCommandReason) {
    ctx.addIssue({ code: 'custom', path: ['testCommandReason'], message: 'testCommandReason is required when testCommands is empty.' })
  }
  if (candidate.testCommands.length > 0 && candidate.testCommandReason) {
    ctx.addIssue({ code: 'custom', path: ['testCommandReason'], message: 'testCommandReason is allowed only when testCommands is empty.' })
  }
})

const CandidateDocumentSchema = z.object({
  beads: z.array(CandidateSchema).min(1),
}).strict()

const PersistedCandidateDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  artifact: z.literal('manual_qa_fix_beads'),
  version: z.number().int().positive(),
  beads: z.array(CandidateSchema).min(1),
}).strict()

export type ManualQaFixBeadCandidate = z.infer<typeof CandidateSchema>

export interface ManualQaFixGroup {
  groupId: string
  results: ManualQaDraft['results']
  allowedPrdRefs: string[]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export function buildManualQaFixGroups(
  checklist: ManualQaChecklist,
  draft: ManualQaDraft,
): ManualQaFixGroup[] {
  const itemById = new Map(checklist.items.map((item) => [item.id, item]))
  const grouped = new Map<string, ManualQaDraft['results']>()
  for (const result of draft.results.filter((entry) => entry.outcome === 'fail')) {
    const groupId = result.mergeGroupId ?? `item:${result.itemId}`
    grouped.set(groupId, [...(grouped.get(groupId) ?? []), result])
  }
  return [...grouped].map(([groupId, results]) => ({
    groupId,
    results,
    allowedPrdRefs: unique(results.flatMap((result) =>
      itemById.get(result.itemId)?.prdRefs.map((entry) => entry.ref) ?? [],
    )),
  }))
}

function isProjectRelativePath(value: string): boolean {
  if (!value.trim() || path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) return false
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'))
  return normalized !== '.' && !normalized.startsWith('../') && !normalized.includes('/../')
}

function sameStringSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value))
}

export function parseManualQaFixBeadsOutput(
  raw: string,
  groups: ManualQaFixGroup[],
): ManualQaFixBeadCandidate[] {
  const openingTags = raw.match(new RegExp(`<${MANUAL_QA_FIX_BEADS_TAG}>`, 'gi'))?.length ?? 0
  const closingTags = raw.match(new RegExp(`</${MANUAL_QA_FIX_BEADS_TAG}>`, 'gi'))?.length ?? 0
  if (openingTags !== 1 || closingTags !== 1) {
    throw new Error(`Expected exactly one complete <${MANUAL_QA_FIX_BEADS_TAG}> tagged YAML response.`)
  }
  const candidate = collectTaggedCandidates(raw, MANUAL_QA_FIX_BEADS_TAG)[0]
  if (!candidate) throw new Error('Manual QA fix-bead output was empty.')
  const parsed = CandidateDocumentSchema.parse(parseYamlOrJsonCandidate(candidate))
  validateManualQaFixBeadCandidates(parsed.beads, groups)
  return parsed.beads
}

export function validateManualQaFixBeadCandidates(
  beads: ManualQaFixBeadCandidate[],
  groups: ManualQaFixGroup[],
): void {
  if (beads.length !== groups.length) {
    throw new Error(`Manual QA fix-bead count ${beads.length} does not match merge-group count ${groups.length}.`)
  }
  const groupIndexes = new Map(groups.map((group, index) => [group.groupId, index]))
  const seen = new Set<string>()
  for (const [index, bead] of beads.entries()) {
    const group = groups[index]
    if (!group || bead.groupId !== group.groupId) {
      throw new Error(`Manual QA fix bead ${index + 1} must use merge group ${group?.groupId ?? '[missing]'}.`)
    }
    if (seen.has(bead.groupId)) throw new Error(`Manual QA merge group ${bead.groupId} was returned more than once.`)
    seen.add(bead.groupId)
    if (unique(bead.prdRefs).length !== bead.prdRefs.length || !sameStringSet(bead.prdRefs, group.allowedPrdRefs)) {
      throw new Error(`Manual QA fix bead ${bead.groupId} must preserve exactly its supplied PRD references.`)
    }
    if (unique(bead.blockedByGroupIds).length !== bead.blockedByGroupIds.length) {
      throw new Error(`Manual QA fix bead ${bead.groupId} has duplicate dependencies.`)
    }
    for (const dependency of bead.blockedByGroupIds) {
      const dependencyIndex = groupIndexes.get(dependency)
      if (dependencyIndex === undefined) throw new Error(`Manual QA fix bead ${bead.groupId} depends on unknown group ${dependency}.`)
      if (dependencyIndex >= index) throw new Error(`Manual QA fix bead ${bead.groupId} may depend only on an earlier merge group.`)
    }
    for (const targetFile of bead.targetFiles) {
      if (!isProjectRelativePath(targetFile)) {
        throw new Error(`Manual QA fix bead ${bead.groupId} has invalid target file path "${targetFile}".`)
      }
    }
  }
}

function focusedDiffMetadata(worktreePath: string, baseBranch: string): string {
  const mergeBase = spawnSync('git', ['-C', worktreePath, 'merge-base', 'HEAD', baseBranch], {
    encoding: 'utf8',
    timeout: 30_000,
  })
  const base = mergeBase.status === 0 ? (mergeBase.stdout ?? '').trim() : ''
  if (!base) return 'Focused diff metadata unavailable.'
  const diff = spawnSync('git', [
    '-C', worktreePath,
    'diff', '--name-status', '--stat=120,80', `${base}..HEAD`,
    '--', '.', ':(top,exclude).ticket', ':(top,exclude).looptroop',
  ], { encoding: 'utf8', timeout: 30_000 })
  return diff.status === 0
    ? ((diff.stdout ?? '').trim().slice(0, 80_000) || 'No candidate file metadata was reported.')
    : 'Focused diff metadata unavailable.'
}

export function hasSuccessfulManualQaRepositoryToolCall(messages: Message[]): boolean {
  return messages.some((message) => message.parts?.some((part) =>
    part.type === 'tool'
    && (part as { state?: { status?: string } }).state?.status === 'completed',
  ))
}

function buildFixBeadsPrompt(input: {
  context: TicketContext
  ticketDescription: string
  prd: string
  existingBeads: Bead[]
  checklist: ManualQaChecklist
  draft: ManualQaDraft
  evidence: ManualQaEvidenceRef[]
  groups: ManualQaFixGroup[]
  finalTestReport: string
  diffMetadata: string
}): string {
  const itemById = new Map(input.checklist.items.map((item) => [item.id, item]))
  const evidenceById = new Map(input.evidence.map((entry) => [entry.id, entry]))
  const groupContext = input.groups.map((group) => ({
    groupId: group.groupId,
    allowedPrdRefs: group.allowedPrdRefs,
    failedItems: group.results.map((result) => ({
      checklistItem: itemById.get(result.itemId),
      observation: result.observation,
      note: result.note,
      links: result.links,
      evidence: result.evidenceIds.map((id) => evidenceById.get(id)).filter(Boolean).map((entry) => ({
        originalName: entry!.originalName,
        mediaType: entry!.mediaType,
        size: entry!.size,
        sha256: entry!.sha256,
      })),
    })),
  }))
  return buildPromptFromTemplate(PROM_MANUAL_QA_FIX_BEADS, [
    { type: 'text', source: 'ticket_details', content: JSON.stringify({
      id: input.context.externalId,
      title: input.context.title,
      description: input.ticketDescription,
    }, null, 2) },
    { type: 'text', source: 'prd', content: input.prd },
    { type: 'text', source: 'beads', content: JSON.stringify(input.existingBeads.map((bead) => ({
      id: bead.id,
      title: bead.title,
      description: bead.description,
      prdRefs: bead.prdRefs,
      contextGuidance: bead.contextGuidance,
      acceptanceCriteria: bead.acceptanceCriteria,
      tests: bead.tests,
      testCommands: bead.testCommands,
      ...(bead.testCommandReason ? { testCommandReason: bead.testCommandReason } : {}),
      labels: bead.labels,
      dependencies: bead.dependencies,
      targetFiles: bead.targetFiles,
    })), null, 2) },
    { type: 'text', source: 'final_test_report', content: input.finalTestReport || 'No final-test report was stored.' },
    { type: 'text', source: 'manual_qa_results', content: JSON.stringify(groupContext, null, 2) },
    { type: 'text', source: 'focused_diff', content: input.diffMetadata || 'No focused diff metadata was available.' },
  ])
}

export interface GenerateManualQaFixBeadsInput {
  ticketId: string
  context: TicketContext
  checklist: ManualQaChecklist
  draft: ManualQaDraft
  evidence: ManualQaEvidenceRef[]
  existingBeads: Bead[]
  signal?: AbortSignal
}

export async function generateManualQaFixBeadCandidates(
  input: GenerateManualQaFixBeadsInput,
): Promise<ManualQaFixBeadCandidate[]> {
  const paths = getTicketPaths(input.ticketId)
  const ticket = getTicketByRef(input.ticketId)
  if (!paths || !ticket) throw new Error(`Ticket storage was not found: ${input.ticketId}`)
  const groups = buildManualQaFixGroups(input.checklist, input.draft)
  if (groups.length === 0) return []
  const model = input.context.lockedMainImplementer?.trim()
  if (!model) throw new Error('Manual QA fix-bead generation requires the locked main implementer model.')
  const prdPath = resolve(paths.ticketDir, 'prd.yaml')
  if (!existsSync(prdPath)) throw new Error('Approved PRD is required for Manual QA fix-bead generation.')
  const finalTestReport = getLatestPhaseArtifact(input.ticketId, 'final_test_report', 'RUNNING_FINAL_TEST')?.content ?? ''
  const prompt = buildFixBeadsPrompt({
    context: input.context,
    ticketDescription: ticket.description ?? '',
    prd: readFileSync(prdPath, 'utf8'),
    existingBeads: input.existingBeads,
    checklist: input.checklist,
    draft: input.draft,
    evidence: input.evidence,
    groups,
    finalTestReport,
    diffMetadata: focusedDiffMetadata(paths.worktreePath, ticket.runtime.baseBranch),
  })
  const phase = 'WAITING_MANUAL_QA'
  const phaseAttempt = resolvePhaseAttempt(input.ticketId, phase)
  const timeoutMs = resolveAiResponseRuntimeSettings(input.context).timeoutMs
  const maxRetries = resolveStructuredRetryRuntimeSettings(input.context).structuredRetryCount
  let correction = ''
  let lastError = 'Manual QA fix-bead generation failed.'
  let observedSuccessfulTool = false

  emitAiMilestone(input.ticketId, input.context.externalId, phase, 'Generating execution-ready beads for failed Manual QA checks.', 'fix-beads-started')
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    let sessionId = ''
    const streamState = createOpenCodeStreamState()
    const result = await runOpenCodePrompt({
      adapter,
      projectPath: paths.worktreePath,
      parts: [{ type: 'text', content: `${prompt}${correction}` }],
      signal: input.signal,
      timeoutMs,
      timeoutKind: 'ai_response',
      model,
      variant: input.context.lockedMainImplementerVariant ?? undefined,
      toolPolicy: PROM_MANUAL_QA_FIX_BEADS.toolPolicy,
      sessionOwnership: {
        ticketId: input.ticketId,
        phase,
        phaseAttempt,
        memberId: model,
        step: attempt === 0 ? 'generate-fix-beads' : `fix-beads-structured-retry-${attempt}`,
        forceFresh: attempt > 0,
      },
      onSessionCreated: (session) => { sessionId = session.id },
      onPromptDispatched: (event) => emitOpenCodePromptLog(input.ticketId, input.context.externalId, phase, model, event),
      onStreamEvent: (event: StreamEvent) => {
        if (event.type === 'tool' && event.status === 'completed') observedSuccessfulTool = true
        if (sessionId) emitOpenCodeStreamEvent(input.ticketId, input.context.externalId, phase, model, sessionId, event, streamState)
      },
    })
    observedSuccessfulTool ||= hasSuccessfulManualQaRepositoryToolCall(result.messages)
    emitOpenCodeSessionLogs(
      input.ticketId,
      input.context.externalId,
      phase,
      model,
      result.session.id,
      'Manual QA fix-bead generation',
      result.response,
      result.messages,
      streamState,
    )
    try {
      if (!observedSuccessfulTool) throw new Error('The model did not complete the required read-only repository inspection tool call.')
      const parsed = parseManualQaFixBeadsOutput(result.response, groups)
      emitAiMilestone(input.ticketId, input.context.externalId, phase, `Validated ${parsed.length} Manual QA fix bead candidate${parsed.length === 1 ? '' : 's'}.`, 'fix-beads-validated')
      return parsed
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      correction = [
        '\n\n## Structured-output correction',
        `The previous attempt was invalid: ${lastError}`,
        'Perform a successful focused read-only repository inspection if one has not completed, then return the corrected tagged YAML only.',
        'Previous invalid response:',
        result.response.slice(0, 50_000),
      ].join('\n')
    }
  }
  throw new Error(lastError)
}

export function persistManualQaFixBeadCandidates(
  ticketDir: string,
  version: number,
  candidates: ManualQaFixBeadCandidate[],
): string {
  const path = getManualQaStoragePaths(ticketDir, version).fixBeadsPath
  const content = buildYamlDocument({
    schemaVersion: 1,
    artifact: 'manual_qa_fix_beads',
    version,
    beads: candidates,
  })
  safeAtomicWrite(path, content)
  return content
}

export function readManualQaFixBeadCandidates(
  ticketDir: string,
  version: number,
  groups: ManualQaFixGroup[],
): ManualQaFixBeadCandidate[] | null {
  const path = getManualQaStoragePaths(ticketDir, version).fixBeadsPath
  if (!existsSync(path)) return null
  const parsed = PersistedCandidateDocumentSchema.parse(jsYaml.load(readFileSync(path, 'utf8')))
  if (parsed.version !== version) throw new Error('Persisted Manual QA fix beads belong to a different version.')
  validateManualQaFixBeadCandidates(parsed.beads, groups)
  return parsed.beads
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

export function hydrateManualQaFixBeads(input: {
  candidates: ManualQaFixBeadCandidate[]
  groups: ManualQaFixGroup[]
  existing: Bead[]
  checklist: ManualQaChecklist
  evidence: ManualQaEvidenceRef[]
  ticketId: string
  externalId: string
  version: number
  actionId: string
  modelCapability: ManualQaModelCapabilitySnapshot
}): Bead[] {
  const itemById = new Map(input.checklist.items.map((item) => [item.id, item]))
  const candidateByGroup = new Map(input.candidates.map((candidate) => [candidate.groupId, candidate]))
  const idByGroup = new Map(input.groups.map((group) => [
    group.groupId,
    deterministicId(`qa-v${input.version}`, `${input.ticketId}:${input.version}:${group.groupId}`),
  ]))
  const maxPriority = input.existing.reduce((max, bead) => Math.max(max, bead.priority), 0)
  const now = new Date().toISOString()
  const beads = input.groups.map((group, index): Bead => {
    const candidate = candidateByGroup.get(group.groupId)!
    const sourceItems: QaOriginSourceItem[] = group.results.map((result) => {
      const item = itemById.get(result.itemId)!
      const evidenceIds = new Set(result.evidenceIds)
      return {
        itemId: item.id,
        lineageId: item.lineageId,
        behavior: item.behavior,
        observation: result.observation,
        expectedResult: item.expectedResult,
        evidence: input.evidence.filter((entry) => evidenceIds.has(entry.id)).map((entry) => ({
          id: entry.id,
          originalName: entry.originalName,
          mediaType: entry.mediaType,
          size: entry.size,
          sha256: entry.sha256,
          relativePath: getManualQaEvidenceRelativePath(input.version, entry),
        })),
        links: result.links,
      }
    })
    const origin: QaOrigin = {
      schemaVersion: 1,
      actionId: input.actionId,
      sourceTicketId: input.ticketId,
      sourceTicketExternalId: input.externalId,
      version: input.version,
      modelId: input.modelCapability.modelId,
      modelSupportsImages: input.modelCapability.supportsImages,
      createdFromManualQaAt: now,
      sourceItems,
      imageDelivery: input.modelCapability.imageEvidenceMode,
    }
    const id = idByGroup.get(group.groupId)!
    return {
      id,
      title: candidate.title,
      prdRefs: candidate.prdRefs,
      description: candidate.description,
      contextGuidance: candidate.contextGuidance,
      acceptanceCriteria: candidate.acceptanceCriteria,
      tests: candidate.tests,
      testCommands: candidate.testCommands,
      ...(candidate.testCommandReason ? { testCommandReason: candidate.testCommandReason } : {}),
      priority: maxPriority + index + 1,
      status: 'pending',
      issueType: 'qa-fix',
      externalRef: input.externalId,
      labels: unique(['manual-looptroop-qa', ...candidate.labels]),
      dependencies: {
        blocked_by: candidate.blockedByGroupIds.map((groupId) => idByGroup.get(groupId)!),
        blocks: [],
      },
      targetFiles: candidate.targetFiles,
      failedIterationNotes: [],
      userRetryNotes: [],
      finalizationFailureNotes: [],
      iteration: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: '',
      startedAt: '',
      beadStartCommit: null,
      qaOrigin: origin,
    }
  })
  const byId = new Map(beads.map((bead) => [bead.id, bead]))
  for (const bead of beads) {
    for (const dependencyId of bead.dependencies.blocked_by) {
      byId.get(dependencyId)?.dependencies.blocks.push(bead.id)
    }
  }
  return beads
}
