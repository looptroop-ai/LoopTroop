import { useEffect, useMemo, useState } from 'react'
import * as jsYaml from 'js-yaml'
import { commandSpecSchema, renderCommandSpec, type CommandSpec } from '@shared/commandSpec'
import { Trophy, Lightbulb } from 'lucide-react'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { ModelBadge, ModelIcon } from '@/components/shared/ModelBadge'
import { cn } from '@/lib/utils'
import { useLogs } from '@/context/useLogContext'
import type {
  ArtifactStructuredOutputData,
  CoverageArtifactData,
  CoverageGapResolutionData,
  CoverageTransitionData,
  InterviewArtifactData,
  InterviewArtifactQuestion,
  InterviewDiffArtifactData,
  InterviewDiffEntry,
  CoverageInputData,
  CouncilResultData,
  CouncilVoterDetailData,
  CouncilOutcome,
  InspirationDiffSource,
  RefinementDiffEntry,
} from './phaseArtifactTypes'
import {
  tryParseStructuredContent,
  tryParseCouncilResult,
  normalizeInterviewDiffQuestions,
  buildInterviewDiffEntries,
  buildQuestionDiffSegments,
  buildRefinementDiffEntries,
  parseCoverageArtifact,
  parseInterviewQuestions,
  parseRefinementArtifact,
} from './phaseArtifactTypes'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { parseInterviewDocument, normalizeInterviewDocumentLike } from '@/lib/interviewDocument'
import { renderWordDiffSegments } from './diffWordHighlights'
import { InterviewDocumentView } from './InterviewDocumentView'
import {
  getCouncilStatusLabel,
} from './councilArtifacts'
import { CouncilStatusIcon } from './CouncilStatusIcon'
import {
  hasArtifactProcessingNotice,
} from './artifactProcessingNotice'
import type {
  ArtifactProcessingKind,
  ArtifactProcessingNoticeContext,
} from './artifactProcessingNotice'
import { buildReadableRawDisplayContent } from './rawDisplayContent'
import { CopyButton, RawContentWithCopy, RawDisplayPre, RawDisplayStats } from './RawTextDisplay'
import { ManualQaOriginBadge, ManualQaOriginCard } from './ManualQaOriginCard'
import { parsePrdDocument, PRD_TECHNICAL_SECTION_CONFIG } from '@/lib/prdDocument'
import { parseBeadsArtifact, type RawBead } from '@/lib/beadsDocument'
import { isRenderableManualQaOrigin } from '@/lib/artifactFieldShape'
import { CollapsibleSection } from './artifactViewers/CollapsibleSection'
import { TextCopyButton } from './artifactViewers/TextCopyButton'
import { WithRawTab } from './artifactViewers/WithRawTab'
import {
  useActiveRawVariant,
  type RawContentSource,
  type RawContentVariant,
} from './artifactViewers/rawContentSources'
import { RawAttemptVariantSelector } from './artifactViewers/WithRawTab'
import { StatPill, StatPillRow } from './artifactViewers/StatPillRow'
import { LabeledSubsection, SubsectionLabel } from './artifactViewers/LabeledSubsection'
import {
  buildDraftRawLogFallbacks,
  buildDraftRawLogHistories,
  buildDraftRawSources,
  buildRawAttemptSource,
  buildRawAttemptVariants,
  buildRejectedRawVariant,
  buildVoteRawLogHistories,
  dedupeRawContentVariants,
  formatRawAttemptSourceLabel,
  formatRejectedRawVariantLabel,
  formatValidatedRawVariantLabel,
  getRawAttemptsFromContent,
  getRejectedDraftRawResponse,
  getRejectedRawAttempt,
  getRejectedVoteRawResponse,
  getValidatedDraftContent,
  hasStructuredRetryMetadata,
  isFailedCouncilDraftOutcome,
  shouldShowValidatedDraftRawOnly,
  withDraftRawLogFallback,
} from './artifactViewers/rawAttempts'
import { CouncilDraftFailureDiagnostics } from './artifactViewers/CouncilDraftFailureDiagnostics'
import { RawContentView } from './artifactViewers/RawContentView'
import { CoverageResultView, CleanCoverageCallout } from './artifactViewers/coverageViews'
import { getCoverageCandidateLabel } from './artifactViewers/coverageSummary'
import { RelevantFilesScanView } from './artifactViewers/relevantFilesView'
import {
  ExecutionSetupPlanView,
  ExecutionSetupProfileView,
  ExecutionSetupReportView,
  ExecutionSetupRuntimeView,
} from './artifactViewers/executionSetupViews'
import { FinalTestResultsView } from './artifactViewers/finalTestView'
import { IntegrationReportView } from './artifactViewers/integrationReportView'
import { PullRequestReportView } from './artifactViewers/pullRequestViews'
import { CleanupReportView } from './artifactViewers/cleanupReportView'
import { PreFlightReportView } from './artifactViewers/preFlightReportView'
import { BeadCommitsDiffView } from './artifactViewers/beadDiffViews'
import { ManualQaChecklistArtifactView } from './artifactViewers/manualQaViews'
import { parseManualQaArtifactChecklist, readManualQaProcessingMetadata } from './artifactViewers/manualQaArtifact'
import { ArtifactProcessingNotice } from './artifactViewers/ArtifactProcessingNotice'
import { mergeStructuredOutputMetadata, withRawNormalizationNotice } from './artifactViewers/artifactProcessingMetadata'

// The primitives above moved into `./artifactViewers/` so the small components
// that need only one of them stop pulling this module in. They stay re-exported
// here because `PhaseArtifactsPanel` and the artifact tests import them from
// this path.
export { CollapsibleSection, TextCopyButton, WithRawTab, RawContentView, ArtifactProcessingNotice }
export { CopyButton }

const COVERAGE_ATTRIBUTION_HIDDEN_PHASES = new Set([
  'VERIFYING_INTERVIEW_COVERAGE',
  'WAITING_INTERVIEW_APPROVAL',
  'VERIFYING_PRD_COVERAGE',
  'WAITING_PRD_APPROVAL',
  'VERIFYING_BEADS_COVERAGE',
  'EXPANDING_BEADS',
  'WAITING_BEADS_APPROVAL',
])

function shouldHideCoverageAttributionUi(phase?: string): boolean {
  return phase ? COVERAGE_ATTRIBUTION_HIDDEN_PHASES.has(phase) : false
}

function RefinedArtifactTabs({ content, hasChanges, sectionsContent, diffContent, notice, diffLabel = 'Diff', defaultTab, showDiffTab = true }: {
  content: string
  hasChanges: boolean
  sectionsContent: React.ReactNode
  diffContent?: React.ReactNode
  notice?: React.ReactNode
  diffLabel?: string
  defaultTab?: 'sections' | 'diff' | 'raw'
  showDiffTab?: boolean
}) {
  const hasDiffTab = showDiffTab && hasChanges && Boolean(diffContent)
  const [activeTab, setActiveTab] = useState<'sections' | 'diff' | 'raw'>(defaultTab ?? (hasDiffTab ? 'diff' : 'sections'))
  const currentTab = activeTab === 'raw' ? 'raw' : (hasDiffTab ? activeTab : 'sections')
  const rawDisplayContent = useMemo(() => buildReadableRawDisplayContent(content), [content])

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <div className="flex items-center gap-2">
        <div className="inline-flex items-center gap-1 rounded-md border border-border bg-background p-1 shrink-0 ml-auto">
          <button
            onClick={() => setActiveTab('sections')}
            className={currentTab === 'sections'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            Sections
          </button>
          {hasDiffTab && (
            <button
              onClick={() => setActiveTab('diff')}
            className={currentTab === 'diff'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
            >
              {diffLabel}
            </button>
          )}
          <button
            onClick={() => setActiveTab('raw')}
            className={currentTab === 'raw'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            Raw
          </button>
          {currentTab === 'raw' && <CopyButton content={content} />}
        </div>
      </div>

      {currentTab === 'sections' ? notice : null}

      {currentTab === 'raw' && (
        <RawDisplayStats content={rawDisplayContent} />
      )}

      {currentTab === 'sections' ? (
        <>
          {sectionsContent}
        </>
      ) : currentTab === 'diff' && diffContent ? (
        <>
          {diffContent}
        </>
      ) : currentTab === 'raw' ? (
        <RawDisplayPre content={rawDisplayContent} />
      ) : null}
    </div>
  )
}

interface InterviewAnswerViewItem {
  id: string | number
  q: string
  answer: string | null
  selectedOptions: string[]
  isSkipped: boolean
}

interface LegacyInterviewSnapshotQuestion {
  id?: string
  prompt?: string
  answerType?: string
}

interface LegacyInterviewSnapshotAnswer {
  skipped?: boolean
  answer?: string
  selectedOptionIds?: string[]
  answeredAt?: string
}

interface LegacyInterviewSnapshot {
  questions: LegacyInterviewSnapshotQuestion[]
  answers?: Record<string, LegacyInterviewSnapshotAnswer>
  artifact?: unknown
}

function isLegacyInterviewSnapshot(value: unknown): value is LegacyInterviewSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (!('questions' in value) || !Array.isArray(value.questions)) return false
  return !('artifact' in value)
}

function getSelectedOptionLabels(question: InterviewArtifactQuestion): string[] {
  const selectedOptionIds = Array.isArray(question.answer?.selected_option_ids)
    ? question.answer.selected_option_ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : []
  if (selectedOptionIds.length === 0) return []

  const labelMap = new Map(
    (Array.isArray(question.options) ? question.options : []).flatMap((option) => {
      if (!option || typeof option !== 'object') return []
      const id = typeof option.id === 'string' && option.id.trim().length > 0 ? option.id : null
      const label = typeof option.label === 'string' && option.label.trim().length > 0 ? option.label : null
      return id && label ? [[id, label] as const] : []
    }),
  )

  return selectedOptionIds.map((id) => labelMap.get(id) ?? id)
}

function InterviewDraftView({ content }: { content: string }) {
  const questions = parseInterviewQuestions(content)

  if (questions.length === 0) return null
  const grouped = questions.reduce<Record<string, string[]>>((acc, { q, section }) => {
    const key = section || 'Questions'
      ; (acc[key] ??= []).push(q)
    return acc
  }, {})
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground mb-2">{questions.length} questions total</div>
      {Object.entries(grouped).map(([section, qs]) => (
        <CollapsibleSection key={section} title={<span>{section} <span className="text-muted-foreground">({qs.length})</span></span>} defaultOpen>
          <ol className="list-decimal list-inside space-y-1.5">
            {qs.map((q, i) => <li key={i} className="text-xs">{q}</li>)}
          </ol>
        </CollapsibleSection>
      ))}
    </div>
  )
}

function InterviewInspirationTooltip({ inspiration }: { inspiration: InspirationDiffSource }) {
  const modelName = inspiration.memberId ? getModelDisplayName(inspiration.memberId) : 'Unknown model'
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex shrink-0 items-center justify-center h-4 w-4 rounded-sm hover:bg-accent/60 transition-colors"
            onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
          >
            <Lightbulb className="h-3 w-3 text-amber-500" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="space-y-1">
            <div className="font-medium">Inspired by {modelName}</div>
            {inspiration.question && (
              <div className="text-[11px] opacity-90 leading-snug">{inspiration.question}</div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function getRefinementInspirationBlockKindLabel(kind: 'epic' | 'user_story' | 'bead'): string {
  if (kind === 'epic') return 'Epic'
  if (kind === 'user_story') return 'User Story'
  return 'Bead'
}

function inferRefinementInspirationBlockKind(
  itemKind: string,
  sourceId?: string,
): 'epic' | 'user_story' | 'bead' | null {
  if (itemKind === 'epic' || itemKind === 'user_story' || itemKind === 'bead') {
    return itemKind
  }
  if (sourceId?.startsWith('EPIC-')) return 'epic'
  if (sourceId?.startsWith('US-')) return 'user_story'
  return null
}

function buildRefinementTooltipBlocks(
  inspiration: NonNullable<RefinementDiffEntry['inspiration']>,
  itemKind: string,
): Array<{
  kind: 'epic' | 'user_story' | 'bead'
  id?: string
  label: string
  text: string
}> {
  if (Array.isArray(inspiration.blocks) && inspiration.blocks.length > 0) {
    return inspiration.blocks
  }

  const text = inspiration.sourceText?.trim() || inspiration.sourceLabel?.trim() || ''
  const label = inspiration.sourceLabel?.trim() || inspiration.sourceId?.trim() || ''
  const kind = inferRefinementInspirationBlockKind(itemKind, inspiration.sourceId)
  if (!text || !label || !kind) return []

  return [{
    kind,
    label,
    text,
    ...(inspiration.sourceId ? { id: inspiration.sourceId } : {}),
  }]
}

function RefinementInspirationTooltip({
  inspiration,
  itemKind,
}: {
  inspiration: NonNullable<RefinementDiffEntry['inspiration']>
  itemKind: string
}) {
  const modelName = inspiration.memberId ? getModelDisplayName(inspiration.memberId) : 'Unknown model'
  const blocks = buildRefinementTooltipBlocks(inspiration, itemKind)
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex shrink-0 items-center justify-center h-4 w-4 rounded-sm hover:bg-accent/60 transition-colors"
            onClick={(e) => { e.preventDefault(); e.stopPropagation() }}
          >
            <Lightbulb className="h-3 w-3 text-amber-500" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-md border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="space-y-2">
            <div className="font-medium">Inspired by {modelName}</div>
            {blocks.length > 0 && (
              <div className="max-h-72 overflow-y-auto pr-1 space-y-2">
                {blocks.map((block) => (
                  <div key={`${block.kind}:${block.id ?? block.label}`} className="rounded-sm border border-border/80 bg-muted/70 px-2 py-1.5 text-foreground">
                    <SubsectionLabel>
                      {getRefinementInspirationBlockKindLabel(block.kind)}
                      {block.id ? <span className="ml-1 font-mono normal-case tracking-normal">{block.id}</span> : null}
                    </SubsectionLabel>
                    <div className="text-[11px] leading-snug whitespace-pre-wrap break-words">
                      {block.text}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

type DiffAttributionStatus = NonNullable<InterviewDiffEntry['attributionStatus'] | RefinementDiffEntry['attributionStatus']>

function shouldShowChangeAttributionBadge(
  status: DiffAttributionStatus | undefined,
  hideCoverageAttributionUi: boolean,
): status is DiffAttributionStatus {
  if (!status || status === 'inspired') return false
  if (hideCoverageAttributionUi && status === 'model_unattributed') return false
  return true
}

function getDiffAttributionCopy(status: DiffAttributionStatus): { label: string; description: string; className: string } {
  if (status === 'synthesized_unattributed') {
    return {
      label: 'Auto-detected diff',
      description: 'This diff entry was synthesized during validation because the winner and final artifacts differed, but no reliable inspiration source was recorded.',
      className: 'border-amber-200 bg-amber-50/70 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100',
    }
  }

  if (status === 'invalid_unattributed') {
    return {
      label: 'Attribution cleared',
      description: 'This change originally carried attribution data, but that source information could not be validated and was cleared.',
      className: 'border-rose-200 bg-rose-50/70 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/20 dark:text-rose-100',
    }
  }

  return {
    label: 'No source recorded',
    description: 'The model did not attribute this change to an alternative draft. This is common for editorial rewrites, removals, and other unattributed edits.',
    className: 'border-border bg-muted/40 text-foreground',
  }
}

function ChangeAttributionBadge({ status }: { status: DiffAttributionStatus }) {
  const copy = getDiffAttributionCopy(status)

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${copy.className}`}>
            {copy.label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs">
          <div className="space-y-1">
            <div className="font-medium">{copy.label}</div>
            <div className="text-[11px] opacity-90 leading-snug">{copy.description}</div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

function getCouncilDraftNoticeKind({
  isFullAnswers,
  isInterview,
  isPrd,
  isBeads,
}: {
  isFullAnswers: boolean
  isInterview: boolean
  isPrd: boolean
  isBeads: boolean
}): ArtifactProcessingKind {
  if (isFullAnswers) return 'full-answers'
  if (isPrd) return 'prd-draft'
  if (isBeads) return 'beads-draft'
  if (isInterview) return 'interview-draft'
  return 'draft'
}

function getFullAnswersNoticeContext(content: string): ArtifactProcessingNoticeContext | undefined {
  const document = parseInterviewDocument(content)
  if (!document) {
    return undefined
  }

  const allAnswersAreUserOwned = document.questions.every((question) => question.answer?.answered_by && question.answer.answered_by !== 'ai_skip')
  if (
    document.status === 'draft'
    && !document.approval.approved_by
    && !document.approval.approved_at
    && allAnswersAreUserOwned
  ) {
    return { fullAnswersOrigin: 'reused-approved-interview' }
  }

  return undefined
}

function RefinementDiffView({ content, domain, phase }: { content: string; domain: 'prd' | 'beads'; phase?: string }) {
  const diffs = buildRefinementDiffEntries(content, domain)
  const hideCoverageAttributionUi = shouldHideCoverageAttributionUi(phase)
  const modifiedCount = diffs.filter((d) => d.changeType === 'modified').length
  const addedCount = diffs.filter((d) => d.changeType === 'added').length
  const removedCount = diffs.filter((d) => d.changeType === 'removed').length

  if (diffs.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        No refinement changes recorded.
      </div>
    )
  }

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <StatPillRow>
        <StatPill>Modified {modifiedCount}</StatPill>
        <StatPill>Added {addedCount}</StatPill>
        <StatPill>Removed {removedCount}</StatPill>
      </StatPillRow>
      <div className="space-y-2">
        {diffs.map((diff) => (
          <CollapsibleSection
            key={diff.key}
            defaultOpen
            title={(
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground text-[10px] uppercase">{formatRefinementDiffItemKind(diff.itemKind)}</span>
                <span>{diff.label || diff.afterId || diff.beforeId || formatRefinementDiffItemKind(diff.itemKind)}</span>
                {(diff.afterId || diff.beforeId) && diff.label !== (diff.afterId || diff.beforeId) && (
                  <span className="font-mono text-[10px] text-muted-foreground">{diff.afterId || diff.beforeId}</span>
                )}
                <span className={diff.changeType === 'added'
                  ? 'text-green-600 dark:text-green-400'
                  : diff.changeType === 'removed'
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-blue-600 dark:text-blue-400'}
                >
                  {diff.changeType === 'modified' ? 'Modified' : diff.changeType === 'added' ? 'Added' : 'Removed'}
                </span>
                {!hideCoverageAttributionUi && diff.inspiration
                  ? <RefinementInspirationTooltip inspiration={diff.inspiration} itemKind={diff.itemKind} />
                  : shouldShowChangeAttributionBadge(diff.attributionStatus, hideCoverageAttributionUi)
                    ? <ChangeAttributionBadge status={diff.attributionStatus} />
                    : null}
              </span>
            )}
          >
            <div className="space-y-3">
              {diff.beforeText && (
                <div className="group relative rounded-md border border-red-200 bg-red-100/80 px-3 py-2 dark:border-red-800/60 dark:bg-red-900/30">
                  <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-red-700 dark:text-red-300">
                    <span>Before</span>
                    <TextCopyButton content={diff.beforeText} title="Copy before" />
                  </div>
                  <div className="text-xs leading-5 text-red-950 dark:text-red-100 whitespace-pre-wrap">
                    {diff.beforeId && <span className="font-mono mr-1">{diff.beforeId}:</span>}
                    {renderWordDiffSegments(buildQuestionDiffSegments(diff.beforeText, diff.afterText).before, 'removed')}
                  </div>
                </div>
              )}
              {diff.afterText && (
                <div className="group relative rounded-md border border-green-200 bg-green-100/80 px-3 py-2 dark:border-green-800/60 dark:bg-green-900/30">
                  <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-300">
                    <span>After</span>
                    <TextCopyButton content={diff.afterText} title="Copy after" />
                  </div>
                  <div className="text-xs leading-5 text-green-950 dark:text-green-100 whitespace-pre-wrap">
                    {diff.afterId && <span className="font-mono mr-1">{diff.afterId}:</span>}
                    {renderWordDiffSegments(buildQuestionDiffSegments(diff.beforeText, diff.afterText).after, 'added')}
                  </div>
                </div>
              )}
            </div>
          </CollapsibleSection>
        ))}
      </div>
    </div>
  )
}

function formatRefinementDiffItemKind(itemKind: string): string {
  if (!itemKind) return 'Item'
  if (itemKind === 'epic') return 'Epic'
  if (itemKind === 'user_story') return 'User Story'
  if (itemKind === 'bead') return 'Bead'
  if (itemKind === 'risks') return 'Risks'
  if (itemKind.startsWith('technical_requirements.')) return 'Technical Requirements'
  if (itemKind.startsWith('product.')) return 'Product'
  if (itemKind.startsWith('scope.')) return 'Scope'

  return itemKind
    .replace(/[._]+/g, ' ')
    .replace(/\b\w/g, (match) => match.toUpperCase())
}

function InterviewDraftDiffView({ content, phase }: { content: string; phase?: string }) {
  let parsed: InterviewDiffArtifactData | null = null
  try {
    parsed = JSON.parse(content) as InterviewDiffArtifactData
  } catch {
    return <RawContentView content={content} />
  }

  const diffs = buildInterviewDiffEntries(content)
  const hideCoverageAttributionUi = shouldHideCoverageAttributionUi(phase)
  const modifiedCount = diffs.filter((diff) => diff.changeType === 'modified').length
  const replacedCount = diffs.filter((diff) => diff.changeType === 'replaced').length
  const addedCount = diffs.filter((diff) => diff.changeType === 'added').length
  const removedCount = diffs.filter((diff) => diff.changeType === 'removed').length
  const winnerLabel = parsed?.winnerId ? getModelDisplayName(parsed.winnerId) : 'winning model'

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <div className="text-xs text-muted-foreground">
        Comparing winning draft from {winnerLabel} ({parsed?.originalQuestionCount ?? normalizeInterviewDiffQuestions(parsed?.originalContent).length} questions) with the final refined interview ({parsed?.refinedQuestionCount ?? normalizeInterviewDiffQuestions(parsed?.refinedContent).length} questions).
      </div>
      <StatPillRow>
        <StatPill>Modified {modifiedCount}</StatPill>
        <StatPill>Replaced {replacedCount}</StatPill>
        <StatPill>Added {addedCount}</StatPill>
        <StatPill>Removed {removedCount}</StatPill>
      </StatPillRow>
      {diffs.length === 0 ? (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          No differences detected between the winning draft and the final refined interview.
        </div>
      ) : (
        <div className="space-y-2">
          {diffs.map((diff) => {
            const questionDiff = buildQuestionDiffSegments(diff.before, diff.after)

            return (
                <CollapsibleSection
                  key={diff.key}
                  defaultOpen
                  title={(
                    <span className="flex items-center gap-2">
                      <span>{diff.id}</span>
                      {diff.phase ? <span className="text-muted-foreground">{diff.phase}</span> : null}
                      <span className={diff.changeType === 'added'
                        ? 'text-green-600 dark:text-green-400'
                        : diff.changeType === 'removed'
                          ? 'text-red-600 dark:text-red-400'
                          : diff.changeType === 'replaced'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-blue-600 dark:text-blue-400'}
                      >
                        {diff.changeType === 'modified'
                          ? 'Modified'
                          : diff.changeType === 'replaced'
                            ? 'Replaced'
                            : diff.changeType === 'added'
                              ? 'Added'
                              : 'Removed'}
                      </span>
                      {!hideCoverageAttributionUi && diff.inspiration
                        ? <InterviewInspirationTooltip inspiration={diff.inspiration} />
                        : shouldShowChangeAttributionBadge(diff.attributionStatus, hideCoverageAttributionUi)
                          ? <ChangeAttributionBadge status={diff.attributionStatus} />
                          : null}
                    </span>
                  )}
                >
                  <div className="space-y-3">
                    {diff.before && (
                      <div className="group relative rounded-md border border-red-200 bg-red-100/80 px-3 py-2 dark:border-red-800/60 dark:bg-red-900/30">
                        <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-red-700 dark:text-red-300">
                          <span>Before</span>
                          <TextCopyButton content={diff.before} title="Copy before" />
                        </div>
                        <div className="text-xs leading-5 text-red-950 dark:text-red-100">
                          {renderWordDiffSegments(questionDiff.before, 'removed')}
                        </div>
                      </div>
                    )}
                    {diff.after && (
                      <div className="group relative rounded-md border border-green-200 bg-green-100/80 px-3 py-2 dark:border-green-800/60 dark:bg-green-900/30">
                        <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-300">
                          <span>After</span>
                          <TextCopyButton content={diff.after} title="Copy after" />
                        </div>
                        <div className="text-xs leading-5 text-green-950 dark:text-green-100">
                          {renderWordDiffSegments(questionDiff.after, 'added')}
                        </div>
                      </div>
                    )}
                  </div>
                </CollapsibleSection>
            )
          })}
        </div>
      )}
    </div>
  )
}

function FinalInterviewArtifactView({
  content,
  header,
  hideAiAnswerBadge,
  showDiffTab = true,
  phase,
}: {
  content: string
  header?: React.ReactNode
  hideAiAnswerBadge?: boolean
  showDiffTab?: boolean
  phase?: string
}) {
  const [activeTab, setActiveTab] = useState<'final' | 'diff' | 'raw'>('final')
  const parsedContent = tryParseStructuredContent(content)
  if (parsedContent && typeof parsedContent === 'object') {
    const interviewArtifact = parsedContent as InterviewArtifactData
    const hasRefinementPayload = typeof (parsedContent as { refinedContent?: unknown }).refinedContent === 'string'
      || typeof (parsedContent as { originalContent?: unknown }).originalContent === 'string'
      || Array.isArray((parsedContent as { changes?: unknown }).changes)
    const notice = (
      <ArtifactProcessingNotice
        structuredOutput={(interviewArtifact as { structuredOutput?: ArtifactStructuredOutputData }).structuredOutput}
        kind="artifact"
      />
    )
    if (!hasRefinementPayload && typeof interviewArtifact.interview === 'string' && interviewArtifact.interview.trim()) {
      return (
        <WithRawTab content={interviewArtifact.interview} structuredLabel="Q&A" header={header} notice={notice}>
          <InterviewAnswersView content={interviewArtifact.interview} hideAiAnswerBadge={hideAiAnswerBadge} />
        </WithRawTab>
      )
    }
    if (!hasRefinementPayload && interviewArtifact.artifact === 'interview') {
      return (
        <WithRawTab content={content} structuredLabel="Q&A" header={header} notice={notice}>
          <InterviewAnswersView content={content} hideAiAnswerBadge={hideAiAnswerBadge} />
        </WithRawTab>
      )
    }
  }

  let parsed: (InterviewDiffArtifactData & { questionCount?: number; questions?: unknown[] }) | null = null
  try {
    parsed = JSON.parse(content) as InterviewDiffArtifactData & { questionCount?: number; questions?: unknown[] }
  } catch {
    return <RawContentWithCopy content={content} />
  }

  const refinedContent = parsed?.refinedContent ?? ''
  if (!refinedContent) return <RawContentWithCopy content={content} />

  const diffEntries = buildInterviewDiffEntries(content)
  const hasDiffTab = showDiffTab && Boolean(parsed?.originalContent)
  const currentTab = activeTab === 'raw' ? 'raw' : (hasDiffTab ? activeTab : 'final')
  const rawDisplayContent = buildReadableRawDisplayContent(content)
  const notice = <ArtifactProcessingNotice structuredOutput={parsed?.structuredOutput} kind="diff" />

  const tabButtonClass = (tab: string) =>
    currentTab === tab
      ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
      : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <div className="flex items-center gap-2">
        {header && <div className="flex-1 min-w-0">{header}</div>}
        <div className={`inline-flex items-center gap-1 rounded-md border border-border bg-background p-1 shrink-0 ${header ? 'ml-auto' : ''}`}>
          <button onClick={() => setActiveTab('final')} className={tabButtonClass('final')}>
            Final Questions
          </button>
          {hasDiffTab && (
            <button onClick={() => setActiveTab('diff')} className={tabButtonClass('diff')}>
              Diff{diffEntries.length > 0 ? ` (${diffEntries.length})` : ''}
            </button>
          )}
          <button onClick={() => setActiveTab('raw')} className={tabButtonClass('raw')}>
            Raw
          </button>
          {currentTab === 'raw' && <CopyButton content={content} />}
        </div>
      </div>
      {currentTab === 'final' ? notice : null}
      {currentTab === 'raw' ? (
        <div className="min-w-0 max-w-full space-y-3">
          <RawDisplayStats content={rawDisplayContent} />
          <RawDisplayPre content={rawDisplayContent} />
        </div>
      ) : currentTab === 'final'
        ? (
          <div className="space-y-3">
            <InterviewDraftView content={refinedContent} />
          </div>
        )
        : (
          <div className="space-y-3">
            <InterviewDraftDiffView content={content} phase={phase} />
          </div>
        )}
    </div>
  )
}

function FinalPrdDraftView({
  content,
  header,
  isBeads,
  defaultTab = 'final',
  showDiffTab,
  finalLabel,
  phase,
}: {
  content: string
  header?: React.ReactNode
  isBeads?: boolean
  defaultTab?: 'final' | 'diff' | 'raw'
  showDiffTab?: boolean
  finalLabel?: string
  phase?: string
}) {
  const [activeTab, setActiveTab] = useState<'final' | 'diff' | 'raw'>(defaultTab)

  const parsed = parseRefinementArtifact(content)
  const fallbackRawAttempts = useMemo(() => getRawAttemptsFromContent(content), [content])
  const rawAttempts = parsed?.rawAttempts ?? fallbackRawAttempts
  const rawAttemptSource = useMemo(
    () => buildRawAttemptSource(
      'raw-attempts',
      isBeads ? 'beads refinement' : 'PRD refinement',
      rawAttempts,
      parsed?.winnerId,
    ),
    [isBeads, parsed?.winnerId, rawAttempts],
  )
  const rawVariantOptions = useMemo(() => rawAttemptSource?.variants ?? [], [rawAttemptSource])
  const { activeRawVariant, setActiveRawVariantId } = useActiveRawVariant(rawVariantOptions, 'raw-attempts:accepted-latest')
  const activeRawContent = activeRawVariant?.content ?? content
  const activeRawDisplayContent = activeRawVariant?.displayContent ?? buildReadableRawDisplayContent(activeRawContent)
  const coverageResult = parseCoverageArtifact(content)
  const hasRawTab = rawVariantOptions.length > 0
  const rawVariantSelector = rawAttemptSource && rawVariantOptions.length > 0
    ? (
      <div className="flex min-w-0 max-w-full flex-wrap gap-1.5 overflow-hidden">
        <RawAttemptVariantSelector
          source={rawAttemptSource}
          activeVariantId={activeRawVariant?.id}
          onSelect={setActiveRawVariantId}
          ariaLabel="Raw refinement attempts"
        />
      </div>
      )
    : null

  if (!parsed) {
    return (
      <div className="min-w-0 max-w-full space-y-3">
        <div className="flex justify-end">
          <CopyButton content={activeRawContent} />
        </div>
        {rawVariantSelector}
        <RawDisplayStats content={activeRawDisplayContent} />
        <RawDisplayPre content={activeRawDisplayContent} />
      </div>
    )
  }

  const refinedContent = parsed?.refinedContent ?? ''
  if (!refinedContent) {
    return (
      <div className="min-w-0 max-w-full space-y-3">
        <div className="flex justify-end">
          <CopyButton content={activeRawContent} />
        </div>
        {rawVariantSelector}
        <RawDisplayStats content={activeRawDisplayContent} />
        <RawDisplayPre content={activeRawDisplayContent} />
      </div>
    )
  }

  const domain = isBeads ? 'beads' : 'prd'
  const diffEntries = buildRefinementDiffEntries(content, domain)
  const diffLabel = parsed?.coverageDiffLabel ?? 'Diff'
  const hideDiffInApproval = phase === 'WAITING_PRD_APPROVAL' || phase === 'WAITING_BEADS_APPROVAL'
  const shouldShowDiffTab = showDiffTab ?? !hideDiffInApproval
  const hasDiffTab = shouldShowDiffTab && (diffEntries.length > 0 || Boolean(parsed?.winnerDraftContent) || Boolean(parsed?.coverageBaselineContent))
  const currentTab = activeTab === 'raw'
    ? (hasRawTab ? 'raw' : 'final')
    : (hasDiffTab ? activeTab : 'final')
  const notice = <ArtifactProcessingNotice structuredOutput={parsed?.structuredOutput} kind="diff" />

  const tabButtonClass = (tab: string) =>
    currentTab === tab
      ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
      : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <div className="flex items-center gap-2">
        {header && <div className="flex-1 min-w-0">{header}</div>}
        <div className={`inline-flex items-center gap-1 rounded-md border border-border bg-background p-1 shrink-0 ${header ? 'ml-auto' : ''}`}>
          <button onClick={() => setActiveTab('final')} className={tabButtonClass('final')}>
            {finalLabel ?? `Final ${isBeads ? 'Blueprint' : 'PRD'}`}
          </button>
          {hasDiffTab && (
            <button onClick={() => setActiveTab('diff')} className={tabButtonClass('diff')}>
              {diffLabel}{diffEntries.length > 0 ? ` (${diffEntries.length})` : ''}
            </button>
          )}
          {hasRawTab && (
            <button onClick={() => setActiveTab('raw')} className={tabButtonClass('raw')}>
              Raw
            </button>
          )}
          {currentTab === 'raw' && <CopyButton content={activeRawContent} />}
        </div>
      </div>
      {currentTab === 'final' ? notice : null}
      {currentTab === 'raw' ? (
        <div className="min-w-0 max-w-full space-y-3">
          {rawVariantSelector}
          <RawDisplayStats content={activeRawDisplayContent} />
          <RawDisplayPre content={activeRawDisplayContent} />
        </div>
      ) : currentTab === 'final'
        ? (
          <div className="space-y-3">
            <CleanCoverageCallout coverageResult={coverageResult} phase={phase} fallbackCandidateVersion={parsed?.candidateVersion} />
            {isBeads ? <BeadsDraftView content={refinedContent} /> : <PrdDraftView content={refinedContent} />}
          </div>
        )
        : (
          <div className="space-y-3">
            <RefinementDiffView content={content} domain={domain} phase={phase} />
          </div>
        )}
    </div>
  )
}

function formatCoverageResolutionAction(action: CoverageGapResolutionData['action']): string {
  if (action === 'updated_prd') return 'Updated PRD'
  if (action === 'updated_beads') return 'Updated Plan'
  if (action === 'already_covered') return 'Already Covered'
  return 'Left Unresolved'
}

function getCoverageResolutionTone(action: CoverageGapResolutionData['action']): string {
  if (action === 'updated_prd') return 'border-green-200 bg-green-100/70 text-green-800 dark:border-green-800/60 dark:bg-green-900/30 dark:text-green-200'
  if (action === 'updated_beads') return 'border-green-200 bg-green-100/70 text-green-800 dark:border-green-800/60 dark:bg-green-900/30 dark:text-green-200'
  if (action === 'already_covered') return 'border-blue-200 bg-blue-100/70 text-blue-800 dark:border-blue-800/60 dark:bg-blue-900/30 dark:text-blue-200'
  return 'border-amber-200 bg-amber-100/70 text-amber-800 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-200'
}

function formatCoverageAffectedItem(item: CoverageGapResolutionData['affectedItems'][number]): string {
  if (item.itemType === 'epic') return `Epic ${item.id}: ${item.label}`
  if (item.itemType === 'user_story') return `User Story ${item.id}: ${item.label}`
  return `Bead ${item.id}: ${item.label}`
}

function CoverageResolutionNotesInner({
  content,
  phase,
  isBeads = false,
}: {
  content: string
  phase?: string
  isBeads?: boolean
}) {
  const parsed = parseRefinementArtifact(content)
  const gapResolutions = parsed?.gapResolutions ?? []
  if (!gapResolutions.length) return <RawContentWithCopy content={content} />

  const candidateVersionLabel = parsed?.candidateVersion
    ? `${isBeads ? 'Implementation Plan' : 'PRD Candidate'} v${parsed.candidateVersion}`
    : isBeads
      ? 'Implementation Plan'
      : 'PRD Candidate'
  const summaryText = phase === 'VERIFYING_PRD_COVERAGE' || phase === 'VERIFYING_BEADS_COVERAGE'
    ? `Latest notes about how coverage gaps were handled for ${candidateVersionLabel}.`
    : `Latest coverage-driven resolution notes for ${candidateVersionLabel}.`

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground">
        {summaryText}
      </div>
      {gapResolutions.map((resolution, index) => (
        <CollapsibleSection
          key={`${resolution.gap}:${index}`}
          defaultOpen
          title={(
            <span className="flex items-center gap-2 flex-wrap">
              <span className="font-medium">{resolution.gap}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${getCoverageResolutionTone(resolution.action)}`}>
                {formatCoverageResolutionAction(resolution.action)}
              </span>
            </span>
          )}
        >
          <div className="space-y-3">
            <div className="text-xs leading-5">{resolution.rationale}</div>
            <LabeledSubsection label="Affected Items">
              {resolution.affectedItems.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {resolution.affectedItems.map((item) => (
                    <span
                      key={`${resolution.gap}:${item.itemType}:${item.id}`}
                      className="rounded-full border border-border bg-background px-2 py-1 text-[10px] text-foreground"
                    >
                      {formatCoverageAffectedItem(item)}
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground">No directly affected items were recorded for this resolution.</div>
              )}
            </LabeledSubsection>
          </div>
        </CollapsibleSection>
      ))}
    </div>
  )
}

function buildCoverageTransitionArtifactContent(transition: CoverageTransitionData): string {
  return JSON.stringify({
    refinedContent: transition.toContent,
    candidateVersion: transition.toVersion,
    gapResolutions: transition.gapResolutions,
    coverageBaselineContent: transition.fromContent,
    coverageBaselineVersion: transition.fromVersion,
    coverageDiffLabel: `Diff v${transition.fromVersion} -> v${transition.toVersion}`,
    coverageUiRefinementDiff: transition.uiRefinementDiff ?? undefined,
    structuredOutput: transition.structuredOutput,
  })
}

function CoverageTransitionDetailsView({
  transition,
  phase,
}: {
  transition: CoverageTransitionData
  phase?: string
}) {
  const isBeads = phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL'
  const [activeTab, setActiveTab] = useState<'gaps' | 'notes' | 'diff'>('gaps')
  const artifactContent = buildCoverageTransitionArtifactContent(transition)
  const gapsHeading = `Coverage Gaps Found in ${getCoverageCandidateLabel(phase, transition.fromVersion)}`
  const tabs: Array<{ key: 'gaps' | 'notes' | 'diff'; label: string }> = [
    { key: 'gaps', label: 'Gaps Found' },
    ...(transition.gapResolutions.length > 0 || transition.resolutionNotes.length > 0
      ? [{ key: 'notes' as const, label: 'Resolution Notes' }]
      : []),
    { key: 'diff' as const, label: 'Diff' },
  ]
  const resolvedTab = tabs.find((tab) => tab.key === activeTab)?.key ?? tabs[0]?.key ?? 'gaps'

  return (
    <div className="space-y-3">
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px',
              resolvedTab === tab.key
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {resolvedTab === 'gaps' && (
        <div className="space-y-3">
          <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            {transition.summary}
          </div>
          {transition.gaps.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{gapsHeading}</div>
              <div className="space-y-2">
                {transition.gaps.map((gap, index) => (
                  <div key={`${gap}:${index}`} className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                    {gap}
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      )}

      {resolvedTab === 'notes' && (
        transition.gapResolutions.length > 0
          ? <CoverageResolutionNotesInner content={artifactContent} phase={phase} isBeads={isBeads} />
          : (
            <div className="space-y-2">
              {transition.resolutionNotes.map((note, index) => (
                <div key={`${note}:${index}`} className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                  {note}
                </div>
              ))}
            </div>
            )
      )}

      {resolvedTab === 'diff' && (
        <div className="space-y-3">
          <ArtifactProcessingNotice structuredOutput={transition.structuredOutput} kind="diff" />
          <RefinementDiffView content={artifactContent} domain={isBeads ? 'beads' : 'prd'} phase={phase} />
        </div>
      )}
    </div>
  )
}

function LegacyCoverageReportView({
  coverageReviewContent,
  revisionContent,
  phase,
}: {
  coverageReviewContent: string | null
  revisionContent: string | null
  phase?: string
}) {
  const [activeTab, setActiveTab] = useState<'audit' | 'changes' | 'notes'>('audit')
  const revisionPayload = revisionContent ? parseRefinementArtifact(revisionContent) : null
  const hasChanges = !!(revisionPayload?.changes?.length || revisionPayload?.winnerDraftContent || revisionPayload?.coverageBaselineContent)
  const hasNotes = !!(revisionPayload?.gapResolutions?.length)

  const tabs: Array<{ key: 'audit' | 'changes' | 'notes'; label: string }> = []
  if (coverageReviewContent) tabs.push({ key: 'audit', label: 'Audit' })
  if (hasChanges) tabs.push({ key: 'changes', label: 'Changes' })
  if (hasNotes) tabs.push({ key: 'notes', label: 'Resolution Notes' })

  const resolvedTab = tabs.find((tab) => tab.key === activeTab)?.key ?? tabs[0]?.key ?? 'audit'

  if (tabs.length === 0) {
    return <RawContentWithCopy content={JSON.stringify({ coverageReviewContent, revisionContent })} />
  }

  return (
    <div className="space-y-3">
      {tabs.length > 1 && (
        <div className="flex gap-1 border-b border-border">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors border-b-2 -mb-px',
                resolvedTab === tab.key
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {resolvedTab === 'audit' && coverageReviewContent && (
        <CoverageResultView content={coverageReviewContent} phase={phase} />
      )}
      {resolvedTab === 'changes' && revisionContent && (
        (() => {
          const candidateVersion = revisionPayload?.candidateVersion
          const finalLabel = candidateVersion ? `PRD Candidate v${candidateVersion}` : 'PRD Candidate'
          return <FinalPrdDraftView content={revisionContent} defaultTab="diff" showDiffTab finalLabel={finalLabel} phase={phase} />
        })()
      )}
      {resolvedTab === 'notes' && revisionContent && (
        <CoverageResolutionNotesInner content={revisionContent} phase={phase} />
      )}
    </div>
  )
}

function VersionedCoverageReportView({
  coverageResult,
  content,
  phase,
}: {
  coverageResult: CoverageArtifactData
  content: string
  phase?: string
}) {
  const transitions = coverageResult.transitions ?? []
  const [activeReportTab, setActiveReportTab] = useState('latest')
  if (transitions.length === 0) {
    return <CoverageResultView content={content} phase={phase} />
  }

  const finalCandidateVersion = coverageResult.finalCandidateVersion ?? coverageResult.attempts?.[coverageResult.attempts.length - 1]?.candidateVersion
  const finalCandidateLabel = getCoverageCandidateLabel(phase, finalCandidateVersion)
  const primaryTabs = [
    ...transitions.map((transition, index) => ({
      key: `transition:${index}`,
      label: transition.label
        ?? (transition.source === 'ai_fix_button'
          ? transition.noChange
            ? `Extra Fix ${transition.extraFixNumber ?? index + 1}: no change`
            : `Extra Fix ${transition.extraFixNumber ?? index + 1}: v${transition.fromVersion} > v${transition.toVersion}`
          : `v${transition.fromVersion} > v${transition.toVersion}`),
      transition,
    })),
    {
      key: 'latest',
      label: 'Latest Check',
      transition: null,
    },
  ]
  const resolvedTab = primaryTabs.find((tab) => tab.key === activeReportTab)?.key ?? 'latest'
  const activeTransition = primaryTabs.find((tab) => tab.key === resolvedTab)?.transition ?? null

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div className="flex gap-2 border-b border-border">
          {primaryTabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveReportTab(tab.key)}
              className={cn(
                'px-4 py-2 text-sm font-semibold transition-colors border-b-2 -mb-px',
                resolvedTab === tab.key
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTransition ? (
          <CoverageTransitionDetailsView key={resolvedTab} transition={activeTransition} phase={phase} />
        ) : (
          <CoverageResultView
            content={content}
            phase={phase}
            cleanStatusLabel={`No open coverage gaps remain for ${finalCandidateLabel}`}
            openGapsTitle={`Open Coverage Gaps in ${finalCandidateLabel}`}
          />
        )}
      </div>
    </div>
  )
}

function CoverageReportView({ content, phase }: { content: string; phase?: string }) {
  let coverageReviewContent: string | null = null
  let revisionContent: string | null = null
  try {
    const envelope = JSON.parse(content) as { coverageReviewContent?: string | null; revisionContent?: string | null }
    if (typeof envelope.coverageReviewContent === 'string' || typeof envelope.revisionContent === 'string') {
      coverageReviewContent = envelope.coverageReviewContent ?? null
      revisionContent = envelope.revisionContent ?? null
    }
  } catch {
    // Treat as direct coverage artifact content.
  }

  if (coverageReviewContent || revisionContent) {
    return (
      <LegacyCoverageReportView
        coverageReviewContent={coverageReviewContent}
        revisionContent={revisionContent}
        phase={phase}
      />
    )
  }

  const coverageResult = parseCoverageArtifact(content)
  if (!coverageResult) {
    return <RawContentWithCopy content={content} />
  }

  return (
    <WithRawTab
      content={content}
      structuredLabel="Summary"
      rawSources={buildCoverageRawSources(coverageResult)}
    >
      <VersionedCoverageReportView coverageResult={coverageResult} content={content} phase={phase} />
    </WithRawTab>
  )
}

function buildCoverageRawSources(coverageResult: CoverageArtifactData | null): RawContentSource[] | undefined {
  if (!coverageResult?.response && !coverageResult?.rawAttempts?.length) return undefined
  const label = formatRawAttemptSourceLabel('coverage audit', coverageResult.winnerId)
  return [{
    id: 'coverage-model-output',
    label,
    modelId: coverageResult.winnerId,
    variants: dedupeRawContentVariants([
      ...(coverageResult.response ? [{
        id: 'coverage-model-output:current',
        label: 'Model Output',
        content: coverageResult.response,
        displayContent: coverageResult.response,
        ariaLabel: `${label} Model Output`,
        title: 'Show coverage model output',
      }] : []),
      ...buildRawAttemptVariants('coverage-audit', label, coverageResult.rawAttempts),
    ]),
    disabled: !coverageResult.response && !coverageResult.rawAttempts?.length,
    title: 'Show coverage raw diagnostics',
  }]
}

export function InterviewAnswersView({ content, hideSummary = false, hideAiAnswerBadge = false }: { content: string; hideSummary?: boolean; hideAiAnswerBadge?: boolean }) {
  const interviewDocument = parseInterviewDocument(content)
  if (interviewDocument) {
    return <InterviewDocumentView document={interviewDocument} defaultGroupsOpen={false} hideSummary={hideSummary} hideAiAnswerBadge={hideAiAnswerBadge} />
  }

  let parsedContent: unknown = null
  try {
    parsedContent = JSON.parse(content)
  } catch {
    try {
      parsedContent = jsYaml.load(content)
    } catch {
      return <RawContentView content={content} />
    }
  }

  if (isLegacyInterviewSnapshot(parsedContent)) {
    const snapshot = parsedContent
    const mappedQuestions = snapshot.questions.map((q) => {
      const questionId = typeof q.id === 'string' ? q.id : null
      const ans = questionId ? snapshot.answers?.[questionId] : undefined
      return {
        ...q,
        answer_type: q.answerType,
        answer: ans ? {
          skipped: ans.skipped,
          free_text: ans.answer,
          selected_option_ids: ans.selectedOptionIds || [],
          answered_by: 'user',
          answered_at: ans.answeredAt,
        } : null
      }
    })
    const doc = normalizeInterviewDocumentLike({
      artifact: 'interview',
      questions: mappedQuestions
    })
    if (doc) {
      return <InterviewDocumentView document={doc} defaultGroupsOpen={false} hideSummary={hideSummary} hideAiAnswerBadge={hideAiAnswerBadge} />
    }
  }

  const viewData: InterviewAnswerViewItem[] = []
  const orphanAnswers: Record<string, string> = {}

  if (parsedContent && typeof parsedContent === 'object' && (parsedContent as InterviewArtifactData).artifact === 'interview') {
    const artifact = parsedContent as InterviewArtifactData
    const qs = Array.isArray(artifact.questions) ? artifact.questions : []
    for (const [i, q] of qs.entries()) {
      const qId = q.id || `Q${i + 1}`
      const prompt = q.prompt || ''
      const answer = typeof q.answer?.free_text === 'string' && q.answer.free_text.trim().length > 0
        ? q.answer.free_text
        : null
      viewData.push({
        id: qId,
        q: prompt,
        answer,
        selectedOptions: getSelectedOptionLabels(q),
        isSkipped: q.answer?.skipped === true,
      })
    }
  } else {
    const artifact = parsedContent && typeof parsedContent === 'object'
      ? parsedContent as InterviewArtifactData
      : null
    if (artifact?.interview) {
      return <InterviewAnswersView content={artifact.interview} />
    }

    const questionsContent = artifact?.refinedContent || ''
    const answersJson = artifact?.userAnswers || '{}'

    const questions = parseInterviewQuestions(questionsContent)
    let answers: Record<string, string> = {}
    try {
      answers = JSON.parse(answersJson)
    } catch { /* ignore */ }

    if (questions.length === 0 && Object.keys(answers).length === 0) {
      return <RawContentView content={content} />
    }

    questions.forEach((q, i) => {
      const qId = `Q${i + 1}`
      const answer = answers[qId] || answers[q.q] || null
      viewData.push({ id: qId, q: q.q, answer, selectedOptions: [], isSkipped: !answer })
    })

    Object.entries(answers).forEach(([k, v]) => {
      if (!k.startsWith('Q') && !questions.some(q => q.q === k)) {
        orphanAnswers[k] = v
      }
    })
  }

  if (viewData.length === 0 && Object.keys(orphanAnswers).length === 0) {
    return <RawContentView content={content} />
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-muted-foreground mb-2">Interview questions and recorded responses.</div>
      {viewData.map((item, i) => (
        <div key={i} className="border border-border rounded-md overflow-hidden bg-background">
          <div className="bg-muted px-3 py-2 text-xs font-medium border-b border-border text-foreground flex gap-2">
            <span className="text-muted-foreground">{item.id}.</span>
            <span>{item.q}</span>
          </div>
          <div className="px-3 py-2 text-xs">
            {item.isSkipped ? (
              <span className="text-muted-foreground italic text-[10px] bg-accent px-1.5 py-0.5 rounded">Skipped</span>
            ) : (
              <div className="space-y-1.5">
                {item.selectedOptions.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {item.selectedOptions.map((label) => (
                      <span key={label} className="inline-flex items-center px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
                {item.answer ? (
                  <div className="whitespace-pre-wrap text-blue-700 dark:text-blue-300">{item.answer}</div>
                ) : item.selectedOptions.length === 0 ? (
                  <span className="text-muted-foreground italic text-[10px]">No response recorded.</span>
                ) : null}
              </div>
            )}
          </div>
        </div>
      ))}
      {Object.entries(orphanAnswers).map(([k, v], i) => (
        <div key={`orphan-${i}`} className="border border-border rounded-md overflow-hidden bg-background">
          <div className="bg-muted px-3 py-2 text-xs font-medium border-b border-border text-foreground">
            {k}
          </div>
          <div className="px-3 py-2 text-xs whitespace-pre-wrap text-blue-700 dark:text-blue-300">
            {v}
          </div>
        </div>
      ))}
    </div>
  )
}

function renderBeadGuidance(guidance: RawBead['contextGuidance']): React.ReactNode {
  if (!guidance) return null

  if (typeof guidance === 'string') {
    const trimmed = guidance.trim()
    if (!trimmed) return null

    return (
      <div className="text-xs">
        <strong className="text-muted-foreground font-medium">Context Guidance:</strong>{' '}
        <span className="whitespace-pre-wrap">{trimmed}</span>
      </div>
    )
  }

  if (typeof guidance !== 'object' || Array.isArray(guidance)) {
    return (
      <div className="text-xs">
        <strong className="text-muted-foreground font-medium">Context Guidance:</strong>{' '}
        <code className="whitespace-pre-wrap break-all">{String(guidance)}</code>
      </div>
    )
  }

  const patterns = Array.isArray(guidance.patterns)
    ? guidance.patterns.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const antiPatterns = Array.isArray(guidance.anti_patterns)
    ? guidance.anti_patterns.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []

  if (patterns.length === 0 && antiPatterns.length === 0) {
    return (
      <div className="text-xs">
        <strong className="text-muted-foreground font-medium">Context Guidance:</strong>{' '}
        <code className="whitespace-pre-wrap break-all">{JSON.stringify(guidance, null, 2) ?? '[invalid guidance]'}</code>
      </div>
    )
  }

  return (
    <div className="text-xs space-y-1.5 border-l-2 border-violet-300 dark:border-violet-700 pl-2">
      <div className="text-[10px] font-semibold uppercase tracking-widest text-violet-600 dark:text-violet-400">Context Guidance</div>
      {patterns.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Patterns</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {patterns.map((pattern, index) => (
              <li key={`pattern-${index}`}>{pattern}</li>
            ))}
          </ul>
        </div>
      )}
      {antiPatterns.length > 0 && (
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-0.5">Anti-patterns</div>
          <ul className="list-disc pl-4 space-y-0.5">
            {antiPatterns.map((antiPattern, index) => (
              <li key={`anti-pattern-${index}`}>{antiPattern}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function getBeadStringArray(bead: RawBead, keys: string[]): string[] {
  for (const key of keys) {
    const value = bead[key]
    if (!Array.isArray(value)) continue
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

function getBeadCommands(bead: RawBead, keys: string[]): CommandSpec[] {
  for (const key of keys) {
    const value = bead[key]
    if (!Array.isArray(value)) continue
    return value.flatMap((command) => {
      const parsed = commandSpecSchema.safeParse(command)
      return parsed.success ? [parsed.data] : []
    })
  }
  return []
}

function getBeadStringValue(bead: RawBead, keys: string[]): string {
  for (const key of keys) {
    const value = bead[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function getBeadNumberValue(bead: RawBead, keys: string[]): number | null {
  for (const key of keys) {
    const value = bead[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function getBeadDependencies(bead: RawBead): { blockedBy: string[]; blocks: string[] } {
  const raw = bead.dependencies
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { blockedBy: [], blocks: [] }
  }

  const record = raw as Record<string, unknown>
  const blockedBy = Array.isArray(record.blocked_by)
    ? record.blocked_by.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  const blocks = Array.isArray(record.blocks)
    ? record.blocks.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []

  return { blockedBy, blocks }
}

function getBeadStatusTone(status: string) {
  switch (status) {
    case 'done':
      return {
        card: 'border-green-300/80 dark:border-green-800/80',
        header: 'bg-green-50/80 dark:bg-green-950/30',
        statusBadge: 'border-green-300 text-green-700 dark:border-green-800 dark:text-green-300',
      }
    case 'in_progress':
      return {
        card: 'border-blue-300/80 dark:border-blue-800/80',
        header: 'bg-blue-50/80 dark:bg-blue-950/30',
        statusBadge: 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300',
      }
    case 'error':
      return {
        card: 'border-red-300/80 dark:border-red-800/80',
        header: 'bg-red-50/80 dark:bg-red-950/30',
        statusBadge: 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
      }
    default:
      return {
        card: 'border-amber-300/80 dark:border-amber-800/80',
        header: 'bg-amber-50/80 dark:bg-amber-950/30',
        statusBadge: 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300',
      }
  }
}

function BeadChip({ value, tone = 'default', mono = false }: { value: string; tone?: 'default' | 'muted' | 'rose' | 'cyan'; mono?: boolean }) {
  const toneClass = tone === 'rose'
    ? 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/30 dark:text-rose-300 dark:border-rose-800'
    : tone === 'cyan'
      ? 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-950/30 dark:text-cyan-300 dark:border-cyan-800'
      : tone === 'muted'
        ? 'bg-muted text-muted-foreground border-border'
        : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800'

  return (
    <span className={cn('inline-flex items-center rounded border px-2 py-0.5 text-[10px]', toneClass, mono && 'font-mono')}>
      {value}
    </span>
  )
}

function BeadSection({
  title,
  accent,
  children,
}: {
  title: string
  accent: string
  children: React.ReactNode
}) {
  return (
    <div className={cn('text-xs border-l-2 pl-2 space-y-1.5', accent)}>
      <div className="text-[10px] font-semibold uppercase tracking-widest text-foreground/70">{title}</div>
      {children}
    </div>
  )
}

interface ExpansionAddedField {
  label: string
  values: string[]
  mono?: boolean
}

interface ExpansionAddedGroup {
  title: string
  fields: ExpansionAddedField[]
}

function compactExpansionValues(values: Array<string | number | null | undefined>): string[] {
  return values
    .map((value) => value == null ? '' : String(value).trim())
    .filter(Boolean)
}

function makeExpansionField(label: string, value: string | number | null | undefined, mono = false): ExpansionAddedField | null {
  const values = compactExpansionValues([value])
  return values.length > 0 ? { label, values, mono } : null
}

function makeExpansionArrayField(label: string, values: string[], mono = false): ExpansionAddedField | null {
  const nextValues = compactExpansionValues(values)
  return nextValues.length > 0 ? { label, values: nextValues, mono } : null
}

function buildExpansionAddedGroups(planBead: RawBead | undefined, expandedBead: RawBead, index: number): ExpansionAddedGroup[] {
  const planId = planBead ? getBeadStringValue(planBead, ['id']) : ''
  const expandedId = getBeadStringValue(expandedBead, ['id'])
  const { blockedBy, blocks } = getBeadDependencies(expandedBead)

  const modelFields = [
    expandedId && expandedId !== planId ? makeExpansionField('Execution ID', expandedId, true) : null,
    makeExpansionField('Issue Type', getBeadStringValue(expandedBead, ['issueType', 'issue_type'])),
    makeExpansionArrayField('Labels', getBeadStringArray(expandedBead, ['labels'])),
    makeExpansionArrayField('Blocked By', blockedBy, true),
    makeExpansionArrayField('Blocks', blocks, true),
    makeExpansionArrayField('Target Files', getBeadStringArray(expandedBead, ['targetFiles', 'target_files']), true),
  ].filter((field): field is ExpansionAddedField => field !== null)

  const runtimeFields = [
    makeExpansionField('Priority', getBeadNumberValue(expandedBead, ['priority']) ?? index + 1),
    makeExpansionField('Status', getBeadStringValue(expandedBead, ['status']) || 'pending'),
    makeExpansionField('External Ref', getBeadStringValue(expandedBead, ['externalRef', 'external_ref']), true),
    makeExpansionField('Iteration', getBeadNumberValue(expandedBead, ['iteration'])),
    makeExpansionField('Created At', getBeadStringValue(expandedBead, ['createdAt', 'created_at']), true),
    makeExpansionField('Updated At', getBeadStringValue(expandedBead, ['updatedAt', 'updated_at']), true),
  ].filter((field): field is ExpansionAddedField => field !== null)

  return [
    { title: 'Model-Added Execution Fields', fields: modelFields },
    { title: 'Runtime Defaults', fields: runtimeFields },
  ].filter((group) => group.fields.length > 0)
}

function countExpansionAddedFields(content: string): number {
  const parsed = parseRefinementArtifact(content)
  if (!parsed?.semanticPlanContent || !parsed.refinedContent) return 0

  const planBeads = parseBeadsArtifact(parsed.semanticPlanContent)
  const expandedBeads = parseBeadsArtifact(parsed.refinedContent)
  if (!planBeads || !expandedBeads) return 0

  // Paired by id, not position. Each side is filtered independently, so one
  // malformed entry in the plan shifts every later bead against its refinement
  // and reports another bead's fields as this one's additions.
  const planById = new Map(planBeads.map((bead) => [bead.id, bead]))
  return expandedBeads.reduce((count, bead, index) => {
    const groups = buildExpansionAddedGroups(planById.get(bead.id), bead, index)
    return count + groups.reduce((sum, group) => sum + group.fields.length, 0)
  }, 0)
}

function ExpansionAddedValue({ values, mono }: { values: string[]; mono?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span
          key={value}
          className={cn(
            'inline-flex items-center rounded border border-green-200 bg-green-50 px-2 py-1 text-[10px] text-green-800 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200',
            mono && 'font-mono break-all',
          )}
        >
          <span className="mr-1 font-semibold">+</span>
          {value}
        </span>
      ))}
    </div>
  )
}

function ExpandedPlanDiffView({ content }: { content: string }) {
  const parsed = parseRefinementArtifact(content)
  const planBeads = parsed?.semanticPlanContent ? parseBeadsArtifact(parsed.semanticPlanContent) : null
  const expandedBeads = parsed?.refinedContent ? parseBeadsArtifact(parsed.refinedContent) : null

  if (!planBeads || !expandedBeads) {
    return <RawContentWithCopy content={content} />
  }

  const planBeadsById = new Map((planBeads ?? []).map((bead) => [getBeadStringValue(bead, ['id']), bead]))
  const addedFieldCount = countExpansionAddedFields(content)

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200">
        Expansion added {addedFieldCount} execution field{addedFieldCount === 1 ? '' : 's'} across {expandedBeads.length} bead{expandedBeads.length === 1 ? '' : 's'}.
      </div>
      {expandedBeads.map((expandedBead, index) => {
        // By id, for the same reason as the count above: the two lists are
        // filtered independently, so positions do not correspond.
        const planBead = planBeadsById.get(getBeadStringValue(expandedBead, ['id']))
        const title = getBeadStringValue(expandedBead, ['title']) || getBeadStringValue(planBead ?? {}, ['title']) || `Bead ${index + 1}`
        const planId = getBeadStringValue(planBead ?? {}, ['id'])
        const expandedId = getBeadStringValue(expandedBead, ['id'])
        const groups = buildExpansionAddedGroups(planBead, expandedBead, index)

        return (
          <CollapsibleSection
            key={`${expandedId || title}:${index}`}
            defaultOpen={index === 0}
            title={(
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="rounded bg-green-100 px-1.5 py-0.5 font-mono text-[10px] text-green-800 dark:bg-green-900 dark:text-green-200">
                  #{index + 1}
                </span>
                <span className="min-w-0 truncate">{title}</span>
                {planId && expandedId && planId !== expandedId ? (
                  <span className="font-mono text-[10px] text-muted-foreground">{planId} -&gt; {expandedId}</span>
                ) : null}
              </span>
            )}
          >
            {groups.length > 0 ? (
              <div className="space-y-3 p-2">
                {groups.map((group) => (
                  <div key={group.title} className="space-y-2 border-l-2 border-green-300 pl-3 dark:border-green-800">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-green-700 dark:text-green-300">{group.title}</div>
                    <div className="grid gap-2 md:grid-cols-2">
                      {group.fields.map((field) => (
                        <div key={`${group.title}:${field.label}`} className="space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{field.label}</div>
                          <ExpansionAddedValue values={field.values} mono={field.mono} />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-2 text-xs text-muted-foreground">No expansion-only fields were recorded for this bead.</div>
            )}
          </CollapsibleSection>
        )
      })}
    </div>
  )
}

function MetadataValue({ value, mono = false }: { value: string; mono?: boolean }) {
  if (!value) {
    return <span className="text-muted-foreground/70">Not set</span>
  }
  return <span className={cn(mono && 'font-mono')}>{value}</span>
}

function MetadataGroup({
  title,
  accent,
  rows,
}: {
  title: string
  accent: string
  rows: Array<{ label: string; value: string; mono?: boolean }>
}) {
  return (
    <div className={cn('rounded-md border px-3 py-2 space-y-2', accent)}>
      <div className="text-[10px] font-semibold uppercase tracking-widest">{title}</div>
      <div className="grid gap-2 md:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{row.label}</div>
            <div className="text-xs break-all">
              <MetadataValue value={row.value} mono={row.mono} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function isPrdFullAnswersArtifactId(artifactId?: string): boolean {
  return artifactId?.startsWith('prd-fullanswers-member-') ?? false
}

function isPrdDraftArtifactId(artifactId?: string): boolean {
  return artifactId === 'winner-prd-draft'
    || (artifactId?.startsWith('prd-draft-member-') ?? false)
}

function isRefinedPrdArtifactId(artifactId?: string): boolean {
  return artifactId === 'refined-prd'
}

function isStructuredPrdArtifactId(artifactId?: string): boolean {
  return isPrdDraftArtifactId(artifactId) || isRefinedPrdArtifactId(artifactId)
}

export function PrdDraftView({ content }: { content: string }) {
  const parsed = parsePrdDocument(content)
  if (parsed && Array.isArray(parsed.epics)) {
    const technicalSections = PRD_TECHNICAL_SECTION_CONFIG
      .map((section) => ({
        ...section,
        values: parsed.technical_requirements?.[section.key] ?? [],
      }))
      .filter((section) => section.values.length > 0)

    return (
      <div className="space-y-4">
        {parsed.product && (
          <CollapsibleSection title="Product" defaultOpen>
            <div className="space-y-2 p-2">
              {parsed.product.problem_statement && (
                <div><strong className="text-xs">Problem Statement:</strong> <span className="text-xs">{parsed.product.problem_statement}</span></div>
              )}
              {Array.isArray(parsed.product.target_users) && parsed.product.target_users.length > 0 && (
                <div>
                  <strong className="text-xs">Target Users:</strong>
                  <ul className="list-disc list-inside text-xs mt-1 pl-2">
                    {parsed.product.target_users.map((user, index) => <li key={index}>{user}</li>)}
                  </ul>
                </div>
              )}
            </div>
          </CollapsibleSection>
        )}
        {parsed.scope && (
          <CollapsibleSection title="Scope">
            <div className="space-y-2 p-2 flex flex-col md:flex-row gap-4">
              <div className="flex-1">
                <strong className="text-xs">In Scope:</strong>
                <ul className="list-disc list-inside text-xs mt-1 pl-2">
                  {(parsed.scope.in_scope ?? []).map((scopeItem, index) => <li key={index}>{scopeItem}</li>)}
                </ul>
              </div>
              <div className="flex-1">
                <strong className="text-xs">Out of Scope:</strong>
                <ul className="list-disc list-inside text-xs mt-1 pl-2 text-muted-foreground">
                  {(parsed.scope.out_of_scope ?? []).map((scopeItem, index) => <li key={index}>{scopeItem}</li>)}
                </ul>
              </div>
            </div>
          </CollapsibleSection>
        )}
        {technicalSections.length > 0 && (
          <CollapsibleSection title="Technical Requirements">
            <div className="space-y-3 p-2">
              {technicalSections.map((section) => (
                <div key={section.key}>
                  <strong className="text-xs">{section.label}:</strong>
                  <ul className="list-disc list-inside text-xs mt-1 pl-2">
                    {section.values.map((value, index) => <li key={index}>{value}</li>)}
                  </ul>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        )}
        {parsed.epics.length > 0 && (
          <div className="space-y-2 mt-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-1">Epics ({parsed.epics.length})</div>
            {parsed.epics.map((epic, index) => (
              <CollapsibleSection
                key={`${epic.id ?? 'epic'}-${index}`}
                title={<span className="flex items-center gap-1.5"><span className="bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-mono">{epic.id || `EPIC-${index + 1}`}</span> {epic.title}</span>}
                defaultOpen={false}
              >
                <div className="space-y-2 p-2">
                  {epic.objective && <div className="text-xs"><strong className="text-muted-foreground font-medium">Objective:</strong> {epic.objective}</div>}
                  {(epic.user_stories ?? []).map((story, storyIndex) => (
                    <div key={`${story.id ?? 'story'}-${storyIndex}`} className="border border-border/50 rounded p-2 bg-background">
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <span className="bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-mono">{story.id || `US-${storyIndex + 1}`}</span>
                        <span className="text-xs font-medium">{story.title}</span>
                      </div>
                      {Array.isArray(story.acceptance_criteria) && story.acceptance_criteria.length > 0 && (
                        <div className="pl-6 mt-1">
                          <ul className="list-disc text-[11px] text-muted-foreground space-y-0.5">
                            {story.acceptance_criteria.map((criterion, criterionIndex) => (
                              <li key={criterionIndex}>{criterion}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </CollapsibleSection>
            ))}
          </div>
        )}
      </div>
    )
  }

  const lines = content.split('\n')
  const sections: { title: string; items: string[] }[] = []
  let current: { title: string; items: string[] } | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('##') || (trimmed.startsWith('**Epic') || trimmed.startsWith('**User Story'))) {
      if (current) sections.push(current)
      current = { title: trimmed.replace(/^#+\s*/, '').replace(/\*\*/g, ''), items: [] }
    } else if (current && trimmed) {
      current.items.push(trimmed.replace(/^[-*]\s*/, ''))
    }
  }
  if (current) sections.push(current)

  if (sections.length === 0) return <RawContentView content={content} />

  return (
    <div className="space-y-2">
      {sections.map((s, i) => (
        <CollapsibleSection key={i} title={s.title} defaultOpen={i === 0}>
          <div className="space-y-1">
            {s.items.map((item, j) => <div key={j} className="text-xs">• {item}</div>)}
          </div>
        </CollapsibleSection>
      ))}
    </div>
  )
}

export function BeadsDraftView({ content }: { content: string }) {
  const beadsArray = parseBeadsArtifact(content)
  if (Array.isArray(beadsArray)) {
    return (
      <div className="space-y-2">
        <div className="text-xs text-muted-foreground mb-2">{beadsArray.length} beads</div>
        {beadsArray.map((bead, index) => (
          (() => {
            const prdRefs = getBeadStringArray(bead, ['prdRefs', 'prd_refs', 'prd_references'])
            const labels = getBeadStringArray(bead, ['labels'])
            const acceptanceCriteria = getBeadStringArray(bead, ['acceptanceCriteria', 'acceptance_criteria'])
            const tests = getBeadStringArray(bead, ['tests'])
            const testCommands = getBeadCommands(bead, ['testCommands', 'test_commands'])
            const testCommandReason = getBeadStringValue(bead, ['testCommandReason', 'test_command_reason'])
            const targetFiles = getBeadStringArray(bead, ['targetFiles', 'target_files'])
            const status = getBeadStringValue(bead, ['status']) || 'pending'
            const tone = getBeadStatusTone(status)
            const order = getBeadNumberValue(bead, ['priority']) ?? index + 1
            const description = getBeadStringValue(bead, ['description'])
            const title = getBeadStringValue(bead, ['title']) || `Bead ${index + 1}`
            const issueType = getBeadStringValue(bead, ['issueType', 'issue_type'])
            const externalRef = getBeadStringValue(bead, ['externalRef', 'external_ref'])
            const notes = getBeadStringValue(bead, ['notes'])
            const iteration = getBeadNumberValue(bead, ['iteration'])
            const createdAt = getBeadStringValue(bead, ['createdAt', 'created_at'])
            const updatedAt = getBeadStringValue(bead, ['updatedAt', 'updated_at'])
            const startedAt = getBeadStringValue(bead, ['startedAt', 'started_at'])
            const completedAt = getBeadStringValue(bead, ['completedAt', 'completed_at'])
            const beadStartCommit = getBeadStringValue(bead, ['beadStartCommit', 'bead_start_commit'])
            // A stored origin is whatever was written; `ManualQaOriginCard`
            // maps `sourceItems` without checking it, so `qaOrigin: {}` took
            // the whole bead view down. An unrenderable origin reads as no
            // origin, which is what the ticket-runtime normaliser already does.
            const storedQaOrigin = bead.qaOrigin ?? bead.qa_origin ?? null
            const qaOrigin = isRenderableManualQaOrigin(storedQaOrigin) ? storedQaOrigin : null
            const metadataId = getBeadStringValue(bead, ['id'])
            const { blockedBy, blocks } = getBeadDependencies(bead)
            return (
              <div key={`${metadataId || 'bead'}-${index}`} id={`bead-${index}`}>
              <CollapsibleSection
                className={tone.card}
                headerClassName={tone.header}
                title={(
                  <span className="flex items-center gap-2 min-w-0 w-full flex-wrap">
                    <span className="bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0">
                      #{order}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{title}</span>
                    {qaOrigin && <ManualQaOriginBadge origin={qaOrigin} />}
                  </span>
                )}
              >
                <div className="space-y-3 p-2">
                  {(prdRefs.length > 0 || labels.length > 0) && (
                    <BeadSection title="Scope Mapping" accent="border-sky-300 dark:border-sky-700">
                      {prdRefs.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">PRD Refs</div>
                          <div className="flex flex-wrap gap-1">
                            {prdRefs.map((ref) => <BeadChip key={ref} value={ref} tone="muted" />)}
                          </div>
                        </div>
                      )}
                      {labels.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Labels</div>
                          <div className="flex flex-wrap gap-1">
                            {labels.map((label) => <BeadChip key={label} value={label} />)}
                          </div>
                        </div>
                      )}
                    </BeadSection>
                  )}
                  {description && (
                    <div className="text-xs">
                      <div className="text-[10px] font-semibold uppercase tracking-widest text-foreground/60 mb-0.5">Description</div>
                      <span className="whitespace-pre-wrap">{description}</span>
                    </div>
                  )}
                  {qaOrigin && <ManualQaOriginCard origin={qaOrigin} />}
                  {targetFiles.length > 0 && (
                    <BeadSection title="Target Files" accent="border-cyan-300 dark:border-cyan-700">
                      <div className="space-y-1">
                        {targetFiles.map((targetFile) => (
                          <code key={targetFile} className="block text-xs rounded bg-background border border-border px-2 py-1 font-mono break-all">
                            {targetFile}
                          </code>
                        ))}
                      </div>
                    </BeadSection>
                  )}
                  {(blockedBy.length > 0 || blocks.length > 0) && (
                    <BeadSection title="Dependencies" accent="border-rose-300 dark:border-rose-700">
                      {blockedBy.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Blocked By</div>
                          <div className="flex flex-wrap gap-1">
                            {blockedBy.map((dependency) => {
                              const depIndex = beadsArray.findIndex((b) => b.id === dependency)
                              const displayVal = depIndex !== -1 ? `${dependency} (#${depIndex + 1})` : dependency
                              return <BeadChip key={dependency} value={displayVal} tone="rose" mono />
                            })}
                          </div>
                        </div>
                      )}
                      {blocks.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Blocks</div>
                          <div className="flex flex-wrap gap-1">
                            {blocks.map((dependency) => {
                              const depIndex = beadsArray.findIndex((b) => b.id === dependency)
                              const displayVal = depIndex !== -1 ? `${dependency} (#${depIndex + 1})` : dependency
                              return <BeadChip key={dependency} value={displayVal} tone="rose" mono />
                            })}
                          </div>
                        </div>
                      )}
                    </BeadSection>
                  )}
                  {renderBeadGuidance((bead.contextGuidance ?? bead.context_guidance) as RawBead['contextGuidance'])}
                  {acceptanceCriteria.length > 0 && (
                    <BeadSection title="Acceptance Criteria" accent="border-green-300 dark:border-green-700">
                      <ul className="list-disc pl-4 space-y-0.5">
                        {acceptanceCriteria.map((criterion) => (
                          <li key={criterion}>{criterion}</li>
                        ))}
                      </ul>
                    </BeadSection>
                  )}
                  {(tests.length > 0 || testCommands.length > 0 || testCommandReason) && (
                    <BeadSection title="Tests" accent="border-amber-300 dark:border-amber-700">
                      {tests.length > 0 && (
                        <ul className="list-disc pl-4 space-y-0.5">
                          {tests.map((test) => (
                            <li key={test}>{test}</li>
                          ))}
                        </ul>
                      )}
                      {testCommands.length > 0 && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Planned Test Commands</div>
                          {testCommands.map((command, commandIndex) => (
                            <code key={commandIndex} className="block text-xs rounded bg-background border border-border px-2 py-1 font-mono break-all">
                              {renderCommandSpec(command)}
                            </code>
                          ))}
                        </div>
                      )}
                      {testCommands.length === 0 && testCommandReason && (
                        <div className="space-y-1">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">No automated command</div>
                          <p className="text-xs text-muted-foreground">{testCommandReason}</p>
                        </div>
                      )}
                    </BeadSection>
                  )}
                  <CollapsibleSection
                    title="Metadata"
                    defaultOpen={false}
                    scrollOnOpen={false}
                    className="bg-muted/20"
                    headerClassName="bg-muted/40"
                    contentClassName="pt-2"
                  >
                    <div className="space-y-3">
                      <MetadataGroup
                        title="Identity"
                        accent="border-slate-200 bg-slate-50/60 text-slate-900 dark:border-slate-800 dark:bg-slate-950/20 dark:text-slate-100"
                        rows={[
                          { label: 'ID', value: metadataId, mono: true },
                          { label: 'Issue Type', value: issueType },
                          { label: 'External Ref', value: externalRef, mono: true },
                          { label: 'Status', value: status },
                        ]}
                      />
                      <MetadataGroup
                        title="Runtime"
                        accent="border-zinc-200 bg-zinc-50/60 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950/20 dark:text-zinc-100"
                        rows={[
                          { label: 'Notes', value: notes },
                          { label: 'Iteration', value: iteration != null ? String(iteration) : '', mono: true },
                          { label: 'Bead Start Commit', value: beadStartCommit, mono: true },
                        ]}
                      />
                      <MetadataGroup
                        title="Lifecycle"
                        accent="border-indigo-200 bg-indigo-50/60 text-indigo-900 dark:border-indigo-800 dark:bg-indigo-950/20 dark:text-indigo-100"
                        rows={[
                          { label: 'Created At', value: createdAt, mono: true },
                          { label: 'Updated At', value: updatedAt, mono: true },
                          { label: 'Started At', value: startedAt, mono: true },
                          { label: 'Completed At', value: completedAt, mono: true },
                        ]}
                      />
                    </div>
                  </CollapsibleSection>
                </div>
              </CollapsibleSection>
              </div>
            )
          })()
        ))}
      </div>
    )
  }

  const lines = content.split('\n')
  const beads: { title: string; details: string[] }[] = []
  let current: { title: string; details: string[] } | null = null
  for (const line of lines) {
    const trimmed = line.trim()
    const beadMatch = trimmed.match(/^(?:##?\s*)?(?:Bead|Issue)\s*#?\d+[:\s-]*(.*)/i)
    if (beadMatch) {
      if (current) beads.push(current)
      current = { title: beadMatch[1] || trimmed, details: [] }
    } else if (current && trimmed) {
      current.details.push(trimmed.replace(/^[-*]\s*/, ''))
    }
  }
  if (current) beads.push(current)
  // Raw rather than nothing. Returning null drew an empty approval pane for
  // content that is simply not a bead artifact — and the parser's own contract,
  // stated where it returns null, is that the caller shows the raw view.
  if (beads.length === 0) return <RawContentView content={content} />
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground mb-2">{beads.length} beads</div>
      {beads.map((b, i) => (
        <CollapsibleSection key={i} title={<span className="flex items-center gap-1.5"><span className="bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300 px-1.5 py-0.5 rounded text-[10px] font-mono">#{i + 1}</span> {b.title}</span>}>
          <div className="space-y-1">
            {b.details.map((d, j) => <div key={j} className="text-xs">• {d}</div>)}
          </div>
        </CollapsibleSection>
      ))}
    </div>
  )
}

function VotingResultsView({ data, showHeader = true }: { data: CouncilResultData; showHeader?: boolean }) {
  const votes = Array.isArray(data.votes)
    ? data.votes
    : []
  const winnerId = data.winnerId ?? ''
  const voterOutcomes = (data.voterOutcomes ?? {}) as Record<string, CouncilOutcome>
  const voterDetails = Array.isArray(data.voterDetails)
    ? data.voterDetails
    : []
  const voterDetailById = new Map<string, CouncilVoterDetailData>(
    voterDetails.map((detail) => [detail.voterId, detail] as const),
  )
  const presentationOrders = data.presentationOrders ?? {}

  const draftIds = [...new Set(votes.map(v => v.draftId))]
  const voterIds = [
    ...(Object.keys(voterOutcomes).length > 0 ? Object.keys(voterOutcomes) : []),
    ...votes.map(v => v.voterId),
    ...voterDetails.map((detail) => detail.voterId),
  ].filter((voterId, index, values) => values.indexOf(voterId) === index)
  const categories = votes[0]?.scores?.map(s => s.category) ?? []
  const getVoterOutcome = (voterId: string): CouncilOutcome => {
    const outcome = voterOutcomes[voterId]
    if (outcome === 'completed' || outcome === 'failed' || outcome === 'timed_out' || outcome === 'invalid_output' || outcome === 'pending') {
      return outcome
    }
    return votes.some(v => v.voterId === voterId) ? 'completed' : 'pending'
  }
  const voterProcessingNoticeById = new Map<string, ArtifactStructuredOutputData | undefined>(
    voterIds.map((voterId) => {
      const detail = voterDetailById.get(voterId)
      return [voterId, withRawNormalizationNotice(
        detail?.structuredOutput,
        detail?.rawResponse,
        detail?.normalizedResponse,
        getValidatedVoteResponse(voterId, data, detail),
      )] as const
    }),
  )
  const completedCount = voterIds.filter(voterId => getVoterOutcome(voterId) === 'completed').length
  const hasLiveOutcomes = voterIds.length > 0
  const votersWithProcessingNotice = voterIds.filter((voterId) => hasArtifactProcessingNotice(voterProcessingNoticeById.get(voterId)))
  const aggregateProcessingNotice = mergeStructuredOutputMetadata(
    votersWithProcessingNotice.map((voterId) => voterProcessingNoticeById.get(voterId)),
  )
  const aggregateOwnerInterventions = votersWithProcessingNotice.map((voterId) => ({
    label: getModelDisplayName(voterId),
    structuredOutput: voterProcessingNoticeById.get(voterId),
  }))

  if (votes.length === 0 && !hasLiveOutcomes) {
    return <div className="text-xs text-muted-foreground italic">No voting data available</div>
  }

  const draftScores = draftIds.map(draftId => {
    const draftVotes = votes.filter(v => v.draftId === draftId)
    const total = draftVotes.reduce((sum, v) => sum + v.totalScore, 0)
    const categoryAvgs = categories.map(cat => {
      const scores = draftVotes.map(v => v.scores.find(s => s.category === cat)?.score ?? 0)
      return { category: cat, avg: scores.reduce((a, b) => a + b, 0) / (scores.length || 1) }
    })
    return { draftId, total, categoryAvgs, isWinner: draftId === winnerId }
  }).sort((a, b) => b.total - a.total)

  return (
    <div className="space-y-3">
      {aggregateProcessingNotice && (
        <ArtifactProcessingNotice
          structuredOutput={aggregateProcessingNotice}
          kind="vote-aggregate"
          context={{ affectedCount: votersWithProcessingNotice.length, ownerInterventions: aggregateOwnerInterventions }}
        />
      )}
      {hasLiveOutcomes && (
        <div className="space-y-2">
          {showHeader && (
            <div className="text-xs font-semibold">
              Voter Status <span className="text-muted-foreground font-normal">({completedCount}/{voterIds.length} complete)</span>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {voterIds.map(voterId => {
              const outcome = getVoterOutcome(voterId)
              return (
                <ModelBadge
                  key={voterId}
                  modelId={voterId}
                  className="px-2.5 py-1.5 h-auto items-start"
                >
                  <div className="min-w-0 text-left">
                    <div className="text-[10px] font-medium truncate">{getModelDisplayName(voterId)}</div>
                    <div className="mt-0.5 flex items-center gap-1 text-[10px] opacity-80">
                      <CouncilStatusIcon outcome={outcome} action="scoring" className="h-3 w-3" />
                      <span>{getCouncilStatusLabel(outcome, 'scoring')}</span>
                    </div>
                  </div>
                </ModelBadge>
              )
            })}
          </div>
        </div>
      )}

      {draftScores.length === 0 && (
        <div className="text-xs text-muted-foreground italic">No completed votes yet.</div>
      )}

      {/* Rankings */}
      {draftScores.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-semibold mb-1">Rankings</div>
          {draftScores.map((d, rank) => (
            <ModelBadge
              key={d.draftId}
              modelId={d.draftId}
              active={d.isWinner}
              className="w-full px-2.5 py-1.5 h-auto items-center"
            >
              <span className="font-mono w-5 text-center font-bold opacity-80">{rank === 0 ? 'W' : `#${rank + 1}`}</span>
              <span className="font-medium flex-1 text-left ml-1">{getModelDisplayName(d.draftId)}</span>
              <span className={`ml-auto font-mono font-semibold ${d.isWinner ? 'text-primary-foreground' : 'text-secondary-foreground'}`}>{d.total}</span>
              {d.isWinner && <Trophy className="h-3.5 w-3.5 text-primary-foreground ml-1" />}
            </ModelBadge>
          ))}
        </div>
      )}

      {/* Score table */}
      {draftScores.length > 0 && categories.length > 0 && (
        <div className="overflow-x-auto">
          <div className="text-xs font-semibold mb-1">Score Breakdown</div>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-1 pr-2 font-medium text-muted-foreground">Model</th>
                {categories.map(cat => (
                  <Tooltip key={cat}>
                      <TooltipTrigger asChild>
                        <th className="text-center py-1 px-1 font-medium text-muted-foreground">
                                        {cat.length > 20 ? cat.slice(0, 18) + '…' : cat}
                                      </th>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-center text-balance">{cat}</TooltipContent>
                    </Tooltip>
                ))}
                <th className="text-center py-1 pl-2 font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {draftScores.map(d => (
                <tr key={d.draftId} className={`border-b border-border/50 ${d.isWinner ? 'bg-primary/10' : ''}`}>
                  <td className="py-1 pr-2 whitespace-nowrap">
                    <ModelIcon modelId={d.draftId} className="mr-1 inline-block h-3 w-3 align-[-0.125em]" />
                    <span className={d.isWinner ? 'font-semibold text-primary' : ''}>{getModelDisplayName(d.draftId)}</span>
                  </td>
                  {d.categoryAvgs.map(ca => (
                    <td key={ca.category} className="text-center py-1 px-1 font-mono">{ca.avg.toFixed(1)}</td>
                  ))}
                  <td className={`text-center py-1 pl-2 font-mono font-semibold ${d.isWinner ? 'text-primary' : ''}`}>{d.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Per-voter breakdown */}
      <CollapsibleSection title={<span>Voter Details <span className="text-muted-foreground">({voterIds.length} voters)</span></span>}>
        <div className="space-y-2">
          {voterIds.map(voterId => {
            const presentationOrder = presentationOrders[voterId]
            return (
              <div key={voterId} className="space-y-1">
                <div className="font-medium flex items-center gap-1">
                  <ModelIcon modelId={voterId} className="h-3.5 w-3.5" />
                  {getModelDisplayName(voterId)}
                  <span className="ml-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                    <CouncilStatusIcon outcome={getVoterOutcome(voterId)} action="scoring" className="h-3 w-3" />
                    <span>{getCouncilStatusLabel(getVoterOutcome(voterId), 'scoring')}</span>
                  </span>
                </div>
                {votes.filter(v => v.voterId === voterId).length === 0 ? (
                  <div className="ml-4 text-muted-foreground italic">
                    {getVoterOutcome(voterId) === 'pending'
                      ? 'Still scoring drafts.'
                      : getVoterOutcome(voterId) === 'failed'
                        ? 'Failed before submitting scores.'
                        : getVoterOutcome(voterId) === 'timed_out'
                          ? 'Timed out before submitting scores.'
                        : getVoterOutcome(voterId) === 'invalid_output'
                            ? 'Returned malformed scores.'
                            : 'No scores recorded.'}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {votes.filter(v => v.voterId === voterId).map(v => (
                      <div key={v.draftId} className="ml-4 flex items-center gap-2 text-muted-foreground">
                        <span>→ {getModelDisplayName(v.draftId)}</span>
                        <span className="font-mono">{v.totalScore}pts</span>
                        {v.draftId === winnerId && <span className="font-bold text-[10px] text-primary bg-primary/10 px-1 rounded">winner</span>}
                      </div>
                    ))}
                    {presentationOrder && (
                      <div className="ml-4 space-y-1">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Presentation Order <span className="normal-case tracking-normal">seed {presentationOrder.seed.slice(0, 8)}</span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {presentationOrder.order.map((draftId, index) => (
                            <span key={`${voterId}:${draftId}:${index}`} className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-foreground">
                              Draft {index + 1}: {getModelDisplayName(draftId)}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </CollapsibleSection>
    </div>
  )
}

function buildValidatedVoteResponseFromVotes(voterId: string, data: CouncilResultData): string | undefined {
  const presentationOrder = data.presentationOrders?.[voterId]?.order
  const votes = Array.isArray(data.votes) ? data.votes : []
  if (!Array.isArray(presentationOrder) || presentationOrder.length === 0) return undefined

  const votesByDraftId = new Map(
    votes
      .filter((vote) => vote.voterId === voterId)
      .map((vote) => [vote.draftId, vote] as const),
  )
  if (votesByDraftId.size < presentationOrder.length) return undefined

  const draftScores: Record<string, Record<string, number>> = {}
  for (const [index, draftId] of presentationOrder.entries()) {
    const vote = votesByDraftId.get(draftId)
    if (!vote || !Array.isArray(vote.scores) || !Number.isFinite(vote.totalScore)) return undefined

    const scoreRecord: Record<string, number> = {}
    for (const score of vote.scores) {
      if (typeof score.category !== 'string' || !Number.isFinite(score.score)) return undefined
      scoreRecord[score.category] = score.score
    }
    scoreRecord.total_score = vote.totalScore
    draftScores[`Draft ${index + 1}`] = scoreRecord
  }

  return jsYaml.dump({ draft_scores: draftScores }, { lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd()
}

function getValidatedVoteResponse(
  voterId: string,
  data: CouncilResultData,
  detail?: CouncilVoterDetailData,
): string | undefined {
  if (typeof detail?.normalizedResponse === 'string') return detail.normalizedResponse
  if (detail?.structuredOutput?.repairApplied !== true) return undefined

  const outcome = data.voterOutcomes?.[voterId]
  if (outcome && outcome !== 'completed') return undefined
  return buildValidatedVoteResponseFromVotes(voterId, data)
}

export function ArtifactContent({
  content,
  artifactId,
  phase,
  reportContent,
}: {
  content: string
  artifactId?: string
  phase?: string
  reportContent?: string | null
}) {
  const logCtx = useLogs()
  const loadLogsForPhase = logCtx?.loadLogsForPhase
  const phaseLogs = useMemo(
    () => (phase && logCtx ? logCtx.getLogsForPhase(phase) : []),
    [logCtx, phase],
  )
  const hasStructuredRetryInContent = useMemo(
    () => content.includes('autoRetryCount') || content.includes('retryDiagnostics'),
    [content],
  )
  const draftRawLogFallbacks = useMemo(
    () => buildDraftRawLogFallbacks(phaseLogs, phase),
    [phaseLogs, phase],
  )
  const draftRawLogHistories = useMemo(
    () => buildDraftRawLogHistories(phaseLogs, phase),
    [phaseLogs, phase],
  )
  const voteRawLogHistories = useMemo(
    () => buildVoteRawLogHistories(phaseLogs, phase),
    [phaseLogs, phase],
  )

  useEffect(() => {
    if (!phase || !hasStructuredRetryInContent) return
    loadLogsForPhase?.(phase)
  }, [hasStructuredRetryInContent, loadLogsForPhase, phase])

  if (artifactId === 'execution-setup-plan') {
    return (
      <ExecutionSetupPlanView
        content={content}
        reportContent={reportContent}
        header={<div className="text-xs font-semibold px-1">Execution Setup Plan</div>}
      />
    )
  }
  if (artifactId === 'execution-setup-runtime') {
    return <ExecutionSetupRuntimeView content={content} />
  }
  if (artifactId === 'execution-setup-profile') {
    return <ExecutionSetupProfileView content={content} />
  }
  if (artifactId === 'execution-setup-report') {
    return <ExecutionSetupReportView content={content} />
  }
  if (artifactId === 'diagnostics') {
    return <PreFlightReportView content={content} />
  }
  if (artifactId === 'relevant-files-scan') {
    return <RelevantFilesScanView content={content} />
  }
  if (artifactId === 'commit-summary') {
    return <IntegrationReportView content={content} />
  }
  if (artifactId === 'pull-request-report') {
    return <PullRequestReportView content={content} />
  }
  if (artifactId === 'test-results') {
    return <FinalTestResultsView content={content} />
  }
  if (artifactId === 'manual-qa-checklist') {
    const { structuredOutput, validationError } = readManualQaProcessingMetadata(content)
    // A generation that gave up leaves the trail and no checklist, and that is
    // the run whose repairs an operator most needs to read.
    const notice = (
      <ArtifactProcessingNotice
        structuredOutput={structuredOutput}
        status={validationError ? 'failed' : 'completed'}
      />
    )
    const parsed = parseManualQaArtifactChecklist(content)
    if (!parsed) {
      return (
        <div className="space-y-3">
          {notice}
          <RawContentWithCopy content={content} />
        </div>
      )
    }
    return (
      <WithRawTab content={parsed.raw} structuredLabel="Checklist">
        <div className="space-y-3">
          {notice}
          <ManualQaChecklistArtifactView parsed={parsed.checklist} />
        </div>
      </WithRawTab>
    )
  }
  if (artifactId === 'cleanup-report') {
    return <CleanupReportView content={content} />
  }
  if (artifactId === 'bead-commits') {
    return <BeadCommitsDiffView content={content} />
  }
  if (artifactId === 'final-interview') {
    const isCanonicalInterviewPhase = phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL'
    const header = <div className="text-xs font-semibold px-1">{isCanonicalInterviewPhase ? 'Interview Results' : 'Final Interview'}</div>
    return (
      <FinalInterviewArtifactView
        content={content}
        header={header}
        hideAiAnswerBadge={isCanonicalInterviewPhase}
        showDiffTab={phase !== 'WAITING_INTERVIEW_ANSWERS'}
        phase={phase}
      />
    )
  }
  if (artifactId === 'final-prd-draft') {
    const header = <div className="text-xs font-semibold px-1">PRD Candidate v1</div>
    return <FinalPrdDraftView content={content} header={header} finalLabel="PRD Candidate v1" phase={phase} />
  }
  if (artifactId === 'refined-prd') {
    const candidateVersion = parseRefinementArtifact(content)?.candidateVersion ?? 1
    const label = `PRD Candidate v${candidateVersion}`
    const header = <div className="text-xs font-semibold px-1">{label}</div>
    return <FinalPrdDraftView content={content} header={header} finalLabel={label} phase={phase} />
  }
  if (artifactId === 'coverage-report') {
    return <CoverageReportView content={content} phase={phase} />
  }
  if (artifactId === 'final-beads-draft') {
    const header = <div className="text-xs font-semibold px-1">Final Blueprint Draft</div>
    return <FinalPrdDraftView content={content} header={header} isBeads phase={phase} />
  }
  if (artifactId === 'interview-answers') {
    const header = <div className="text-xs font-semibold px-1">Interview Answers</div>
    return (
      <WithRawTab content={content} structuredLabel="Q&A" header={header}>
        <InterviewAnswersView content={content} hideSummary />
      </WithRawTab>
    )
  }
  if (artifactId?.endsWith('coverage-result') || artifactId === 'coverage-review') {
    const coverageResult = parseCoverageArtifact(content)
    const reviewLabel = phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL'
      ? 'Coverage review of the current PRD candidate'
      : phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL'
        ? 'Coverage review of the compiled interview'
        : phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL'
          ? 'Coverage review of the current implementation plan'
          : 'Coverage review'
    const header = coverageResult?.winnerId ? (
      <ModelBadge modelId={coverageResult.winnerId} active className="px-3 py-2 h-auto flex-1 justify-start">
        <div className="text-left">
          <div className="text-xs font-medium">{getModelDisplayName(coverageResult.winnerId)}</div>
          <div className="text-[10px] opacity-80 mt-0.5">
            {reviewLabel}
            {(coverageResult.coverageRunNumber && coverageResult.maxCoveragePasses)
              ? ` · pass ${coverageResult.coverageRunNumber} of ${coverageResult.maxCoveragePasses}`
              : ''}
          </div>
        </div>
      </ModelBadge>
    ) : <div className="text-xs font-semibold px-1">Coverage Audit</div>

    return (
      <WithRawTab
        content={content}
        structuredLabel="Summary"
        header={header}
        notice={<ArtifactProcessingNotice structuredOutput={coverageResult?.structuredOutput} kind="coverage" />}
        rawSources={buildCoverageRawSources(coverageResult)}
      >
        <CoverageResultView content={content} phase={phase} />
      </WithRawTab>
    )
  }

  let parsedCoverageInput: CoverageInputData | null = null
  try {
    const p = JSON.parse(content) as unknown
    if (p && typeof p === 'object' && 'refinedContent' in p && !('drafts' in p) && !('votes' in p)) {
      parsedCoverageInput = p as CoverageInputData
    }
  } catch { /* not json */ }

  if (parsedCoverageInput && artifactId === 'refined-beads') {
    const diffEntries = buildRefinementDiffEntries(content, 'beads')
    const parsedRefinement = parseRefinementArtifact(content)
    const coverageResult = parseCoverageArtifact(content)
    const expansionDiffCount = phase === 'EXPANDING_BEADS' ? countExpansionAddedFields(content) : 0
    const hasExpansionDiff = expansionDiffCount > 0
    const hasRefinementChanges = diffEntries.length > 0 || Boolean(parsedRefinement?.winnerDraftContent) || Boolean(parsedRefinement?.coverageBaselineContent)
    const hasChanges = hasExpansionDiff || (phase !== 'EXPANDING_BEADS' && hasRefinementChanges)
    const defaultBeadsTab = phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL'
      ? 'sections'
      : undefined
    const hasBeadsDiffTab = phase === 'EXPANDING_BEADS'
      ? hasExpansionDiff
      : phase !== 'WAITING_BEADS_APPROVAL'
    return (
      <RefinedArtifactTabs
        content={content}
        hasChanges={hasChanges}
        diffLabel={hasExpansionDiff ? 'Diff vs Plan' : parsedRefinement?.coverageDiffLabel ?? 'Diff'}
        defaultTab={defaultBeadsTab}
        showDiffTab={hasBeadsDiffTab}
        notice={<ArtifactProcessingNotice structuredOutput={parsedRefinement?.structuredOutput} kind="diff" />}
        sectionsContent={(
          <div className="space-y-6">
            <CleanCoverageCallout coverageResult={coverageResult} phase={phase} fallbackCandidateVersion={parsedRefinement?.candidateVersion} />
            {parsedCoverageInput.interview && (
              <div>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Approved Interview</div>
                <div className="opacity-80"><InterviewAnswersView content={parsedCoverageInput.interview} /></div>
              </div>
            )}
            {parsedCoverageInput.fullAnswers && (
              <div>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Winner Full Answers</div>
                <div className="opacity-80"><InterviewAnswersView content={parsedCoverageInput.fullAnswers} /></div>
              </div>
            )}
            {parsedCoverageInput.prd && (
              <div>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Prior Context (PRD)</div>
                <div className="opacity-80"><PrdDraftView content={parsedCoverageInput.prd} /></div>
              </div>
            )}
            {(parsedCoverageInput.refinedContent || parsedCoverageInput.beads) && (
              <div>
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mb-2">Beads</div>
                <BeadsDraftView content={parsedCoverageInput.refinedContent || parsedCoverageInput.beads!} />
              </div>
            )}
          </div>
        )}
        diffContent={hasExpansionDiff
          ? <ExpandedPlanDiffView content={content} />
          : hasRefinementChanges
            ? <RefinementDiffView content={content} domain={'beads'} phase={phase} />
            : undefined}
      />
    )
  }

  const councilResult = tryParseCouncilResult(content)
  if (councilResult) {
    const validatedDraftRawOnly = shouldShowValidatedDraftRawOnly(phase)
    const isVotes = artifactId?.includes('vote')
    if (isVotes) {
      const votes = Array.isArray(councilResult.votes) ? councilResult.votes : []
      const voterOutcomes = (councilResult.voterOutcomes ?? {}) as Record<string, CouncilOutcome>
      const voterDetails = Array.isArray(councilResult.voterDetails)
        ? councilResult.voterDetails
        : []
      const voterIds = [
        ...(Object.keys(voterOutcomes).length > 0 ? Object.keys(voterOutcomes) : []),
        ...votes.map(v => v.voterId),
        ...voterDetails.map((detail) => detail.voterId),
      ].filter((voterId, index, values) => voterId && values.indexOf(voterId) === index)
      const voterDetailById = new Map(voterDetails.map((detail) => [detail.voterId, detail] as const))
      const completedCount = voterIds.filter(voterId => {
        const outcome = voterOutcomes[voterId]
        if (outcome === 'completed' || outcome === 'failed' || outcome === 'timed_out' || outcome === 'invalid_output' || outcome === 'pending') {
          return outcome === 'completed'
        }
        return votes.some(v => v.voterId === voterId)
      }).length

      const header = (
        <div className="text-xs font-semibold px-1">
          Voter Status <span className="text-muted-foreground font-normal">({completedCount}/{voterIds.length} complete)</span>
        </div>
      )
      const rawSources = voterIds.map((voterId) => {
        const detail = voterDetailById.get(voterId)
        const rawResponse = detail?.rawResponse
        const validatedResponse = getValidatedVoteResponse(voterId, councilResult, detail)
        const rejectedResponse = getRejectedRawAttempt(detail?.rawAttempts) ?? getRejectedVoteRawResponse(voterId, detail, voteRawLogHistories)
        const shouldShowRejected = hasStructuredRetryMetadata(detail?.structuredOutput)
        const hasRawResponse = typeof rawResponse === 'string'
        const hasValidatedResponse = typeof validatedResponse === 'string'
        const label = getModelDisplayName(voterId)
        const rawAttemptVariants = buildRawAttemptVariants(`voter:${voterId}`, label, detail?.rawAttempts)
        const variants: RawContentVariant[] = [{
          id: `voter:${voterId}:raw`,
          label: 'Raw Output',
          content: rawResponse,
          displayContent: rawResponse,
          disabled: !hasRawResponse,
          ariaLabel: `${label} Raw Output`,
          title: hasRawResponse
            ? `Show raw vote response from ${label}`
            : `No exact raw vote response stored for ${label}`,
        }]
        if (shouldShowRejected) {
          variants.push(buildRejectedRawVariant(
            `voter:${voterId}:rejected`,
            label,
            rejectedResponse,
            formatRejectedRawVariantLabel(detail?.rawAttempts, detail?.structuredOutput),
          ))
        }
        variants.push(...rawAttemptVariants)
        if (hasValidatedResponse) {
          const validatedLabel = formatValidatedRawVariantLabel(detail?.rawAttempts, detail?.structuredOutput)
          variants.push({
            id: `voter:${voterId}:validated`,
            label: validatedLabel,
            content: validatedResponse,
            displayContent: validatedResponse,
            ariaLabel: `${label} ${validatedLabel}`,
            title: `Show ${validatedLabel.toLowerCase()} vote scorecard from ${label}`,
          })
        }
        const uniqueVariants = dedupeRawContentVariants(variants)
        return {
          id: `voter:${voterId}`,
          label,
          modelId: voterId,
          variants: uniqueVariants,
          disabled: !uniqueVariants.some((variant) => !variant.disabled),
          title: hasRawResponse
            ? `Show raw vote response from ${label}`
            : `No exact raw vote response stored for ${label}`,
        }
      })

      return (
        <WithRawTab content={content} structuredLabel="Votes" header={header} rawSources={rawSources}>
          <VotingResultsView data={councilResult} showHeader={false} />
        </WithRawTab>
      )
    }

    const isWinnerArtifact = artifactId?.startsWith('winner')
    if (isWinnerArtifact) {
      const winnerDraftSource = councilResult.drafts?.find((d) => d.memberId === councilResult.winnerId)
      const winnerDraft = winnerDraftSource
        ? withDraftRawLogFallback(winnerDraftSource, phase, artifactId, draftRawLogFallbacks)
        : undefined
      if (winnerDraft && isFailedCouncilDraftOutcome(winnerDraft.outcome)) {
        const isPrd = isStructuredPrdArtifactId(artifactId)
        const isBeads = Boolean(artifactId?.includes('beads'))
        const diagnosticContent = JSON.stringify({
          memberId: winnerDraft.memberId,
          outcome: winnerDraft.outcome,
          error: winnerDraft.error,
          validationError: winnerDraft.structuredOutput?.validationError,
        }, null, 2)
        const rawContent = validatedDraftRawOnly
          ? (getValidatedDraftContent(winnerDraft) ?? diagnosticContent)
          : winnerDraft.rawResponse ?? getRejectedRawAttempt(winnerDraft.rawAttempts) ?? winnerDraft.content ?? diagnosticContent
        return (
          <WithRawTab
            content={rawContent}
            structuredLabel="Diagnostics"
            notice={<ArtifactProcessingNotice
              structuredOutput={winnerDraft.structuredOutput}
              kind={getCouncilDraftNoticeKind({ isFullAnswers: false, isInterview: !isPrd && !isBeads, isPrd, isBeads })}
              status={winnerDraft.outcome}
            />}
            rawSources={buildDraftRawSources(
              winnerDraft,
              getRejectedDraftRawResponse(winnerDraft, phase, artifactId, draftRawLogHistories),
              { validatedOnly: validatedDraftRawOnly },
            )}
          >
            <CouncilDraftFailureDiagnostics draft={winnerDraft} />
          </WithRawTab>
        )
      }
      const winnerContent = winnerDraft?.content ?? councilResult.winnerContent ?? ''
      if (!winnerContent) return <div className="text-xs text-muted-foreground italic">Voting still in progress — winner not yet determined.</div>
      const header = winnerDraft ? (
        <ModelBadge
          modelId={winnerDraft.memberId}
          active={true}
          className="px-3 py-2 h-auto flex-1 justify-start"
        >
          <div className="min-w-0 text-left">
            <div className="text-xs font-medium truncate">{getModelDisplayName(winnerDraft.memberId)}</div>
            <div className="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-primary-foreground/90 normal-case">
              <Trophy className="h-3 w-3" />
              <span>Winner</span>
              {winnerDraft.duration ? <span>· {(winnerDraft.duration / 1000).toFixed(1)}s</span> : null}
            </div>
          </div>
        </ModelBadge>
      ) : null
      const isPrd = isStructuredPrdArtifactId(artifactId)
      const isBeads = Boolean(artifactId?.includes('beads'))
      const noticeKind = getCouncilDraftNoticeKind({
        isFullAnswers: false,
        isInterview: !isPrd && !isBeads,
        isPrd,
        isBeads,
      })
      const noticeOutput = winnerDraft
        ? validatedDraftRawOnly
          ? winnerDraft.structuredOutput
          : withRawNormalizationNotice(winnerDraft.structuredOutput, winnerDraft.rawResponse, winnerDraft.normalizedResponse, winnerContent)
        : undefined
      const structured = isPrd ? <PrdDraftView content={winnerContent} />
        : isBeads ? <BeadsDraftView content={winnerContent} />
          : <InterviewDraftView content={winnerContent} />
      return (
        <WithRawTab
          content={winnerContent}
          structuredLabel="Winner"
          header={header}
          notice={<ArtifactProcessingNotice structuredOutput={noticeOutput} kind={noticeKind} status={winnerDraft?.outcome ?? 'completed'} />}
          rawSources={winnerDraft
            ? buildDraftRawSources(
                winnerDraft,
                getRejectedDraftRawResponse(winnerDraft, phase, artifactId, draftRawLogHistories),
                { validatedOnly: validatedDraftRawOnly },
              )
            : undefined}
        >
          {structured || <RawContentView content={winnerContent} />}
        </WithRawTab>
      )
    }

    const memberMatch = artifactId?.match(/member-(.+)$/)
    const memberId = memberMatch?.[1] ? decodeURIComponent(memberMatch[1]) : null

    const draftIndex = !memberId ? artifactId?.match(/(\d+)$/)?.[1] : null
    const draftIdx = draftIndex ? parseInt(draftIndex, 10) - 1 : -1

    const draftSource = memberId
      ? (councilResult.drafts?.find(d => d.memberId === memberId) ?? null)
      : (draftIdx >= 0 ? (councilResult.drafts?.[draftIdx] ?? null) : null)
    const draft = draftSource
      ? withDraftRawLogFallback(draftSource, phase, artifactId, draftRawLogFallbacks)
      : null
    const draftContent = draft
      ? (isFailedCouncilDraftOutcome(draft.outcome) ? '' : draft.content ?? '')
      : councilResult.refinedContent ?? councilResult.winnerContent ?? ''

    const header = draft ? (
      <ModelBadge
        modelId={draft.memberId}
        active={draft.memberId === councilResult.winnerId && !phase?.includes('DELIBERATING') && !phase?.includes('DRAFTING')}
        className="px-3 py-2 h-auto flex-1 justify-start"
      >
        <div className="min-w-0 text-left">
          <div className="text-xs font-medium truncate">{getModelDisplayName(draft.memberId)}</div>
          <div className="text-[10px] mt-0.5 opacity-80 flex items-center gap-1 flex-wrap normal-case">
            <span className="flex items-center gap-1">
              <CouncilStatusIcon outcome={draft.outcome} action="drafting" className="h-3 w-3" />
              <span>{draft.outcome === 'pending' ? 'In progress' : getCouncilStatusLabel(draft.outcome, 'drafting')}</span>
            </span>
            {draft.duration ? <span>· {(draft.duration / 1000).toFixed(1)}s</span> : null}
            {draft.memberId === councilResult.winnerId && !phase?.includes('DELIBERATING') && !phase?.includes('DRAFTING') && (
              <span className="ml-1 flex items-center gap-1 font-bold text-primary-foreground/90">
                <Trophy className="h-3 w-3" />
                <span>Winner</span>
              </span>
            )}
          </div>
        </div>
      </ModelBadge>
    ) : null

    if (draft && isFailedCouncilDraftOutcome(draft.outcome)) {
      const isFullAnswers = isPrdFullAnswersArtifactId(artifactId)
      const isInterview = Boolean(artifactId?.startsWith('draft') || artifactId?.includes('interview'))
      const isPrd = isStructuredPrdArtifactId(artifactId) && !isFullAnswers
      const isBeads = Boolean(artifactId?.includes('beads'))
      const noticeOutput = validatedDraftRawOnly
        ? draft.structuredOutput
        : withRawNormalizationNotice(draft.structuredOutput, draft.rawResponse, draft.normalizedResponse, '')
      const diagnosticContent = JSON.stringify({
        memberId: draft.memberId,
        outcome: draft.outcome,
        error: draft.error,
        validationError: draft.structuredOutput?.validationError,
      }, null, 2)
      const rawContent = validatedDraftRawOnly
        ? (getValidatedDraftContent(draft) ?? diagnosticContent)
        : draft.rawResponse ?? getRejectedRawAttempt(draft.rawAttempts) ?? draft.content ?? diagnosticContent
      return (
        <WithRawTab
          content={rawContent}
          structuredLabel="Diagnostics"
          header={header}
          notice={<ArtifactProcessingNotice structuredOutput={noticeOutput} kind={getCouncilDraftNoticeKind({ isFullAnswers, isInterview, isPrd, isBeads })} status={draft.outcome} />}
          rawSources={buildDraftRawSources(
            draft,
            getRejectedDraftRawResponse(draft, phase, artifactId, draftRawLogHistories),
            { validatedOnly: validatedDraftRawOnly },
          )}
        >
          <CouncilDraftFailureDiagnostics draft={draft} />
        </WithRawTab>
      )
    }

    if (draftContent) {
      const isFullAnswers = isPrdFullAnswersArtifactId(artifactId)
      const isInterview = Boolean(artifactId?.startsWith('draft') || artifactId?.includes('interview'))
      const isPrd = isStructuredPrdArtifactId(artifactId) && !isFullAnswers
      const isBeads = Boolean(artifactId?.includes('beads'))
      const noticeKind = getCouncilDraftNoticeKind({ isFullAnswers, isInterview, isPrd, isBeads })
      const noticeContext = isFullAnswers ? getFullAnswersNoticeContext(draftContent) : undefined
      const noticeOutput = draft
        ? validatedDraftRawOnly
          ? draft.structuredOutput
          : withRawNormalizationNotice(draft.structuredOutput, draft.rawResponse, draft.normalizedResponse, draftContent)
        : undefined

      const structured = isFullAnswers ? <InterviewAnswersView content={draftContent} />
        : isInterview ? <InterviewDraftView content={draftContent} />
          : isPrd ? <PrdDraftView content={draftContent} />
            : isBeads ? <BeadsDraftView content={draftContent} />
              : null

      if (structured) {
        return (
          <WithRawTab
            content={draftContent}
            structuredLabel="Draft"
            header={header}
            notice={<ArtifactProcessingNotice structuredOutput={noticeOutput} kind={noticeKind} context={noticeContext} status={draft?.outcome ?? 'completed'} />}
            rawSources={draft
              ? buildDraftRawSources(
                  draft,
                  getRejectedDraftRawResponse(draft, phase, artifactId, draftRawLogHistories),
                  { validatedOnly: validatedDraftRawOnly },
                )
              : undefined}
          >
            {structured}
          </WithRawTab>
        )
      }
      return <RawContentWithCopy content={draftContent} />
    }

    if (draft) {
      const waitingMessage = draft.outcome === 'pending'
        ? 'Artifact is still being generated for this member.'
        : draft.outcome === 'timed_out'
          ? 'No response was received before the council timeout.'
          : draft.outcome === 'failed'
            ? (draft.error || 'This member failed before producing output.')
            : draft.outcome === 'invalid_output'
              ? (draft.error || 'This member returned malformed output.')
              : 'No content available yet.'
      const noticeOutput = withRawNormalizationNotice(draft.structuredOutput, draft.rawResponse, draft.normalizedResponse, draft.content)
      return (
        <div className="space-y-3">
          {header}
          <div className="text-xs text-muted-foreground italic">{waitingMessage}</div>
          <ArtifactProcessingNotice
            structuredOutput={noticeOutput}
            kind={getCouncilDraftNoticeKind({
              isFullAnswers: isPrdFullAnswersArtifactId(artifactId),
              isInterview: Boolean(artifactId?.startsWith('draft') || artifactId?.includes('interview')),
              isPrd: isStructuredPrdArtifactId(artifactId) && !isPrdFullAnswersArtifactId(artifactId),
              isBeads: Boolean(artifactId?.includes('beads')),
            })}
            context={isPrdFullAnswersArtifactId(artifactId) && draft.content ? getFullAnswersNoticeContext(draft.content) : undefined}
            status={draft.outcome}
          />
        </div>
      )
    }
  }

  return <RawContentWithCopy content={content} />
}
