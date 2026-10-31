import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { CouncilMember, DraftPhaseResult, DraftProgressEvent } from '../../council/types'
import { generateDrafts } from '../../council/drafter'
import { buildPromptFromTemplate, PROM20, PROM21, PROM22 } from '../../prompts/index'
import type { Message, PromptPart, StreamEvent } from '../../opencode/types'
import { buildMinimalContext } from '../../opencode/contextBuilder'
import type { TicketState } from '../../opencode/contextBuilder'
import type { OpenCodePromptDispatchEvent } from '../../workflow/runOpenCodePrompt'
import { normalizeBeadSubsetYamlOutput } from '../../structuredOutput'
import { attachStructuredRetryDiagnostic, buildStructuredRetryDiagnostic } from '../../lib/structuredRetryDiagnostics'

/** Build a context builder that returns PROM21 (vote) or PROM22 (refine) context. */
export function buildBeadsContextBuilder(ticketState: TicketState) {
  return (step: 'vote' | 'refine'): PromptPart[] => {
    const template = step === 'vote' ? PROM21 : PROM22
    const contextPhase = step === 'vote' ? 'beads_vote' : 'beads_refine'
    return [{ type: 'text', content: buildPromptFromTemplate(template, buildMinimalContext(contextPhase, ticketState)) }]
  }
}

export async function draftBeads(
  adapter: OpenCodeAdapter,
  members: CouncilMember[],
  ticketContext: PromptPart[],
  projectPath: string,
  options: {
    draftTimeoutMs: number
    minQuorum: number
    maxStructuredRetries?: number
    ticketId?: string
    phaseAttempt?: number
  },
  signal?: AbortSignal,
  onOpenCodeSessionLog?: (entry: {
    stage: 'draft' | 'vote' | 'refine'
    memberId: string
    sessionId: string
    response: string
    messages: Message[]
  }) => void,
  onOpenCodeStreamEvent?: (entry: {
    stage: 'draft'
    memberId: string
    sessionId: string
    event: StreamEvent
  }) => void,
  onOpenCodePromptDispatched?: (entry: {
    stage: 'draft'
    memberId: string
    event: OpenCodePromptDispatchEvent
  }) => void,
  onDraftProgress?: (entry: DraftProgressEvent) => void,
): Promise<DraftPhaseResult> {
  const promptContent = buildPromptFromTemplate(PROM20, ticketContext)

  const draftRun = await generateDrafts(
    adapter,
    members,
    [{ type: 'text', content: promptContent }],
    projectPath,
    options.draftTimeoutMs,
    signal,
    onOpenCodeSessionLog,
    onOpenCodeStreamEvent,
    onDraftProgress,
    (content) => {
      const result = normalizeBeadSubsetYamlOutput(content, undefined, { repoRoot: projectPath })
      if (!result.ok) {
        throw attachStructuredRetryDiagnostic(
          new Error(result.error),
          result.retryDiagnostic ?? buildStructuredRetryDiagnostic({
            attempt: 1,
            rawResponse: content,
            validationError: result.error,
          }),
        )
      }
      return {
        normalizedContent: result.normalizedContent,
        repairApplied: result.repairApplied,
        repairWarnings: result.repairWarnings,
        draftMetrics: {
          beadCount: result.value.length,
          totalTestCount: result.value.reduce((sum: number, s: { tests: string[] }) => sum + s.tests.length, 0),
          totalAcceptanceCriteriaCount: result.value.reduce((sum: number, s: { acceptanceCriteria: string[] }) => sum + s.acceptanceCriteria.length, 0),
        },
      }
    },
    {
      ticketId: options.ticketId,
      phase: 'DRAFTING_BEADS',
      phaseAttempt: options.phaseAttempt,
      toolPolicy: PROM20.toolPolicy,
      onPromptDispatched: onOpenCodePromptDispatched,
      maxStructuredRetries: options.maxStructuredRetries,
      structuredRetrySchemaReminder: PROM20.outputFormat,
    },
  )

  return {
    phase: 'beads_draft',
    drafts: draftRun.drafts,
    memberOutcomes: draftRun.memberOutcomes,
    deadlineReached: draftRun.deadlineReached,
  }
}
