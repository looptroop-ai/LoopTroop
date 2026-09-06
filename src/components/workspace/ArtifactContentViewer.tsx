import { useEffect, useMemo, useRef, useState } from 'react'
import * as jsYaml from 'js-yaml'
import { commandSpecSchema, renderCommandSpec, type CommandSpec } from '@shared/commandSpec'
import { closeTag, openTag, PROTOCOL_TAGS } from '@shared/protocolTags'
import {
  mergeStructuredInterventions,
  normalizeStructuredInterventions,
  STRUCTURED_INTERVENTION_CATEGORY_ORDER,
} from '@shared/structuredInterventions'
import type {
  StructuredIntervention,
} from '@shared/structuredInterventions'
import {
  mergeStructuredRetryDiagnostics,
  type StructuredRetryDiagnostic,
} from '@shared/structuredRetryDiagnostics'
import { ChevronDown, ChevronRight, Trophy, Copy, Check, Lightbulb, CheckCircle2, XCircle, AlertTriangle, FileCode2, ExternalLink, GitPullRequest } from 'lucide-react'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import { ModelBadge, ModelIcon } from '@/components/shared/ModelBadge'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { useLogs } from '@/context/useLogContext'
import type { LogEntry } from '@/context/logUtils'
import { parseExecutionSetupPlanContent } from '@/lib/executionSetupPlan'
import type {
  ArtifactStructuredOutputData,
  ArtifactRawAttemptData,
  CleanupReportData,
  CoverageArtifactData,
  CoverageGapResolutionData,
  CoverageTransitionData,
  InterviewArtifactData,
  InterviewArtifactQuestion,
  InterviewDiffArtifactData,
  InterviewDiffEntry,
  CoverageInputData,
  CouncilDraftData,
  CouncilResultData,
  CouncilVoterDetailData,
  CouncilOutcome,
  ExecutionSetupProfileData,
  ExecutionSetupPlanReportData,
  ExecutionSetupRuntimeReportData,
  FinalTestExecutionReportData,
  IntegrationReportData,
  PullRequestCandidateFileAuditData,
  PullRequestCandidateFileAuditEntry,
  PullRequestReportData,
  RelevantFileScanEntry,
  RelevantFilesScanData,
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
  normalizeCoverageFollowUpArtifacts,
  parseCleanupReport,
  parseCoverageArtifact,
  parseExecutionSetupProfile,
  parseExecutionSetupPlanReport,
  parseExecutionSetupRuntimeReport,
  parseIntegrationReport,
  parsePullRequestReport,
  parseInterviewQuestions,
  parseRefinementArtifact,
  normalizeRawAttempts,
} from './phaseArtifactTypes'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'
import { parseInterviewDocument, normalizeInterviewDocumentLike } from '@/lib/interviewDocument'
import {
  buildCombinedDiffFromBeads,
  groupFileDiffsByPath,
  parseBeadCommitsDiffContent,
  parseDiffStats,
  parseFileDiffs,
  sortBeadCommitsByPriority,
  computeLineNumbersWithWordDiff,
  type FileDiff,
  type FileDiffGroup,
} from './diffUtils'
import { renderWordDiffSegments, renderUnifiedDiffLineText } from './diffWordHighlights'
import { InterviewDocumentView } from './InterviewDocumentView'
import {
  getCouncilStatusLabel,
} from './councilArtifacts'
import { CouncilStatusIcon } from './CouncilStatusIcon'
import {
  buildArtifactProcessingNoticeCopy,
  getStructuredOutputInterventions,
  getStructuredOutputSourceMessages,
  getStructuredOutputWarnings,
  hasArtifactProcessingNotice,
  INTERVENTION_CATEGORY_COPY,
  INTERVENTION_STAGE_LABELS,
} from './artifactProcessingNotice'
import type {
  ArtifactProcessingKind,
  ArtifactProcessingNoticeContext,
  ArtifactProcessingStatus,
} from './artifactProcessingNotice'
import { buildReadableRawDisplayContent } from './rawDisplayContent'
import { CopyButton, RawContentWithCopy, RawDisplayPre, RawDisplayStats } from './RawTextDisplay'
import { getSafeGitHubPullRequestUrl } from '@/lib/githubUrls'
import { ManualQaOriginBadge, ManualQaOriginCard } from './ManualQaOriginCard'
import type { ManualQaBeadOrigin } from '@/hooks/useTickets'

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

export function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  className,
  headerActions,
  headerClassName,
  triggerClassName,
  contentClassName,
  scrollOnOpen = true,
}: {
  title: React.ReactNode
  defaultOpen?: boolean
  children: React.ReactNode
  className?: string
  headerActions?: React.ReactNode
  headerClassName?: string
  triggerClassName?: string
  contentClassName?: string
  scrollOnOpen?: boolean
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const sectionRef = useRef<HTMLDivElement>(null)
  const previousOpenRef = useRef(isOpen)

  useEffect(() => {
    if (scrollOnOpen && !previousOpenRef.current && isOpen) {
      sectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })
    }
    previousOpenRef.current = isOpen
  }, [isOpen, scrollOnOpen])

  return (
    <div
      ref={sectionRef}
      className={cn('border border-border/70 rounded-lg overflow-hidden flex flex-col min-w-0 w-full shadow-2xs', className)}
    >
      <div className={cn('flex flex-wrap items-start gap-2 min-w-0', headerClassName)}>
        <button
          type="button"
          aria-expanded={isOpen}
          onClick={() => setIsOpen((current) => !current)}
          className={cn(
            'flex items-center gap-1.5 flex-1 min-w-0 px-3 py-2 text-xs font-mono font-medium hover:bg-muted/30 transition-all text-left',
            triggerClassName,
          )}
        >
          {isOpen ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <span className="min-w-0 flex-1 flex items-center">{title}</span>
        </button>
        {headerActions ? <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2">{headerActions}</div> : null}
      </div>
      {isOpen && <div className={cn('px-3 pb-3 text-xs overflow-x-auto w-full', contentClassName)}>{children}</div>}
    </div>
  )
}

export { CopyButton }

export function TextCopyButton({ content, title, className = '' }: { content: string; title: string; className?: string }) {
  const [copied, copyToClipboard] = useCopyToClipboard()

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    copyToClipboard(content)
  }

  return (
    <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={handleCopy}
            className={`opacity-0 group-hover:opacity-100 transition-opacity hover:opacity-80 focus:opacity-100 outline-none ${className}`}
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-center text-balance">{title}</TooltipContent>
      </Tooltip>
  )
}

interface RawContentSource {
  id: string
  label: string
  content?: string
  displayContent?: string
  modelId?: string
  disabled?: boolean
  title?: string
  variants?: RawContentVariant[]
}

interface RawContentVariant {
  id: string
  label: string
  content?: string
  displayContent?: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  labelClassName?: string
  skipDedupe?: boolean
}

interface ActiveRawContentSource {
  id: string
  label: string
  content?: string
  displayContent?: string
  modelId?: string
  disabled?: boolean
  title?: string
  parentId: string
}

function normalizeRawContentSource(source: RawContentSource): ActiveRawContentSource {
  return {
    ...source,
    parentId: source.id,
  }
}

function normalizeRawContentVariant(source: RawContentSource, variant: RawContentVariant): ActiveRawContentSource {
  return {
    ...variant,
    modelId: source.modelId,
    parentId: source.id,
  }
}

/** Find the first non-disabled validated variant. Checks variant.id for `:validated`
 *  or variant.label for a case-insensitive "validated" match. */
function findFirstValidatedVariant(variants: RawContentVariant[]): RawContentVariant | undefined {
  return variants.find(
    (v) => !v.disabled && (v.id.includes(':validated') || /validated/i.test(v.label)),
  )
}

function getRawSourceDefaultSelection(source: RawContentSource): ActiveRawContentSource | null {
  if (source.variants?.length) {
    const validatedVariant = findFirstValidatedVariant(source.variants)
    if (validatedVariant) return normalizeRawContentVariant(source, validatedVariant)
    const variant = source.variants.find((entry) => !entry.disabled)
    return variant ? normalizeRawContentVariant(source, variant) : null
  }
  return source.disabled ? null : normalizeRawContentSource(source)
}

function findRawSourceSelection(sources: RawContentSource[], selectionId: string): ActiveRawContentSource | null {
  for (const source of sources) {
    if (source.variants?.length) {
      const variant = source.variants.find((entry) => entry.id === selectionId && !entry.disabled)
      if (variant) return normalizeRawContentVariant(source, variant)
      if (source.id === selectionId) return getRawSourceDefaultSelection(source)
      continue
    }
    if (source.id === selectionId && !source.disabled) return normalizeRawContentSource(source)
  }
  return null
}

function isRawContentSourceSelectable(source: RawContentSource): boolean {
  return getRawSourceDefaultSelection(source) !== null
}

function canShowRawSourceSelector(rawSourceOptions: RawContentSource[]): boolean {
  return rawSourceOptions.length > 1
    || rawSourceOptions.some((source) => Boolean(source.modelId) || (source.variants?.length ?? 0) > 1)
}

function shouldOmitAggregateRawSource(rawSources: RawContentSource[] | undefined): boolean {
  const selectableSources = rawSources?.filter(isRawContentSourceSelectable) ?? []
  return selectableSources.length === 1 && Boolean(selectableSources[0]?.modelId)
}

function buildAggregateRawSource(content: string, rawSources: RawContentSource[] | undefined): RawContentSource {
  const rawSourceCount = rawSources?.length ?? 0
  const selectableSourceCount = rawSources?.filter(isRawContentSourceSelectable).length ?? 0
  const hasMultipleSelectableSources = selectableSourceCount > 1 || (selectableSourceCount === 0 && rawSourceCount > 1)
  return {
    id: 'all',
    label: hasMultipleSelectableSources ? 'All Models' : 'Artifact',
    content,
    title: hasMultipleSelectableSources ? 'Show raw artifact for all models' : 'Show stored raw artifact',
  }
}

function getRawSourceFallbackSelection(sources: RawContentSource[]): ActiveRawContentSource | null {
  // First pass: prefer a source that has a validated variant
  for (const source of sources) {
    if (source.variants?.length) {
      const validatedVariant = findFirstValidatedVariant(source.variants)
      if (validatedVariant) return normalizeRawContentVariant(source, validatedVariant)
    }
  }
  // Fallback: first selectable source
  for (const source of sources) {
    const selection = getRawSourceDefaultSelection(source)
    if (selection) return selection
  }
  return sources[0] ? normalizeRawContentSource(sources[0]) : null
}

function RawAttemptVariantSelector({
  source,
  activeVariantId,
  onSelect,
  ariaLabel,
}: {
  source?: RawContentSource
  activeVariantId?: string
  onSelect: (variantId: string) => void
  ariaLabel: string
}) {
  if (!source?.variants?.length) return null
  const label = source.label || (source.modelId ? getModelDisplayName(source.modelId) : source.id)

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className="inline-flex min-w-0 max-w-full overflow-hidden rounded-lg border border-border/70 bg-background shadow-2xs"
    >
      <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 bg-muted/60 px-2.5 py-1 text-[10px] font-mono font-medium text-foreground">
        {source.modelId ? <ModelIcon modelId={source.modelId} className="h-3 w-3" /> : null}
        <span className="min-w-0 truncate">{label}</span>
      </span>
      {source.variants.map((variant) => {
        const active = activeVariantId === variant.id
        const disabled = Boolean(variant.disabled)
        return (
          <Tooltip key={variant.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-pressed={active}
                aria-label={variant.ariaLabel ?? `${label} ${variant.label}`}
                onClick={() => onSelect(variant.id)}
                className={cn(
                  'inline-flex min-w-0 max-w-full items-center gap-1.5 border-l border-border px-2.5 py-1 text-[10px] font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                  disabled && 'cursor-not-allowed hover:bg-background hover:text-muted-foreground',
                )}
              >
                <span className={cn('min-w-0 truncate', variant.labelClassName)}>{variant.label}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-center text-balance">{variant.title}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

export function WithRawTab({
  content,
  structuredLabel,
  children,
  header,
  notice,
  rawSources,
}: {
  content: string
  structuredLabel: string
  children: React.ReactNode
  header?: React.ReactNode
  notice?: React.ReactNode
  rawSources?: RawContentSource[]
}) {
  const [activeTab, setActiveTab] = useState<'structured' | 'raw'>('structured')
  const [activeRawSourceId, setActiveRawSourceId] = useState('all')
  const rawSourceOptions = useMemo<RawContentSource[]>(() => {
    if (shouldOmitAggregateRawSource(rawSources)) return rawSources ?? []
    const aggregateSource = buildAggregateRawSource(content, rawSources)
    return [aggregateSource, ...(rawSources ?? [])]
  }, [content, rawSources])
  const activeRawSource = findRawSourceSelection(rawSourceOptions, activeRawSourceId)
    ?? getRawSourceFallbackSelection(rawSourceOptions)
    ?? { id: 'all', label: 'All Models', content, parentId: 'all' }
  const activeRawContent = activeRawSource.content ?? ''
  const activeRawDisplayContent = activeRawSource.displayContent ?? buildReadableRawDisplayContent(activeRawContent)
  const shouldShowRawSourceSelector = canShowRawSourceSelector(rawSourceOptions)

  useEffect(() => {
    if (!findRawSourceSelection(rawSourceOptions, activeRawSourceId)) {
      setActiveRawSourceId(getRawSourceFallbackSelection(rawSourceOptions)?.id ?? 'all')
    }
  }, [activeRawSourceId, rawSourceOptions])

  return (
    <div className="min-w-0 max-w-full space-y-3">
      <div className="flex items-center gap-2">
        {header && <div className="flex-1 min-w-0">{header}</div>}
        <div className={`inline-flex items-center gap-1 rounded-md border border-border bg-background p-1 shrink-0 ${!header ? 'ml-auto' : ''}`}>
          <button
            onClick={() => setActiveTab('structured')}
            className={activeTab === 'structured'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            {structuredLabel}
          </button>
          <button
            onClick={() => setActiveTab('raw')}
            className={activeTab === 'raw'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            Raw
          </button>
          {activeTab === 'raw' && <CopyButton content={activeRawContent} />}
        </div>
      </div>

      {activeTab === 'structured' ? notice : null}

      {activeTab === 'raw' && (
        <>
          {shouldShowRawSourceSelector && (
            <div className="flex min-w-0 max-w-full flex-wrap gap-1.5 overflow-hidden" aria-label="Raw vote source">
              {rawSourceOptions.map((source) => {
                const label = source.label || (source.modelId ? getModelDisplayName(source.modelId) : source.id)
                if (source.variants?.length) {
                  const sourceActive = activeRawSource.parentId === source.id
                  const enabledVariants = source.variants.filter((variant) => !variant.disabled)
                  const disabled = enabledVariants.length === 0
                  return (
                    <div
                      key={source.id}
                      role="group"
                      aria-label={`${label} raw output`}
                      className={cn(
                        'inline-flex min-w-0 max-w-full overflow-hidden rounded-md border bg-background',
                        sourceActive ? 'border-primary' : 'border-border',
                        disabled && 'opacity-45',
                      )}
                    >
                      <span
                        className={cn(
                          'inline-flex min-w-0 max-w-full items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium',
                          sourceActive ? 'bg-muted text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {source.modelId ? <ModelIcon modelId={source.modelId} className="h-3 w-3" /> : null}
                        <span className="min-w-0 truncate">{label}</span>
                      </span>
                      {source.variants.map((variant) => {
                        const active = activeRawSource.id === variant.id
                        const variantDisabled = Boolean(variant.disabled)
                        return (
                          <Tooltip key={variant.id}>
                              <TooltipTrigger asChild>
                                <button
                                                        type="button"
                                                        disabled={variantDisabled}
                                                        aria-pressed={active}
                                                        aria-label={variant.ariaLabel ?? `${label} ${variant.label}`}
                                                        onClick={() => setActiveRawSourceId(variant.id)}
                                                        className={cn(
                                                          'inline-flex min-w-0 max-w-full items-center gap-1.5 px-2.5 py-1 text-[10px] font-medium transition-colors',
                                                          'border-l border-border',
                                                          active
                                                            ? 'bg-primary text-primary-foreground'
                                                            : 'text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                                                          variantDisabled && 'cursor-not-allowed hover:bg-background hover:text-muted-foreground',
                                                        )}
                                                      >
                                                        <span className={cn('min-w-0 truncate', variant.labelClassName)}>{variant.label}</span>
                                                      </button>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs text-center text-balance">{variant.title}</TooltipContent>
                            </Tooltip>
                        )
                      })}
                    </div>
                  )
                }
                const active = activeRawSource.id === source.id
                const disabled = Boolean(source.disabled)
                return (
                  <Tooltip key={source.id}>
                      <TooltipTrigger asChild>
                        <button
                                        type="button"
                                        disabled={disabled}
                                        aria-pressed={active}
                                        onClick={() => setActiveRawSourceId(source.id)}
                                        className={cn(
                                          'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-medium transition-colors',
                                          active
                                            ? 'border-primary bg-primary text-primary-foreground'
                                            : 'border-border bg-background text-muted-foreground hover:bg-accent/70 hover:text-foreground',
                                          disabled && 'cursor-not-allowed opacity-45 hover:bg-background hover:text-muted-foreground',
                                        )}
                                      >
                                        {source.modelId ? <ModelIcon modelId={source.modelId} className="h-3 w-3" /> : null}
                                        <span className="min-w-0 truncate">{label}</span>
                                      </button>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-center text-balance">{source.title}</TooltipContent>
                    </Tooltip>
                )
              })}
            </div>
          )}
          <RawDisplayStats content={activeRawDisplayContent} />
        </>
      )}

      {activeTab === 'structured' ? (
        <>
          {children}
        </>
      ) : (
        <RawDisplayPre content={activeRawDisplayContent} />
      )}
    </div>
  )
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

export function RawContentView({ content }: { content: string }) {
  const lines = content.split('\n')
  return (
    <div className="text-sm space-y-1">
      {lines.map((line, i) => {
        if (line.startsWith('# ')) return <h2 key={i} className="text-lg font-bold mt-3 mb-1">{line.slice(2)}</h2>
        if (line.startsWith('## ')) return <h3 key={i} className="text-base font-semibold mt-2 mb-1">{line.slice(3)}</h3>
        if (line.startsWith('### ')) return <h4 key={i} className="text-sm font-semibold mt-2">{line.slice(4)}</h4>
        if (line.startsWith('✅')) return <div key={i} className="flex items-center gap-1 text-green-600"><span>{line}</span></div>
        if (line.startsWith('⚠️')) return <div key={i} className="flex items-center gap-1 text-yellow-600"><span>{line}</span></div>
        if (line.startsWith('❌')) return <div key={i} className="flex items-center gap-1 text-red-600"><span>{line}</span></div>
        if (line.startsWith('|')) return <div key={i} className="font-mono text-xs">{line}</div>
        if (line.startsWith('- ') || line.startsWith('* ')) return <div key={i} className="ml-4">• {line.slice(2)}</div>
        if (line.match(/^\d+\./)) return <div key={i} className="ml-4">{line}</div>
        if (line.startsWith('**') && line.endsWith('**')) return <div key={i} className="font-semibold">{line.replace(/\*\*/g, '')}</div>
        if (line.trim() === '') return <div key={i} className="h-2" />
        return <div key={i}>{line}</div>
      })}
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
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {getRefinementInspirationBlockKindLabel(block.kind)}
                      {block.id ? <span className="ml-1 font-mono normal-case tracking-normal">{block.id}</span> : null}
                    </div>
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

function mergeStructuredOutputMetadata(
  outputs: Array<ArtifactStructuredOutputData | undefined | null>,
): ArtifactStructuredOutputData | undefined {
  const present = outputs.filter((output): output is ArtifactStructuredOutputData => Boolean(output))
  if (present.length === 0) return undefined

  return present.reduce<ArtifactStructuredOutputData>((merged, output) => ({
    repairApplied: Boolean(merged.repairApplied || output.repairApplied),
    repairWarnings: [...(merged.repairWarnings ?? []), ...getStructuredOutputWarnings(output)],
    autoRetryCount: Math.max(merged.autoRetryCount ?? 0, output.autoRetryCount ?? 0),
    ...(mergeStructuredRetryDiagnostics(merged.retryDiagnostics, output.retryDiagnostics).length > 0
      ? { retryDiagnostics: mergeStructuredRetryDiagnostics(merged.retryDiagnostics, output.retryDiagnostics) }
      : {}),
    interventions: mergeStructuredInterventions(
      normalizeStructuredInterventions(merged.interventions),
      normalizeStructuredInterventions(output.interventions),
    ),
    ...(output.validationError
      ? { validationError: output.validationError }
      : merged.validationError
        ? { validationError: merged.validationError }
        : {}),
  }), {
    repairApplied: false,
    repairWarnings: [],
    autoRetryCount: 0,
  })
}

const RAW_NORMALIZATION_WARNING = 'Normalized saved artifact details from raw model output before saving the validated artifact.'

function buildRawNormalizationIntervention(): StructuredIntervention {
  return {
    code: 'cleanup_raw_normalization',
    stage: 'normalize',
    category: 'cleanup',
    title: 'Saved validated output instead of raw model text',
    summary: 'The raw model response and the persisted validated artifact differed.',
    why: 'The raw response included formatting or wrapper detail that was not part of the validated artifact shape.',
    how: 'LoopTroop persisted the normalized validated artifact while keeping the raw response available in the Raw view.',
    rule: {
      id: 'cleanup_raw_normalization',
      label: 'Raw Output Normalization',
    },
    exactCorrection: 'Persisted the validated structured output instead of the raw model text.',
    technicalDetail: RAW_NORMALIZATION_WARNING,
    rawMessages: [RAW_NORMALIZATION_WARNING],
  }
}

function didPersistedOutputChange(
  rawResponse?: string,
  normalizedResponse?: string,
  content?: string,
): boolean {
  if (typeof rawResponse !== 'string') return false
  const validated = typeof normalizedResponse === 'string'
    ? normalizedResponse
    : typeof content === 'string'
      ? content
      : undefined
  return typeof validated === 'string' && rawResponse !== validated
}

function withRawNormalizationNotice(
  structuredOutput?: ArtifactStructuredOutputData,
  rawResponse?: string,
  normalizedResponse?: string,
  content?: string,
): ArtifactStructuredOutputData | undefined {
  if (!didPersistedOutputChange(rawResponse, normalizedResponse, content)) return structuredOutput
  if (hasArtifactProcessingNotice(structuredOutput)) return structuredOutput

  const repairWarnings = getStructuredOutputWarnings(structuredOutput)
  const interventions = mergeStructuredInterventions(
    normalizeStructuredInterventions(structuredOutput?.interventions),
    [buildRawNormalizationIntervention()],
  )
  return {
    ...(structuredOutput ?? {}),
    repairApplied: true,
    repairWarnings: repairWarnings.includes(RAW_NORMALIZATION_WARNING)
      ? repairWarnings
      : [...repairWarnings, RAW_NORMALIZATION_WARNING],
    autoRetryCount: structuredOutput?.autoRetryCount ?? 0,
    interventions,
  }
}

function CollapsibleWarningNotice({
  title,
  summary,
  body,
  detail,
  headerActions,
  defaultOpen = false,
}: {
  title: React.ReactNode
  summary?: React.ReactNode
  body?: React.ReactNode
  detail?: React.ReactNode
  headerActions?: React.ReactNode
  defaultOpen?: boolean
}) {
  if (!summary && !body && !detail) {
    return null
  }

  return (
    <CollapsibleSection
      title={(
        <span className="flex min-w-0 flex-col items-start gap-0">
          <span className="text-[10px] font-medium leading-[0.85rem]">{title}</span>
          {summary ? (
            <span className="text-[9px] font-normal leading-[0.8rem] opacity-80">
              {summary}
            </span>
          ) : null}
        </span>
      )}
      defaultOpen={defaultOpen}
      scrollOnOpen={false}
      className="border-amber-200 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/20"
      headerActions={headerActions}
      triggerClassName="gap-0.5 px-2 py-1 text-amber-950 hover:bg-amber-100/60 dark:text-amber-100 dark:hover:bg-amber-900/20"
      contentClassName="pt-0 text-amber-950 dark:text-amber-100"
    >
      {body ? <div className="leading-5">{body}</div> : null}
      {detail ? (
        <div className={cn('text-[11px] opacity-90 leading-5', body ? 'mt-1' : undefined)}>
          {detail}
        </div>
      ) : null}
    </CollapsibleSection>
  )
}


function ArtifactInterventionBreakdown({ interventions }: { interventions: StructuredIntervention[] }) {
  const groups = STRUCTURED_INTERVENTION_CATEGORY_ORDER
    .map((category) => ({
      category,
      interventions: interventions.filter((intervention) => intervention.category === category),
    }))
    .filter((group) => group.interventions.length > 0)

  return (
    <div className="min-w-0 max-w-full space-y-3">
      {groups.map((group) => {
        const categoryCopy = INTERVENTION_CATEGORY_COPY[group.category]
        return (
          <div key={group.category} className="space-y-2">
            <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider">
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 font-semibold ${categoryCopy.className}`}>
                {categoryCopy.label}
              </span>
              <span className="opacity-80">{group.interventions.length}</span>
            </div>
            <div className="space-y-2">
              {group.interventions.map((intervention, index) => {
                const rawMessages = intervention.rawMessages ?? []
                const hasTechnicalDetailInRawMessages = Boolean(
                  intervention.technicalDetail
                  && rawMessages.some((message) => message.trim() === intervention.technicalDetail?.trim()),
                )

                return (
                  <div key={`${group.category}:${intervention.code}:${index}`} className="rounded-md border border-amber-300/60 bg-background/70 px-3 py-2 dark:border-amber-900/50">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-xs font-semibold">{intervention.title}</div>
                      <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                        {INTERVENTION_STAGE_LABELS[intervention.stage]}
                      </span>
                      {intervention.target ? (
                        <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-mono text-foreground">
                          {intervention.target}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 space-y-1 text-[11px] leading-5">
                      {intervention.exactCorrection ? (
                        <div><span className="font-medium">Exact correction:</span> {intervention.exactCorrection}</div>
                      ) : null}
                      {intervention.rule ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">Rule:</span>
                          <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground">
                            {intervention.rule.label}
                          </span>
                          <span className="rounded-full border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {intervention.rule.id}
                          </span>
                        </div>
                      ) : null}
                      {intervention.examples && intervention.examples.length > 0 ? (
                        <div className="space-y-2 rounded border border-border bg-background/80 px-2 py-2">
                          {intervention.examples.map((example, exampleIndex) => (
                            <div key={`${group.category}:${intervention.code}:${index}:example:${exampleIndex}`} className="space-y-1">
                              {example.scope ? (
                                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                  {example.scope}
                                </div>
                              ) : null}
                              {example.before ? (
                                <div>
                                  <span className="font-medium">Before:</span>{' '}
                                  <span className="font-mono text-[10px] text-muted-foreground">{example.before}</span>
                                </div>
                              ) : null}
                              {example.after ? (
                                <div>
                                  <span className="font-medium">After:</span>{' '}
                                  <span className="font-mono text-[10px] text-muted-foreground">{example.after}</span>
                                </div>
                              ) : null}
                              {example.note ? (
                                <div><span className="font-medium">Note:</span> {example.note}</div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div><span className="font-medium">What:</span> {intervention.summary}</div>
                      <div><span className="font-medium">Why:</span> {intervention.why}</div>
                      <div><span className="font-medium">How:</span> {intervention.how}</div>
                      {intervention.technicalDetail && !hasTechnicalDetailInRawMessages ? (
                        <div className="rounded border border-border bg-background px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground">
                          {intervention.technicalDetail}
                        </div>
                      ) : null}
                      {rawMessages.length > 0 ? (
                        <div className="space-y-1">
                          <div className="font-medium">Raw message{rawMessages.length === 1 ? '' : 's'}:</div>
                          <div className="space-y-1">
                            {rawMessages.map((message, messageIndex) => (
                              <pre
                                key={`${group.category}:${intervention.code}:${index}:raw:${messageIndex}`}
                                className="overflow-x-auto rounded border border-border bg-background px-2 py-1 font-mono text-[10px] leading-4 text-muted-foreground whitespace-pre-wrap"
                              >
                                {message}
                              </pre>
                            ))}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ArtifactSourceMessages({ messages }: { messages: string[] }) {
  if (messages.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
        Raw Source Messages <span className="normal-case tracking-normal opacity-70">({messages.length})</span>
      </div>
      <div className="space-y-1">
        {messages.map((message, index) => (
          <pre
            key={`${index}:${message}`}
            className="overflow-x-auto rounded border border-amber-300/60 bg-background/70 px-2 py-2 font-mono text-[10px] leading-4 text-muted-foreground whitespace-pre-wrap dark:border-amber-900/50"
          >
            {message}
          </pre>
        ))}
      </div>
    </div>
  )
}

function normalizeNoticeRawMessage(message: string): string {
  return message.trim()
}

function getUndisplayedSourceMessages(
  structuredOutput: ArtifactStructuredOutputData | undefined,
  interventions: StructuredIntervention[],
  retryDiagnostics: StructuredRetryDiagnostic[],
): string[] {
  const displayed = new Set<string>()

  for (const intervention of interventions) {
    if (intervention.technicalDetail) {
      displayed.add(normalizeNoticeRawMessage(intervention.technicalDetail))
    }
    for (const message of intervention.rawMessages ?? []) {
      displayed.add(normalizeNoticeRawMessage(message))
    }
  }

  for (const diagnostic of retryDiagnostics) {
    displayed.add(normalizeNoticeRawMessage(diagnostic.validationError))
    displayed.add(normalizeNoticeRawMessage(`Retry attempt ${diagnostic.attempt} excerpt:\n${diagnostic.excerpt.trim()}`))
  }

  return getStructuredOutputSourceMessages(structuredOutput)
    .filter((message) => !displayed.has(normalizeNoticeRawMessage(message)))
}

function formatRetryDiagnosticLocation(diagnostic: StructuredRetryDiagnostic): string | null {
  const parts: string[] = []
  if (diagnostic.target) parts.push(diagnostic.target)
  if (diagnostic.line) {
    parts.push(
      diagnostic.column
        ? `line ${diagnostic.line}, column ${diagnostic.column}`
        : `line ${diagnostic.line}`,
    )
  }
  return parts.length > 0 ? parts.join(' · ') : null
}

function ArtifactRetryDiagnostics({ diagnostics }: { diagnostics: StructuredRetryDiagnostic[] }) {
  if (diagnostics.length === 0) return null

  const orderedDiagnostics = [...diagnostics].sort((left, right) => left.attempt - right.attempt)

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">
        Retry Attempts <span className="normal-case tracking-normal opacity-70">({orderedDiagnostics.length})</span>
      </div>
      <div className="space-y-2">
        {orderedDiagnostics.map((diagnostic) => {
          const location = formatRetryDiagnosticLocation(diagnostic)
          const excerptLabel = location ? 'Failing excerpt' : 'Best-effort excerpt'
          return (
            <div
              key={`${diagnostic.attempt}:${diagnostic.validationError}:${diagnostic.excerpt}`}
              className="rounded-md border border-amber-300/60 bg-background/70 px-3 py-2 dark:border-amber-900/50"
            >
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-xs font-semibold">Attempt {diagnostic.attempt}</div>
                {diagnostic.failureClass ? (
                  <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                    {diagnostic.failureClass}
                  </span>
                ) : null}
              </div>
              <div className="mt-1 space-y-1 text-[11px] leading-5">
                <div><span className="font-medium">Why:</span> {diagnostic.validationError}</div>
                {location ? (
                  <div><span className="font-medium">Where:</span> {location}</div>
                ) : null}
                <div className="space-y-1">
                  <div className="font-medium">{excerptLabel}:</div>
                  <pre className="overflow-x-auto rounded border border-border bg-background px-2 py-2 font-mono text-[10px] leading-4 text-muted-foreground whitespace-pre-wrap">
                    {diagnostic.excerpt}
                  </pre>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ArtifactInterventionOwnerBreakdown({
  owners,
}: {
  owners: Array<{ label: string; structuredOutput?: ArtifactStructuredOutputData }>
}) {
  if (owners.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider opacity-80">Affected Models</div>
      <div className="space-y-2">
        {owners.map((owner) => (
          <div key={owner.label} className="rounded-md border border-amber-300/60 bg-background/70 px-3 py-2 dark:border-amber-900/50">
            <div className="mb-2 text-xs font-semibold">{owner.label}</div>
            <div className="space-y-3">
              {(() => {
                const interventions = getStructuredOutputInterventions(owner.structuredOutput)
                const retryDiagnostics = owner.structuredOutput?.retryDiagnostics ?? []
                return (
                  <>
                    <ArtifactInterventionBreakdown interventions={interventions} />
                    <ArtifactSourceMessages messages={getUndisplayedSourceMessages(owner.structuredOutput, interventions, retryDiagnostics)} />
                    <ArtifactRetryDiagnostics diagnostics={retryDiagnostics} />
                  </>
                )
              })()}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Exported so the Manual QA view can show the same notice the artifact view
 * shows. The checklist artifact and the surface an operator actually works on
 * during Manual QA are two different screens, and only one of them was showing
 * that the checklist had been repaired.
 */
export function ArtifactProcessingNotice({
  structuredOutput,
  kind,
  context,
  status = 'completed',
}: {
  structuredOutput?: ArtifactStructuredOutputData
  kind?: ArtifactProcessingKind
  context?: ArtifactProcessingNoticeContext
  status?: ArtifactProcessingStatus
}) {
  const copy = buildArtifactProcessingNoticeCopy(structuredOutput, kind, { ...context, status })
  if (!copy) {
    return null
  }
  const hasOwnerInterventions = Boolean(context?.ownerInterventions?.length)
  const shouldShowOnlyOwnerInterventions = kind === 'vote-aggregate' && hasOwnerInterventions
  const retryDiagnostics = kind === 'vote-aggregate'
    ? []
    : structuredOutput?.retryDiagnostics ?? []
  const sourceMessages = getUndisplayedSourceMessages(
    structuredOutput,
    copy.interventions,
    structuredOutput?.retryDiagnostics ?? [],
  )

  return (
    <CollapsibleWarningNotice
      title={copy.title}
      summary={copy.summary}
      body={(
        <div className="space-y-3">
          <div className="leading-5">{copy.body}</div>
          {!shouldShowOnlyOwnerInterventions ? (
            <>
              <ArtifactInterventionBreakdown interventions={copy.interventions} />
              <ArtifactSourceMessages messages={sourceMessages} />
              <ArtifactRetryDiagnostics diagnostics={retryDiagnostics} />
            </>
          ) : null}
          {context?.ownerInterventions?.length ? (
            <ArtifactInterventionOwnerBreakdown owners={context.ownerInterventions} />
          ) : null}
        </div>
      )}
      headerActions={copy.badges.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {copy.badges.map((badge) => (
            <span key={badge.label} className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold ${badge.className}`}>
              {badge.label} {badge.count}
            </span>
          ))}
        </div>
      ) : undefined}
    />
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
      <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-wider">
        <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">Modified {modifiedCount}</span>
        <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">Added {addedCount}</span>
        <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">Removed {removedCount}</span>
      </div>
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
      <div className="flex flex-wrap gap-2 text-[10px] uppercase tracking-wider">
        <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">Modified {modifiedCount}</span>
        <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">Replaced {replacedCount}</span>
        <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">Added {addedCount}</span>
        <span className="rounded-full border border-border bg-background px-2 py-1 text-foreground">Removed {removedCount}</span>
      </div>
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
  const [activeRawVariantId, setActiveRawVariantId] = useState('raw-attempts:accepted-latest')

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
  const activeRawVariant = rawVariantOptions.find((variant) => variant.id === activeRawVariantId && !variant.disabled)
    ?? findFirstValidatedVariant(rawVariantOptions)
    ?? rawVariantOptions.find((variant) => !variant.disabled)
    ?? rawVariantOptions[0]
  const activeRawContent = activeRawVariant?.content ?? content
  const activeRawDisplayContent = activeRawVariant?.displayContent ?? buildReadableRawDisplayContent(activeRawContent)
  useEffect(() => {
    if (!rawVariantOptions.some((variant) => variant.id === activeRawVariantId && !variant.disabled)) {
      const validatedVariant = findFirstValidatedVariant(rawVariantOptions)
      setActiveRawVariantId(validatedVariant?.id ?? rawVariantOptions.find((variant) => !variant.disabled)?.id ?? 'raw-attempts:accepted-latest')
    }
  }, [activeRawVariantId, rawVariantOptions])
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
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Affected Items</div>
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
            </div>
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

interface ParsedPrdUserStory {
  id?: string
  title?: string
  acceptance_criteria?: string[]
}

interface ParsedPrdEpic {
  id?: string
  title?: string
  objective?: string
  user_stories?: ParsedPrdUserStory[]
}

interface ParsedPrdDocument {
  product?: {
    problem_statement?: string
    target_users?: string[]
  }
  scope?: {
    in_scope?: string[]
    out_of_scope?: string[]
  }
  technical_requirements?: {
    architecture_constraints?: string[]
    data_model?: string[]
    api_contracts?: string[]
    security_constraints?: string[]
    performance_constraints?: string[]
    reliability_constraints?: string[]
    error_handling_rules?: string[]
    tooling_assumptions?: string[]
  }
  epics?: ParsedPrdEpic[]
}

interface ParsedBead {
  [key: string]: unknown
  id?: string
  title?: string
  prdRefs?: string[]
  prd_refs?: string[]
  description?: string
  contextGuidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
  }
  context_guidance?: string | {
    patterns?: string[]
    anti_patterns?: string[]
  }
  acceptanceCriteria?: string[]
  acceptance_criteria?: string[]
  tests?: string[]
  testCommands?: CommandSpec[]
  test_commands?: CommandSpec[]
  testCommandReason?: string
  test_command_reason?: string
  priority?: number
  status?: string
  issueType?: string
  issue_type?: string
  externalRef?: string
  external_ref?: string
  labels?: string[]
  dependencies?: {
    blocked_by?: string[]
    blocks?: string[]
  }
  targetFiles?: string[]
  target_files?: string[]
  notes?: string
  iteration?: number
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  completedAt?: string
  completed_at?: string
  startedAt?: string
  started_at?: string
  beadStartCommit?: string | null
  bead_start_commit?: string | null
  qaOrigin?: ManualQaBeadOrigin | null
  qa_origin?: ManualQaBeadOrigin | null
}

const PRD_TECHNICAL_SECTION_CONFIG: Array<{
  key: keyof NonNullable<ParsedPrdDocument['technical_requirements']>
  label: string
}> = [
  { key: 'architecture_constraints', label: 'Architecture Constraints' },
  { key: 'data_model', label: 'Data Model' },
  { key: 'api_contracts', label: 'API Contracts' },
  { key: 'security_constraints', label: 'Security Constraints' },
  { key: 'performance_constraints', label: 'Performance Constraints' },
  { key: 'reliability_constraints', label: 'Reliability Constraints' },
  { key: 'error_handling_rules', label: 'Error Handling Rules' },
  { key: 'tooling_assumptions', label: 'Tooling Assumptions' },
]

function parsePrdDocument(content: string): ParsedPrdDocument | null {
  const parsed = tryParseStructuredContent(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const document = parsed as ParsedPrdDocument
  return Array.isArray(document.epics) ? document : null
}

function parseBeadsArtifact(content: string): ParsedBead[] | null {
  const parsed = tryParseStructuredContent(content)
  if (Array.isArray(parsed)) {
    return parsed as ParsedBead[]
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray((parsed as { beads?: ParsedBead[] }).beads)) {
    return (parsed as { beads: ParsedBead[] }).beads
  }
  if (content.trim().startsWith('{')) {
    try {
      return content.trim().split('\n').map((line) => JSON.parse(line) as ParsedBead)
    } catch {
      return null
    }
  }
  return null
}

function renderBeadGuidance(guidance: ParsedBead['contextGuidance']): React.ReactNode {
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

function getBeadStringArray(bead: ParsedBead, keys: string[]): string[] {
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

function getBeadCommands(bead: ParsedBead, keys: string[]): CommandSpec[] {
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

function getBeadStringValue(bead: ParsedBead, keys: string[]): string {
  for (const key of keys) {
    const value = bead[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function getBeadNumberValue(bead: ParsedBead, keys: string[]): number | null {
  for (const key of keys) {
    const value = bead[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function getBeadDependencies(bead: ParsedBead): { blockedBy: string[]; blocks: string[] } {
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

function buildExpansionAddedGroups(planBead: ParsedBead | undefined, expandedBead: ParsedBead, index: number): ExpansionAddedGroup[] {
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

  return expandedBeads.reduce((count, bead, index) => {
    const groups = buildExpansionAddedGroups(planBeads[index], bead, index)
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

  const addedFieldCount = countExpansionAddedFields(content)

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200">
        Expansion added {addedFieldCount} execution field{addedFieldCount === 1 ? '' : 's'} across {expandedBeads.length} bead{expandedBeads.length === 1 ? '' : 's'}.
      </div>
      {expandedBeads.map((expandedBead, index) => {
        const planBead = planBeads[index]
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
            const qaOrigin = bead.qaOrigin ?? bead.qa_origin ?? null
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
                  {renderBeadGuidance((bead.contextGuidance ?? bead.context_guidance) as ParsedBead['contextGuidance'])}
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
  if (beads.length === 0) return null
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

function hasStructuredRetryMetadata(structuredOutput?: ArtifactStructuredOutputData): boolean {
  return Boolean(
    (structuredOutput?.autoRetryCount ?? 0) > 0
    || (structuredOutput?.retryDiagnostics?.length ?? 0) > 0,
  )
}

function normalizeRawOutputForComparison(value: string): string {
  return value.replace(/\s+$/g, '')
}

function findRejectedRawOutput(history: string[] | undefined, currentRawResponse?: string): string | undefined {
  if (!history || history.length < 2) return undefined

  if (typeof currentRawResponse === 'string') {
    const current = normalizeRawOutputForComparison(currentRawResponse)
    const currentIndex = history
      .map(normalizeRawOutputForComparison)
      .lastIndexOf(current)
    if (currentIndex > 0) return history[currentIndex - 1]
    if (currentIndex === 0) return undefined
  }

  return history[history.length - 2]
}

function getRawAttemptContent(attempt: ArtifactRawAttemptData): string | undefined {
  const content = attempt.rawResponse ?? attempt.modelOutput ?? attempt.content
  if (typeof content === 'string' && content.length > 0) return content
  const diagnostic = attempt.validationError ?? attempt.error
  if (!diagnostic) return undefined
  return [
    'No model response was captured for this attempt.',
    '',
    `Error: ${diagnostic}`,
    attempt.failureClass ? `Failure class: ${attempt.failureClass}` : '',
  ].filter(Boolean).join('\n')
}

function getRawAttemptsFromContent(content: string): ArtifactRawAttemptData[] | undefined {
  const parsed = tryParseStructuredContent(content)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  return normalizeRawAttempts(record.rawAttempts ?? record.raw_attempts)
}

function getRawAttemptStatus(attempt: ArtifactRawAttemptData): string | undefined {
  return attempt.status ?? attempt.outcome
}

function isValidatedRawAttemptStatus(status: string | undefined): boolean {
  const normalized = status?.toLowerCase()
  return normalized === 'accepted' || normalized === 'completed' || normalized === 'validated'
}

function formatRawAttemptStatusLabel(status: string | undefined): string {
  const normalized = status?.toLowerCase()
  if (normalized === 'rejected' || normalized === 'invalid_output' || normalized === 'failed' || normalized === 'timed_out') return 'Rejected'
  if (normalized === 'accepted' || normalized === 'completed') return 'Accepted'
  if (normalized === 'validated') return 'Validated'
  return ''
}

function isRejectedRawAttempt(attempt: ArtifactRawAttemptData): boolean {
  const status = getRawAttemptStatus(attempt)?.toLowerCase()
  return status === 'rejected' || status === 'failed' || status === 'invalid_output' || status === 'timed_out' || Boolean(attempt.error || attempt.validationError)
}

function hasRejectedRawAttempt(rawAttempts: ArtifactRawAttemptData[] | undefined): boolean {
  return rawAttempts?.some(isRejectedRawAttempt) ?? false
}

function getRejectedRawAttempt(rawAttempts: ArtifactRawAttemptData[] | undefined): string | undefined {
  if (!rawAttempts) return undefined
  for (const attempt of [...rawAttempts].reverse()) {
    if (!isRejectedRawAttempt(attempt)) continue
    const content = getRawAttemptContent(attempt)
    if (typeof content === 'string') return content
  }
  return undefined
}

function getRawAttemptNumber(attempt: ArtifactRawAttemptData, index: number): number {
  return typeof attempt.attempt === 'number' && Number.isFinite(attempt.attempt) && attempt.attempt > 0
    ? attempt.attempt
    : index + 1
}

function getLatestValidatedRawAttemptNumber(rawAttempts: ArtifactRawAttemptData[] | undefined): number | undefined {
  const attempts = rawAttempts ?? []
  for (let index = attempts.length - 1; index >= 0; index -= 1) {
    const attempt = attempts[index]
    if (attempt && isValidatedRawAttemptStatus(getRawAttemptStatus(attempt))) {
      return getRawAttemptNumber(attempt, index)
    }
  }
  return undefined
}

function inferValidatedAttemptNumber(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): number | undefined {
  const rawAttemptNumber = getLatestValidatedRawAttemptNumber(rawAttempts)
  if (typeof rawAttemptNumber === 'number') return rawAttemptNumber

  const autoRetryCount = structuredOutput?.autoRetryCount
  if (typeof autoRetryCount === 'number' && Number.isFinite(autoRetryCount) && autoRetryCount > 0) {
    return Math.trunc(autoRetryCount) + 1
  }

  return undefined
}

function formatValidatedRawVariantLabel(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): string {
  const attemptNumber = inferValidatedAttemptNumber(rawAttempts, structuredOutput)
  return typeof attemptNumber === 'number' ? `Attempt ${attemptNumber} Validated` : 'Validated'
}

function inferRejectedRawVariantAttemptNumber(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): number | undefined {
  if (hasRejectedRawAttempt(rawAttempts)) return undefined

  const autoRetryCount = structuredOutput?.autoRetryCount
  if (typeof autoRetryCount === 'number' && Number.isFinite(autoRetryCount) && autoRetryCount > 0) {
    return Math.trunc(autoRetryCount)
  }

  const diagnosticAttemptNumbers = structuredOutput?.retryDiagnostics
    ?.map((diagnostic) => diagnostic.attempt)
    .filter((attempt): attempt is number => Number.isInteger(attempt) && attempt > 0) ?? []
  if (diagnosticAttemptNumbers.length > 0) {
    return Math.max(...diagnosticAttemptNumbers)
  }

  const validatedAttemptNumber = inferValidatedAttemptNumber(rawAttempts, structuredOutput)
  return typeof validatedAttemptNumber === 'number' && validatedAttemptNumber > 1
    ? validatedAttemptNumber - 1
    : undefined
}

function formatRejectedRawVariantLabel(
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  structuredOutput: ArtifactStructuredOutputData | undefined,
): string {
  const attemptNumber = inferRejectedRawVariantAttemptNumber(rawAttempts, structuredOutput)
  return typeof attemptNumber === 'number' ? `Attempt ${attemptNumber} Output - Rejected` : 'Rejected'
}

function buildRawAttemptVariants(
  ownerId: string,
  ownerLabel: string,
  rawAttempts: ArtifactRawAttemptData[] | undefined,
): RawContentVariant[] {
  const orderedAttempts = (rawAttempts ?? [])
    .map((attempt, index) => ({
      attempt,
      index,
      attemptNumber: getRawAttemptNumber(attempt, index),
    }))
    .sort((a, b) => a.attemptNumber - b.attemptNumber || a.index - b.index)
  const initialInput = orderedAttempts.find(({ attempt }) => typeof attempt.initialInput === 'string' && attempt.initialInput.length > 0)?.attempt.initialInput

  return [
    ...(typeof initialInput === 'string'
      ? [{
          id: `${ownerId}:initial-input`,
          label: 'Initial Prompt',
          content: initialInput,
          displayContent: initialInput,
          ariaLabel: `${ownerLabel} Initial Prompt`,
          title: `Show initial model prompt for ${ownerLabel}`,
          skipDedupe: true,
        }]
      : []),
    ...orderedAttempts.flatMap(({ attempt, index, attemptNumber }) => {
      const content = getRawAttemptContent(attempt)
      if (typeof content !== 'string') return []
      const status = getRawAttemptStatus(attempt)
      const statusLabel = formatRawAttemptStatusLabel(status)
      const baseLabel = `Attempt ${attemptNumber} Output`
      const attemptLabel = attempt.label ?? `${baseLabel}${statusLabel ? ` - ${statusLabel}` : ''}`
      const titleStatus = status ? ` · ${status}` : ''
      return [{
        id: `${ownerId}:attempt:${index}`,
        label: attemptLabel,
        content,
        displayContent: content,
        ariaLabel: `${ownerLabel} ${attemptLabel}`,
        title: `Show ${attemptLabel.toLowerCase()} raw output from ${ownerLabel}${titleStatus}`,
      }]
    }),
  ]
}

function getRawVariantRenderedContent(variant: RawContentVariant): string | undefined {
  if (typeof variant.displayContent === 'string') return variant.displayContent
  if (typeof variant.content === 'string') return buildReadableRawDisplayContent(variant.content)
  return undefined
}

function normalizeRawVariantComparisonContent(content: string): string {
  return content.replace(/\r\n/g, '\n').trimEnd()
}

function getRawVariantDedupPriority(variant: RawContentVariant): number {
  const label = variant.label.toLowerCase()
  if (/^attempt\s+\d+\s+validated/i.test(variant.label)) return 130
  if (variant.id.includes(':attempt:') || /^attempt\s+\d+/i.test(variant.label)) {
    if (label.includes('accepted')) return 120
    if (label.includes('rejected')) return 110
    return 100
  }
  if (label === 'rejected') return 80
  if (label === 'validated') return 70
  if (label === 'accepted output') return 60
  if (label === 'model output') return 20
  if (label === 'raw output') return 10
  return 50
}

function dedupeRawContentVariants(variants: RawContentVariant[]): RawContentVariant[] {
  const byContent = new Map<string, { variant: RawContentVariant; index: number; priority: number }>()
  const unkeyed: Array<{ variant: RawContentVariant; index: number }> = []

  variants.forEach((variant, index) => {
    if (variant.skipDedupe) {
      unkeyed.push({ variant, index })
      return
    }

    const renderedContent = getRawVariantRenderedContent(variant)
    if (typeof renderedContent !== 'string') {
      unkeyed.push({ variant, index })
      return
    }

    const key = normalizeRawVariantComparisonContent(renderedContent)
    const priority = getRawVariantDedupPriority(variant)
    const existing = byContent.get(key)
    if (!existing || priority > existing.priority) {
      byContent.set(key, {
        variant,
        index,
        priority,
      })
    }
  })

  return [
    ...byContent.values(),
    ...unkeyed.map((entry) => ({ ...entry, priority: getRawVariantDedupPriority(entry.variant) })),
  ]
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.variant)
}

function buildRawAttemptInspectionVariants(
  ownerId: string,
  ownerLabel: string,
  rawAttempts: ArtifactRawAttemptData[] | undefined,
): RawContentVariant[] {
  const attempts = rawAttempts ?? []
  const latestAcceptedAttempt = [...attempts].reverse().find((attempt) => getRawAttemptStatus(attempt)?.toLowerCase() === 'accepted')
  const latestAcceptedContent = latestAcceptedAttempt ? getRawAttemptContent(latestAcceptedAttempt) : undefined
  return dedupeRawContentVariants([
    ...(typeof latestAcceptedContent === 'string'
      ? [{
          id: `${ownerId}:accepted-latest`,
          label: 'Accepted Output',
          content: latestAcceptedContent,
          displayContent: latestAcceptedContent,
          title: `Show latest accepted raw output from ${ownerLabel}`,
        }]
      : []),
    ...buildRawAttemptVariants(ownerId, ownerLabel, rawAttempts),
  ])
}

function formatRawAttemptSourceLabel(modeLabel: string, modelId?: string): string {
  const trimmedMode = modeLabel.trim()
  return modelId ? `${getModelDisplayName(modelId)} · ${trimmedMode}` : trimmedMode
}

function buildRawAttemptSource(
  ownerId: string,
  modeLabel: string,
  rawAttempts: ArtifactRawAttemptData[] | undefined,
  modelId?: string,
): RawContentSource | undefined {
  const label = formatRawAttemptSourceLabel(modeLabel, modelId)
  const variants = buildRawAttemptInspectionVariants(ownerId, label, rawAttempts)
  if (variants.length === 0) return undefined

  return {
    id: ownerId,
    label,
    modelId,
    variants,
    disabled: !variants.some((variant) => !variant.disabled),
    title: `Show raw ${modeLabel.toLowerCase()} attempts${modelId ? ` from ${getModelDisplayName(modelId)}` : ''}`,
  }
}

function buildRejectedRawVariant(
  id: string,
  label: string,
  rejectedRawResponse: string | undefined,
  variantLabel = 'Rejected',
): RawContentVariant {
  return {
    id,
    label: variantLabel,
    content: rejectedRawResponse,
    displayContent: rejectedRawResponse,
    disabled: typeof rejectedRawResponse !== 'string',
    ariaLabel: `${label} ${variantLabel}`,
    labelClassName: 'italic',
    title: typeof rejectedRawResponse === 'string'
      ? `Show ${variantLabel.toLowerCase()} pre-retry output from ${label}`
      : `${variantLabel} pre-retry output was not found in logs for ${label}`,
  }
}

function getValidatedDraftContent(draft: CouncilDraftData): string | undefined {
  if (typeof draft.normalizedResponse === 'string') return draft.normalizedResponse
  if (isFailedCouncilDraftOutcome(draft.outcome)) return undefined
  if (typeof draft.content === 'string') return draft.content
  return undefined
}

function buildValidatedDraftRawSources(draft: CouncilDraftData): RawContentSource[] | undefined {
  const validatedContent = getValidatedDraftContent(draft)
  if (typeof validatedContent !== 'string') return undefined

  const label = getModelDisplayName(draft.memberId)
  return [{
    id: `draft:${draft.memberId}`,
    label,
    modelId: draft.memberId,
    variants: [{
      id: `draft:${draft.memberId}:validated`,
      label: 'Validated',
      content: validatedContent,
      displayContent: validatedContent,
      ariaLabel: `${label} Validated`,
      title: `Show validated draft output from ${label}`,
    }],
    title: `Show validated draft output from ${label}`,
  }]
}

function buildDraftRawSources(
  draft: CouncilDraftData,
  rejectedRawResponse?: string,
  options: { validatedOnly?: boolean } = {},
): RawContentSource[] | undefined {
  if (options.validatedOnly) return buildValidatedDraftRawSources(draft)

  const rawResponse = draft.rawResponse
  const normalizedResponse = draft.normalizedResponse ?? (
    draft.structuredOutput?.repairApplied && draft.content ? draft.content : undefined
  )
  const label = getModelDisplayName(draft.memberId)
  const rawAttemptVariants = buildRawAttemptVariants(`draft:${draft.memberId}`, label, draft.rawAttempts)
  const shouldShowRejected = hasStructuredRetryMetadata(draft.structuredOutput)
  if (typeof rawResponse !== 'string' && typeof normalizedResponse !== 'string' && rawAttemptVariants.length === 0 && !shouldShowRejected) return undefined
  const variants: RawContentVariant[] = [{
    id: `draft:${draft.memberId}:raw`,
    label: 'Raw Output',
    content: rawResponse,
    displayContent: rawResponse,
    disabled: typeof rawResponse !== 'string',
    ariaLabel: `${label} Raw Output`,
    title: typeof rawResponse === 'string'
      ? `Show raw model output from ${label}`
      : `No exact raw output stored for ${label}`,
  }]
  if (shouldShowRejected) {
    variants.push(buildRejectedRawVariant(
      `draft:${draft.memberId}:rejected`,
      label,
      getRejectedRawAttempt(draft.rawAttempts) ?? rejectedRawResponse,
      formatRejectedRawVariantLabel(draft.rawAttempts, draft.structuredOutput),
    ))
  }
  variants.push(...rawAttemptVariants)
  if (typeof normalizedResponse === 'string') {
    const validatedLabel = formatValidatedRawVariantLabel(draft.rawAttempts, draft.structuredOutput)
    variants.push({
      id: `draft:${draft.memberId}:validated`,
      label: validatedLabel,
      content: normalizedResponse,
      displayContent: normalizedResponse,
      ariaLabel: `${label} ${validatedLabel}`,
      title: `Show ${validatedLabel.toLowerCase()} output from ${label}`,
    })
  }
  const uniqueVariants = dedupeRawContentVariants(variants)
  return [{
    id: `draft:${draft.memberId}`,
    label,
    modelId: draft.memberId,
    variants: uniqueVariants,
    disabled: !uniqueVariants.some((v) => !v.disabled),
    title: typeof rawResponse === 'string'
      ? `Show raw model output from ${label}`
      : `No exact raw output stored for ${label}`,
  }]
}

type DraftRawLogStage = 'draft' | 'full_answers' | 'prd_draft'

type DraftRawLogFallbacks = Record<DraftRawLogStage, Map<string, string>>
type DraftRawLogHistories = Record<DraftRawLogStage, Map<string, string[]>>

function shouldReadDraftRawLogsForPhase(phase?: string): boolean {
  return phase === 'DRAFTING_PRD'
    || phase === 'DRAFTING_BEADS'
    || phase === 'COUNCIL_DELIBERATING'
    || phase === 'COUNCIL_DRAFTING_INTERVIEW'
}

function shouldShowValidatedDraftRawOnly(phase?: string): boolean {
  return Boolean(phase) && !shouldReadDraftRawLogsForPhase(phase)
}

function createEmptyDraftRawLogFallbacks(): DraftRawLogFallbacks {
  return {
    draft: new Map<string, string>(),
    full_answers: new Map<string, string>(),
    prd_draft: new Map<string, string>(),
  }
}

function createEmptyDraftRawLogHistories(): DraftRawLogHistories {
  return {
    draft: new Map<string, string[]>(),
    full_answers: new Map<string, string[]>(),
    prd_draft: new Map<string, string[]>(),
  }
}

function appendRawLogHistory(history: Map<string, string[]>, modelId: string, output: string) {
  const outputs = history.get(modelId) ?? []
  if (outputs[outputs.length - 1] === output) return
  history.set(modelId, [...outputs, output])
}

function stripLogTag(line: string): string {
  return line.replace(/^\[[A-Z_]+\]\s*/, '')
}

function getModelOutputFromLog(log: LogEntry): string | undefined {
  if (!log.line.startsWith('[MODEL] ')) return undefined
  const output = log.line.slice('[MODEL] '.length)
  if (!output.trim()) return undefined
  if (output.startsWith('[PROMPT]')) return undefined
  return output
}

function updateDraftRawLogStage(
  stagesByMember: Map<string, DraftRawLogStage>,
  phase: string | undefined,
  log: LogEntry,
) {
  if (!log.modelId) return
  const line = stripLogTag(log.line)

  if (phase === 'DRAFTING_PRD') {
    if (line.includes(`${log.modelId} Full Answers started.`)) {
      stagesByMember.set(log.modelId, 'full_answers')
      return
    }
    if (line.includes(`${log.modelId} PRD draft started.`)) {
      stagesByMember.set(log.modelId, 'prd_draft')
      return
    }
    if (
      line.includes(`${log.modelId} Full Answers completed.`)
      || line.includes(`${log.modelId} Full Answers failed:`)
      || line.includes(`${log.modelId} PRD draft completed.`)
      || line.includes(`${log.modelId} PRD draft failed:`)
    ) {
      stagesByMember.delete(log.modelId)
    }
    return
  }

  if (phase === 'DRAFTING_BEADS') {
    if (line.includes(`${log.modelId} Beads draft`) || line.includes(`${log.modelId} draft`)) {
      stagesByMember.set(log.modelId, 'draft')
    }
    return
  }

  if (phase === 'COUNCIL_DELIBERATING' || phase === 'COUNCIL_DRAFTING_INTERVIEW') {
    stagesByMember.set(log.modelId, 'draft')
  }
}

function buildDraftRawLogFallbacks(logs: LogEntry[], phase?: string): DraftRawLogFallbacks {
  const fallbacks = createEmptyDraftRawLogFallbacks()
  if (!shouldReadDraftRawLogsForPhase(phase)) return fallbacks

  const stagesByMember = new Map<string, DraftRawLogStage>()

  for (const log of logs) {
    updateDraftRawLogStage(stagesByMember, phase, log)
    if (!log.modelId) continue

    const output = getModelOutputFromLog(log)
    if (!output) continue

    const stage = stagesByMember.get(log.modelId)
      ?? (phase === 'DRAFTING_PRD' ? 'prd_draft' : 'draft')
    fallbacks[stage].set(log.modelId, output)
  }

  return fallbacks
}

function buildDraftRawLogHistories(logs: LogEntry[], phase?: string): DraftRawLogHistories {
  const histories = createEmptyDraftRawLogHistories()
  if (!shouldReadDraftRawLogsForPhase(phase)) return histories

  const stagesByMember = new Map<string, DraftRawLogStage>()

  for (const log of logs) {
    updateDraftRawLogStage(stagesByMember, phase, log)
    if (!log.modelId) continue

    const output = getModelOutputFromLog(log)
    if (!output) continue

    const stage = stagesByMember.get(log.modelId)
      ?? (phase === 'DRAFTING_PRD' ? 'prd_draft' : 'draft')
    appendRawLogHistory(histories[stage], log.modelId, output)
  }

  return histories
}

function getDraftRawLogStage(phase?: string, artifactId?: string): DraftRawLogStage {
  if (phase === 'DRAFTING_PRD') {
    return artifactId?.startsWith('prd-fullanswers-member-') ? 'full_answers' : 'prd_draft'
  }
  return 'draft'
}

function getRejectedDraftRawResponse(
  draft: CouncilDraftData,
  phase: string | undefined,
  artifactId: string | undefined,
  histories: DraftRawLogHistories,
): string | undefined {
  if (!hasStructuredRetryMetadata(draft.structuredOutput)) return undefined
  const stage = getDraftRawLogStage(phase, artifactId)
  return findRejectedRawOutput(histories[stage].get(draft.memberId), draft.rawResponse)
}

function withDraftRawLogFallback(
  draft: CouncilDraftData,
  phase: string | undefined,
  artifactId: string | undefined,
  fallbacks: DraftRawLogFallbacks,
): CouncilDraftData {
  if (typeof draft.rawResponse === 'string') return draft

  const stage = getDraftRawLogStage(phase, artifactId)
  const rawResponse = fallbacks[stage].get(draft.memberId)
  if (typeof rawResponse !== 'string') return draft

  const normalizedResponse = typeof draft.normalizedResponse === 'string'
    ? draft.normalizedResponse
    : typeof draft.content === 'string' && draft.content !== rawResponse
      ? draft.content
      : undefined

  return {
    ...draft,
    rawResponse,
    ...(typeof normalizedResponse === 'string' ? { normalizedResponse } : {}),
  }
}

function buildVoteRawLogHistories(logs: LogEntry[], phase?: string): Map<string, string[]> {
  const histories = new Map<string, string[]>()
  if (!phase?.includes('VOTING')) return histories

  for (const log of logs) {
    if (!log.modelId) continue
    const output = getModelOutputFromLog(log)
    if (!output) continue
    appendRawLogHistory(histories, log.modelId, output)
  }

  return histories
}

function getRejectedVoteRawResponse(
  voterId: string,
  detail: CouncilVoterDetailData | undefined,
  histories: Map<string, string[]>,
): string | undefined {
  if (!hasStructuredRetryMetadata(detail?.structuredOutput)) return undefined
  return findRejectedRawOutput(histories.get(voterId), detail?.rawResponse)
}

function isFailedCouncilDraftOutcome(outcome?: CouncilOutcome): boolean {
  return outcome === 'invalid_output' || outcome === 'failed' || outcome === 'timed_out'
}

function CouncilDraftFailureDiagnostics({ draft }: { draft: CouncilDraftData }) {
  const diagnostics = [
    draft.error,
    draft.structuredOutput?.validationError,
    ...(draft.structuredOutput?.retryDiagnostics ?? []).flatMap((diagnostic) => [
      diagnostic.validationError,
      diagnostic.excerpt ? `Retry ${diagnostic.attempt} excerpt: ${diagnostic.excerpt}` : undefined,
    ]),
  ].filter((message): message is string => typeof message === 'string' && message.trim().length > 0)

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-3">
        <div className="text-sm font-semibold">{getCouncilStatusLabel(draft.outcome, 'drafting')}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {draft.outcome === 'timed_out'
            ? 'No accepted draft was received before the timeout.'
            : draft.outcome === 'failed'
              ? 'The draft run failed before producing an accepted artifact.'
              : 'The draft response did not pass strict artifact validation.'}
        </div>
      </div>
      {diagnostics.length > 0 ? (
        <ArtifactListSection
          title="Diagnostics"
          items={diagnostics}
          emptyLabel="No validation diagnostics were recorded."
          tone="error"
        />
      ) : null}
    </div>
  )
}

function getCoverageCandidateLabel(phase?: string, candidateVersion?: number): string {
  if (phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL') {
    return candidateVersion ? `PRD Candidate v${candidateVersion}` : 'current PRD candidate'
  }
  if (phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL') {
    return candidateVersion ? `Implementation Plan v${candidateVersion}` : 'current implementation plan'
  }
  if (phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL') {
    return 'compiled interview'
  }
  return 'current draft'
}

function getCoverageReviewedAgainst(phase?: string): string {
  if (phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL') return 'winner Full Answers'
  if (phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL') return 'approved PRD'
  if (phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL') return 'submitted answers'
  return 'source material'
}

function buildCoverageSummaryText(coverageResult: CoverageArtifactData, phase?: string): string {
  if (coverageResult.summary?.trim()) {
    return coverageResult.summary
  }

  const status = coverageResult.status ?? coverageResult.parsed?.status ?? (coverageResult.hasGaps ? 'gaps' : 'clean')
  const finalCandidateVersion = coverageResult.finalCandidateVersion ?? coverageResult.attempts?.[coverageResult.attempts.length - 1]?.candidateVersion
  const gaps = getCoverageDisplayGaps(coverageResult)
  const reviewedArtifact = getCoverageCandidateLabel(phase, finalCandidateVersion)
  const reviewedAgainst = getCoverageReviewedAgainst(phase)
  const isVerifyPrdCoverage = phase === 'VERIFYING_PRD_COVERAGE'

  return status === 'gaps'
    ? gaps.length > 0
      ? `This ${isVerifyPrdCoverage ? 'check' : 'pass'} found ${gaps.length === 1 ? '1 gap' : `${gaps.length} gaps`} between the ${reviewedArtifact} and the ${reviewedAgainst}.`
      : `This ${isVerifyPrdCoverage ? 'check' : 'pass'} found coverage gaps between the ${reviewedArtifact} and the ${reviewedAgainst}.`
    : `The ${reviewedArtifact} covers the ${reviewedAgainst}. No gaps were ${isVerifyPrdCoverage ? 'found in this check' : 'flagged in this pass'}.`
}

function normalizeCoverageGapList(gaps: string[] | undefined): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const gap of gaps ?? []) {
    const trimmed = gap.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

function getCoverageDisplayGaps(coverageResult: CoverageArtifactData): string[] {
  if (Array.isArray(coverageResult.remainingGaps)) {
    return normalizeCoverageGapList(coverageResult.remainingGaps)
  }

  const directGaps = [
    coverageResult.gaps,
    coverageResult.parsed?.gaps,
  ]

  for (const gaps of directGaps) {
    const normalized = normalizeCoverageGapList(gaps)
    if (normalized.length > 0) return normalized
  }

  const latestGapAttempt = coverageResult.attempts
    ?.slice()
    .reverse()
    .find((attempt) => attempt.status === 'gaps' && attempt.gaps.length > 0)

  return normalizeCoverageGapList(latestGapAttempt?.gaps)
}

function CleanCoverageCallout({
  coverageResult,
  phase,
  fallbackCandidateVersion,
}: {
  coverageResult: CoverageArtifactData | null
  phase?: string
  fallbackCandidateVersion?: number
}) {
  const coverageStatus = coverageResult?.status ?? coverageResult?.parsed?.status
  if (coverageStatus !== 'clean' || !coverageResult) return null

  const finalCandidateVersion = coverageResult.finalCandidateVersion ?? fallbackCandidateVersion
  const summaryText = buildCoverageSummaryText(
    finalCandidateVersion && finalCandidateVersion !== coverageResult.finalCandidateVersion
      ? { ...coverageResult, finalCandidateVersion }
      : coverageResult,
    phase,
  )

  return (
    <div className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200">
      {summaryText}
    </div>
  )
}

function CoverageResultView({
  content,
  header,
  phase,
  cleanStatusLabel,
  openGapsTitle,
}: {
  content: string
  header?: React.ReactNode
  phase?: string
  cleanStatusLabel?: string
  openGapsTitle?: string
}) {
  const coverageResult = parseCoverageArtifact(content)
  if (!coverageResult) {
    return (
      <div className="space-y-3">
        {header && <div className="flex items-center gap-2">{header}</div>}
        <div className="text-xs text-muted-foreground italic">Coverage result is still being generated.</div>
      </div>
    )
  }

  const isPrdCoverage = phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL'
  const status = coverageResult.status ?? coverageResult.parsed?.status ?? (coverageResult.hasGaps ? 'gaps' : 'clean')
  const finalCandidateVersion = coverageResult.finalCandidateVersion ?? coverageResult.attempts?.[coverageResult.attempts.length - 1]?.candidateVersion
  const openGaps = getCoverageDisplayGaps(coverageResult)
  const hasOpenCoverageGaps = status === 'gaps'
    || coverageResult.hasGaps === true
    || coverageResult.hasRemainingGaps === true
    || openGaps.length > 0
  const followUpQuestions = isPrdCoverage
    ? []
    : normalizeCoverageFollowUpArtifacts(
        coverageResult.parsed?.followUpQuestions ?? coverageResult.parsed?.follow_up_questions,
      )
  const hasStructuredFollowUps = !isPrdCoverage && followUpQuestions.length > 0
  const summaryText = buildCoverageSummaryText(coverageResult, phase)
  const terminationSummary = coverageResult.terminationReason === 'coverage_pass_limit_reached'
    ? 'Retry cap reached; moving to approval with unresolved gaps.'
    : coverageResult.terminationReason === 'follow_up_budget_exhausted'
      ? 'Follow-up budget exhausted; moving to approval with unresolved gaps.'
      : coverageResult.terminationReason === 'follow_up_generation_failed'
        ? 'Follow-up questions could not be recovered; moving to approval with unresolved gaps.'
        : null
  return (
    <div className="space-y-4">
      {header && <div className="flex items-center gap-2">{header}</div>}

      <div className={`rounded-md border px-3 py-2 text-xs font-medium ${
        hasOpenCoverageGaps
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'
          : 'border-green-300 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200'
      }`}>
        {hasOpenCoverageGaps
          ? 'Coverage review found gaps'
          : finalCandidateVersion && finalCandidateVersion > 1
            ? cleanStatusLabel ?? 'No remaining coverage gaps found'
            : 'No coverage gaps found'}
      </div>

      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        {summaryText}
      </div>

      {terminationSummary && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          {terminationSummary}
        </div>
      )}

      {hasOpenCoverageGaps && openGaps.length > 0 && (
        <CollapsibleSection
          title={(
            <span className="flex items-center gap-2">
              <span>{openGapsTitle ?? 'Open Coverage Gaps'}</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {openGaps.length}
              </span>
            </span>
          )}
          defaultOpen
        >
          <div className="space-y-2">
            {openGaps.map((gap, index) => (
              <div
                key={`${gap}:${index}`}
                className="rounded-md border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs leading-5 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100"
              >
                {gap}
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {typeof coverageResult.followUpBudgetTotal === 'number' && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-[11px] text-muted-foreground">
          Follow-up budget: {coverageResult.followUpBudgetUsed ?? 0}/{coverageResult.followUpBudgetTotal} used
          {typeof coverageResult.followUpBudgetPercent === 'number' ? ` (${coverageResult.followUpBudgetPercent}%)` : ''}
          {typeof coverageResult.followUpBudgetRemaining === 'number' ? ` · ${coverageResult.followUpBudgetRemaining} remaining` : ''}
        </div>
      )}

      {hasStructuredFollowUps && (
        <div className="space-y-3">
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Suggested Follow-up Questions</div>
            <div className="space-y-2">
              {followUpQuestions.map((question, index) => (
                <div key={`${question.id ?? 'follow-up'}-${index}`} className="rounded-md border border-border bg-background px-3 py-2 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {question.id && <span className="font-mono text-[10px] text-muted-foreground">{question.id}</span>}
                    {question.phase && <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{question.phase}</span>}
                    {question.priority && <span className="text-[10px] text-blue-500">{question.priority}</span>}
                  </div>
                  <div className="text-xs font-medium">{question.question}</div>
                  {question.rationale && <div className="text-[10px] italic text-muted-foreground">{question.rationale}</div>}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function RelevantFilesScanView({ content }: { content: string }) {
  const [activeTab, setActiveTab] = useState<'files' | 'raw'>('files')
  const [activeRawVariantId, setActiveRawVariantId] = useState('relevant-files-scan:accepted-latest')
  const rawDisplayContent = useMemo(() => buildReadableRawDisplayContent(content), [content])
  const raw = tryParseStructuredContent(content) as (RelevantFilesScanData & { files: Array<RelevantFileScanEntry & { content_preview?: string }> }) | null
  const rawAttempts = useMemo(() => getRawAttemptsFromContent(content), [content])
  const rawAttemptSource = useMemo(
    () => buildRawAttemptSource(
      'relevant-files-scan',
      'relevant files scan',
      rawAttempts,
      raw?.modelId,
    ),
    [raw?.modelId, rawAttempts],
  )
  const rawVariantOptions = useMemo(() => rawAttemptSource?.variants ?? [], [rawAttemptSource])
  const activeRawVariant = rawVariantOptions.find((variant) => variant.id === activeRawVariantId && !variant.disabled)
    ?? findFirstValidatedVariant(rawVariantOptions)
    ?? rawVariantOptions.find((variant) => !variant.disabled)
    ?? rawVariantOptions[0]
  const activeRawContent = activeRawVariant?.content ?? content
  const activeRawDisplayContent = activeRawVariant?.displayContent ?? buildReadableRawDisplayContent(activeRawContent)
  useEffect(() => {
    if (!rawVariantOptions.some((variant) => variant.id === activeRawVariantId && !variant.disabled)) {
      const validatedVariant = findFirstValidatedVariant(rawVariantOptions)
      setActiveRawVariantId(validatedVariant?.id ?? rawVariantOptions.find((variant) => !variant.disabled)?.id ?? 'relevant-files-scan:accepted-latest')
    }
  }, [activeRawVariantId, rawVariantOptions])
  if (!raw?.files) return <RawContentWithCopy content={content} />

  // Normalize: accept both camelCase (new) and snake_case (legacy DB rows)
  const parsed: RelevantFilesScanData = {
    ...raw,
    files: raw.files.map(f => ({
      ...f,
      contentPreview: f.contentPreview ?? (f as { content_preview?: string }).content_preview ?? '',
      contentLength: f.contentLength ?? (f.contentPreview ?? (f as { content_preview?: string }).content_preview ?? '').length,
    })),
    rawAttempts,
  }
  const hasRawTab = rawVariantOptions.length > 0
  const currentTab = activeTab === 'raw' && hasRawTab ? 'raw' : 'files'
  const rawVariantSelector = rawAttemptSource && rawVariantOptions.length > 0
    ? (
      <div className="flex min-w-0 max-w-full flex-wrap gap-1.5 overflow-hidden">
        <RawAttemptVariantSelector
          source={rawAttemptSource}
          activeVariantId={activeRawVariant?.id}
          onSelect={setActiveRawVariantId}
          ariaLabel="Relevant files raw attempts"
        />
      </div>
      )
    : null

  const relevanceColor = (r: string) =>
    r === 'high' ? 'text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800'
    : r === 'medium' ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-800'
    : 'text-muted-foreground bg-muted border-border'

  return (
    <div className="space-y-3">
      {currentTab === 'files' ? <ArtifactProcessingNotice structuredOutput={parsed.structuredOutput} kind="relevant-files" /> : null}
      <div className="flex items-center gap-2">
        {parsed.modelId && (
          <ModelBadge modelId={parsed.modelId} active className="px-3 py-2 h-auto flex-1 justify-start">
            <div className="text-left">
              <div className="text-xs font-medium">{getModelDisplayName(parsed.modelId)}</div>
              <div className="text-[10px] opacity-80 mt-0.5">Relevant files scan</div>
            </div>
          </ModelBadge>
        )}
        <div className={`inline-flex items-center gap-1 rounded-md border border-border bg-background p-1 shrink-0 ${parsed.modelId ? 'ml-auto' : ''}`}>
          <button
            onClick={() => setActiveTab('files')}
            className={currentTab === 'files'
              ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
              : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
          >
            Files
          </button>
          {hasRawTab && (
            <button
              onClick={() => setActiveTab('raw')}
              className={currentTab === 'raw'
                ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/70 hover:text-foreground'}
            >
              Raw
            </button>
          )}
          {currentTab === 'raw' && <CopyButton content={activeRawContent} />}
        </div>
      </div>

      {currentTab === 'raw' ? (
        <>
          {rawVariantSelector}
          <RawDisplayStats content={activeRawDisplayContent} />
          <RawDisplayPre content={activeRawDisplayContent} />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="text-xs text-muted-foreground font-medium">{parsed.fileCount} files identified</div>
            <RawDisplayStats content={rawDisplayContent} />
          </div>
          {parsed.files.map((file) => (
            <CollapsibleSection
              key={file.path}
              title={
                <span className="flex items-center gap-2 flex-wrap min-w-0 w-full">
                  <span className="font-mono text-[11px] truncate flex-1 min-w-0">{file.path}</span>
                  <div className="flex items-center gap-1.5 shrink-0 ml-auto">
                    <span className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border leading-none ${relevanceColor(file.relevance)}`}>
                      Relevance: {file.relevance}
                    </span>
                    <span className="text-[9px] uppercase font-bold text-muted-foreground px-1.5 py-0.5 rounded border border-border bg-muted/30 leading-none">
                      Action: {file.likely_action}
                    </span>
                  </div>
                </span>
              }
              defaultOpen={false}
            >
              <div className="space-y-2">
                <div className="text-xs italic text-muted-foreground">{file.rationale}</div>
                {file.contentPreview && (
                  <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                    {file.contentPreview}{(file.contentLength ?? 0) > 200 ? '\n…' : ''}
                  </pre>
                )}
                {file.contentLength != null && (
                  <div className="text-[10px] text-muted-foreground">{file.contentLength.toLocaleString()} chars extracted</div>
                )}
              </div>
            </CollapsibleSection>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * The envelope the plan arrives in, built from the tag rather than written out.
 *
 * This is the only place in the client that reads the model's wire protocol, and
 * it had the tag as a literal. A literal is invisible to a rename: every server
 * parser would follow the constant to the new name and this viewer would go on
 * matching the old envelope, so the approval pane would show the user a raw
 * `<TAG>` wrapper instead of the plan inside it — no error, just the wrong text.
 * Interpolating is safe: the tag names are a closed set of `[A-Z_]` words with
 * nothing a regex reads as syntax.
 */
const EXECUTION_SETUP_PLAN_ENVELOPE = new RegExp(
  `${openTag(PROTOCOL_TAGS.EXECUTION_SETUP_PLAN)}\\s*([\\s\\S]*?)\\s*${closeTag(PROTOCOL_TAGS.EXECUTION_SETUP_PLAN)}`,
)

function extractExecutionSetupPlanPayloadText(value: string): string {
  const trimmed = value.trim()
  const markerMatch = EXECUTION_SETUP_PLAN_ENVELOPE.exec(trimmed)
  return markerMatch?.[1]?.trim() ?? trimmed
}

function isExecutionSetupModelOutputEquivalentToRawPlan(rawPlanContent: string, modelOutput?: string | null): boolean {
  if (!modelOutput?.trim()) return false

  const normalizedModelOutput = extractExecutionSetupPlanPayloadText(modelOutput)
  if (normalizedModelOutput === rawPlanContent.trim()) return true

  const rawPlan = parseExecutionSetupPlanContent(rawPlanContent).plan
  const modelPlan = parseExecutionSetupPlanContent(normalizedModelOutput).plan
  if (!rawPlan || !modelPlan) return false

  return JSON.stringify(rawPlan) === JSON.stringify(modelPlan)
}

function describeExecutionSetupQualityGatePolicy(
  field: 'tests' | 'lint' | 'typecheck' | 'fullProjectFallback',
  value: string,
): string {
  if (!value.trim()) {
    return 'No default policy text was recorded for this gate.'
  }

  if (field === 'tests') {
    if (value === 'bead-test-commands-first') {
      return 'Later coding beads should start with the bead-specific test commands before broadening to larger suites.'
    }
    return 'Default test gate that later coding beads should try first.'
  }

  if (field === 'lint' || field === 'typecheck') {
    if (value === 'impacted-or-package') {
      return `Prefer ${field === 'lint' ? 'linting' : 'typechecking'} the impacted package, workspace, or narrowed scope before escalating to the whole repository.`
    }
    return `Default ${field === 'lint' ? 'lint' : 'typecheck'} scope guidance for later coding beads.`
  }

  if (value === 'never-block-on-unrelated-baseline') {
    return 'If the full repository already has unrelated baseline debt, later phases should not fail solely because of that unrelated debt.'
  }
  return 'Fallback rule for how later phases should handle broader repository-wide gate failures.'
}

function labelExecutionSetupReadiness(status: 'ready' | 'partial' | 'missing'): string {
  switch (status) {
    case 'ready':
      return 'Ready'
    case 'missing':
      return 'Missing'
    default:
      return 'Partial'
  }
}

function ExecutionSetupPlanView({
  content,
  reportContent,
  header,
}: {
  content: string
  reportContent?: string | null
  header?: React.ReactNode
}) {
  const { plan, error } = parseExecutionSetupPlanContent(content)
  const report: ExecutionSetupPlanReportData | null = reportContent ? parseExecutionSetupPlanReport(reportContent) : null

  if (!plan || error) {
    return <RawContentWithCopy content={content} />
  }

  const stepCount = plan.steps.length
  const requiredStepCount = plan.steps.filter((step) => step.required).length
  const optionalStepCount = Math.max(stepCount - requiredStepCount, 0)
  const commandCount = plan.steps.reduce((total, step) => total + step.commands.length, 0)
  const workspaceProbeCount = plan.workspaceProbes.length
  const workspaceInputCount = plan.workspaceInputs.length
  const detectedHookCount = plan.gitHooks.detected.length
  const hookValidationCount = plan.gitHooks.validationCommands.length
  const generatedAtLabel = formatArtifactTimestampLabel(report?.generatedAt)
  const readinessLabel = labelExecutionSetupReadiness(plan.readiness.status)
  const readinessTone = plan.readiness.status === 'ready'
    ? 'success'
    : plan.readiness.status === 'missing'
      ? 'danger'
      : 'warning'
  const qualityGateEntries = [
    {
      label: 'Tests',
      value: plan.qualityGatePolicy.tests,
      hint: describeExecutionSetupQualityGatePolicy('tests', plan.qualityGatePolicy.tests),
    },
    {
      label: 'Lint',
      value: plan.qualityGatePolicy.lint,
      hint: describeExecutionSetupQualityGatePolicy('lint', plan.qualityGatePolicy.lint),
    },
    {
      label: 'Typecheck',
      value: plan.qualityGatePolicy.typecheck,
      hint: describeExecutionSetupQualityGatePolicy('typecheck', plan.qualityGatePolicy.typecheck),
    },
    {
      label: 'Fallback',
      value: plan.qualityGatePolicy.fullProjectFallback,
      hint: describeExecutionSetupQualityGatePolicy('fullProjectFallback', plan.qualityGatePolicy.fullProjectFallback),
    },
  ] as const
  const sourceLabel = report?.source === 'regenerate'
    ? 'Regenerated draft'
    : report?.source === 'auto'
      ? 'Initial draft'
      : 'Draft'
  const statusTone = report?.ready === false || report?.status === 'failed'
    ? 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100'
    : 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
  const errors = report?.errors ?? []
  const notes = report?.notes ?? []
  const failed = report?.ready === false || report?.status === 'failed'
  const modelOutput = report?.modelOutput
  const hasModelOutput = Boolean(modelOutput)
    && !isExecutionSetupModelOutputEquivalentToRawPlan(content, report?.modelOutput)
    && !failed
  const rawSourceLabel = formatRawAttemptSourceLabel('Execution setup plan', report?.generatedBy)
  const rawSources: RawContentSource[] | undefined = report?.modelOutput || report?.rawAttempts?.length
    ? [{
        id: 'execution-setup-plan-model-output',
        label: rawSourceLabel,
        modelId: report?.generatedBy,
        variants: dedupeRawContentVariants([
          ...(report?.modelOutput ? [{
            id: 'execution-setup-plan-model-output:current',
            label: 'Model Output',
            content: report.modelOutput,
            displayContent: report.modelOutput,
            ariaLabel: `${rawSourceLabel} Model Output`,
            title: 'Show execution setup plan model output',
          }] : []),
          ...buildRawAttemptVariants('execution-setup-plan', rawSourceLabel, report?.rawAttempts),
        ]),
        disabled: !report?.modelOutput && !report?.rawAttempts?.length,
        title: 'Show execution setup plan raw diagnostics',
      }]
    : undefined
  const projectCommandGroups: Array<{ title: string; items: string[]; emptyLabel: string }> = [
    {
      title: 'Prepare Commands',
      items: plan.projectCommands.prepare.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No shared prepare commands were recorded.',
    },
    {
      title: 'Full Test Commands',
      items: plan.projectCommands.testFull.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No full test commands were recorded.',
    },
    {
      title: 'Full Lint Commands',
      items: plan.projectCommands.lintFull.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No full lint commands were recorded.',
    },
    {
      title: 'Full Typecheck Commands',
      items: plan.projectCommands.typecheckFull.map((command) => renderCommandSpec(command, plan.hostContext.preferredShell)),
      emptyLabel: 'No full typecheck commands were recorded.',
    },
  ]

  const resolvedHeader = report?.generatedBy
    ? (
      <ModelBadge modelId={report.generatedBy} active className="px-3 py-2 h-auto flex-1 justify-start">
        <div className="text-left">
          <div className="text-xs font-medium">{getModelDisplayName(report.generatedBy)}</div>
          <div className="text-[10px] opacity-80 mt-0.5">
            {sourceLabel}
            {generatedAtLabel ? ` · ${generatedAtLabel}` : ''}
          </div>
        </div>
      </ModelBadge>
      )
    : header ?? <div className="text-xs font-semibold px-1">Execution Setup Plan</div>

  return (
    <WithRawTab
      content={content}
      structuredLabel="Plan"
      header={resolvedHeader}
      notice={<ArtifactProcessingNotice structuredOutput={report?.structuredOutput} kind="artifact" />}
      rawSources={rawSources}
    >
      <div className="space-y-4">
        <div className={cn('rounded-md border px-3 py-3', statusTone)}>
          <div className="flex items-start gap-2">
            {report?.ready === false || report?.status === 'failed'
              ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              : <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{report?.summary || plan.summary}</div>
              <div className="mt-1 text-xs leading-5">
                {plan.readiness.actionsRequired
                  ? 'Temporary-only setup contract for preparing the workspace before coding begins.'
                  : 'Workspace audited as already ready. Approving this plan keeps execution setup effectively no-op unless you edit the plan later.'}
              </div>
              {(generatedAtLabel || report?.source) ? (
                <div className="mt-2 text-[11px] opacity-80">
                  {sourceLabel}
                  {generatedAtLabel ? ` · ${generatedAtLabel}` : ''}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-3 2xl:grid-cols-10 gap-3">
          <MetadataCard label="Readiness" value={readinessLabel} tone={readinessTone} />
          <MetadataCard label="Actions" value={plan.readiness.actionsRequired ? 'Yes' : 'No'} tone={plan.readiness.actionsRequired ? 'warning' : 'success'} />
          <MetadataCard label="Steps" value={stepCount.toLocaleString()} tone="info" />
          <MetadataCard label="Required" value={requiredStepCount.toLocaleString()} tone={requiredStepCount > 0 ? 'success' : 'default'} />
          <MetadataCard label="Optional" value={optionalStepCount.toLocaleString()} tone={optionalStepCount > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Commands" value={commandCount.toLocaleString()} tone={commandCount > 0 ? 'info' : 'default'} />
          <MetadataCard label="Workspace Inputs" value={workspaceInputCount.toLocaleString()} tone={workspaceInputCount > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Workspace Probes" value={workspaceProbeCount.toLocaleString()} tone={workspaceProbeCount > 0 ? 'info' : 'warning'} />
          <MetadataCard label="Detected Hooks" value={detectedHookCount.toLocaleString()} tone={detectedHookCount > 0 ? 'info' : 'default'} />
          <MetadataCard label="Hook Checks" value={hookValidationCount.toLocaleString()} tone={hookValidationCount > 0 ? 'success' : 'default'} />
        </div>

        <CollapsibleSection title="Workspace Verification" defaultOpen>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <div className="space-y-3">
              <ArtifactListSection
                title="Approved Workspace Inputs"
                items={plan.workspaceInputs.map((input) => `${input.path} (${input.kind}, ${input.sourceStatus}, ${input.category}${input.allowLargeCopy ? ', large-copy override' : ''}): ${input.reason}`)}
                emptyLabel="No ignored or untracked workspace inputs were approved."
                tone="default"
              />
              <ArtifactListSection
                title="Workspace Probes"
                items={plan.workspaceProbes.map((probe) => `${probe.id}: ${renderCommandSpec(probe.command, plan.hostContext.preferredShell)}${probe.purpose ? ` — ${probe.purpose}` : ''}`)}
                emptyLabel="No repository-level workspace probes were recorded."
                tone="default"
              />
            </div>
            <div className="space-y-3">
              <MetadataCard label="Git Hook Policy" value={plan.gitHooks.policy.replaceAll('_', ' ')} tone="info" />
              <ArtifactListSection
                title="Detected Git Hooks"
                items={plan.gitHooks.detected.map((hook) => `${hook.name}: ${hook.path} (${hook.kind === 'manager_config' ? 'manager configuration' : 'hook file'}; ${hook.source || 'unknown source'}; runnable ${hook.runnable}${hook.managerHint ? `; ${hook.managerHint}` : ''})`)}
                emptyLabel="No Git hooks were detected."
                tone="default"
              />
              <ArtifactListSection
                title="Git Hook Validation Commands"
                items={plan.gitHooks.validationCommands.map((entry) => `${entry.hook || 'hook'}: ${renderCommandSpec(entry.command, plan.hostContext.preferredShell)}${entry.purpose ? ` — ${entry.purpose}` : ''}`)}
                emptyLabel="No explicit hook validations were approved; hook validation will be recorded as skipped."
                tone="default"
              />
            </div>
          </div>
        </CollapsibleSection>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
          <ArtifactListSection
            title="Observed Evidence"
            items={plan.readiness.evidence}
            emptyLabel="No readiness evidence was recorded."
            tone="default"
          />
          <ArtifactListSection
            title="Open Gaps"
            items={plan.readiness.gaps}
            emptyLabel={plan.readiness.status === 'ready' ? 'No unresolved setup gaps remain.' : 'No explicit setup gaps were recorded.'}
            tone={plan.readiness.status === 'ready' ? 'preserved' : 'error'}
          />
          <ArtifactListSection
            title="Temporary Roots"
            items={plan.tempRoots}
            emptyLabel="No temporary runtime roots were recorded."
            tone="default"
          />
          <ArtifactListSection
            title="Plan Cautions"
            items={plan.cautions}
            emptyLabel="No plan-level cautions were recorded."
            tone="error"
          />
        </div>

        <CollapsibleSection
          title={(
            <span className="flex items-center gap-2">
              <span>Setup Steps</span>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{stepCount}</span>
            </span>
          )}
          defaultOpen
        >
          <div className="space-y-3">
            {plan.steps.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                No setup steps are proposed for this ticket. The readiness assessment says the current workspace is already sufficient for coding.
              </div>
            ) : (
              plan.steps.map((step, index) => (
                <div key={step.id || index} className="rounded-lg border border-border bg-background px-3 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-mono text-amber-700 dark:bg-amber-900 dark:text-amber-300">
                      #{index + 1}
                    </span>
                    <div className="min-w-0 flex-1 text-sm font-semibold">{step.title || `Step ${index + 1}`}</div>
                    <span className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                      step.required
                        ? 'border-green-300 bg-green-50 text-green-800 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-200'
                        : 'border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-200',
                    )}>
                      {step.required ? 'Required' : 'Optional'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground leading-5">{step.purpose}</p>
                  {step.commands.length > 0 ? (
                    <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-muted/30 p-3 text-[11px] font-mono whitespace-pre-wrap">
                      <code>{step.commands.join('\n')}</code>
                    </pre>
                  ) : (
                    <div className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                      No commands were recorded for this step.
                    </div>
                  )}
                  {step.rationale ? (
                    <div className="mt-3 rounded-md border border-border bg-muted/20 px-3 py-2">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Rationale</div>
                      <div className="mt-1 text-xs leading-5">{step.rationale}</div>
                    </div>
                  ) : null}
                  {step.cautions.length > 0 ? (
                    <div className="mt-3">
                      <ArtifactListSection
                        title="Step Cautions"
                        items={step.cautions}
                        emptyLabel="No step cautions were recorded."
                        tone="error"
                      />
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Project Command Families" defaultOpen>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {projectCommandGroups.map((group) => (
              <ArtifactListSection
                key={group.title}
                title={group.title}
                items={group.items}
                emptyLabel={group.emptyLabel}
                tone="default"
              />
            ))}
          </div>
        </CollapsibleSection>

        <CollapsibleSection title="Quality Gate Policy" defaultOpen>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {qualityGateEntries.map((entry) => (
              <MetadataCard
                key={entry.label}
                label={entry.label}
                value={entry.value || 'Not specified'}
                hint={entry.hint}
                tone="info"
              />
            ))}
          </div>
        </CollapsibleSection>

        {(notes.length > 0 || errors.length > 0 || hasModelOutput) ? (
          <CollapsibleSection title="Generation Details" defaultOpen={errors.length > 0}>
            <div className="space-y-3">
              {notes.length > 0 ? (
                <ArtifactListSection
                  title="Regenerate Commentary"
                  items={notes}
                  emptyLabel="No regenerate commentary was recorded."
                  tone="default"
                />
              ) : null}

              {errors.length > 0 ? (
                <ArtifactListSection
                  title="Generation Errors"
                  items={errors}
                  emptyLabel="No generation errors were recorded."
                  tone="error"
                />
              ) : null}

              {hasModelOutput ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Model Output</div>
                    <CopyButton content={modelOutput ?? ''} title="Copy model output" />
                  </div>
                  <pre className="rounded-md border border-border bg-background p-3 text-[11px] font-mono whitespace-pre-wrap break-all overflow-x-auto overflow-y-hidden">
                    {modelOutput}
                  </pre>
                </div>
              ) : null}
            </div>
          </CollapsibleSection>
        ) : null}
      </div>
    </WithRawTab>
  )
}

function ExecutionSetupCommandFamilies({
  projectCommands,
}: {
  projectCommands: ExecutionSetupProfileData['projectCommands']
}) {
  const projectCommandGroups: Array<{ title: string; items: string[]; emptyLabel: string }> = [
    {
      title: 'Prepare Commands',
      items: projectCommands.prepare,
      emptyLabel: 'No shared prepare commands were recorded.',
    },
    {
      title: 'Full Test Commands',
      items: projectCommands.testFull,
      emptyLabel: 'No full test commands were recorded.',
    },
    {
      title: 'Full Lint Commands',
      items: projectCommands.lintFull,
      emptyLabel: 'No full lint commands were recorded.',
    },
    {
      title: 'Full Typecheck Commands',
      items: projectCommands.typecheckFull,
      emptyLabel: 'No full typecheck commands were recorded.',
    },
  ]

  return (
    <CollapsibleSection title="Project Command Families" defaultOpen>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {projectCommandGroups.map((group) => (
          <ArtifactListSection
            key={group.title}
            title={group.title}
            items={group.items}
            emptyLabel={group.emptyLabel}
            tone="default"
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function ExecutionSetupQualityGateGrid({
  qualityGatePolicy,
}: {
  qualityGatePolicy: ExecutionSetupProfileData['qualityGatePolicy']
}) {
  const qualityGateEntries = [
    {
      label: 'Tests',
      value: qualityGatePolicy.tests,
      hint: describeExecutionSetupQualityGatePolicy('tests', qualityGatePolicy.tests),
    },
    {
      label: 'Lint',
      value: qualityGatePolicy.lint,
      hint: describeExecutionSetupQualityGatePolicy('lint', qualityGatePolicy.lint),
    },
    {
      label: 'Typecheck',
      value: qualityGatePolicy.typecheck,
      hint: describeExecutionSetupQualityGatePolicy('typecheck', qualityGatePolicy.typecheck),
    },
    {
      label: 'Fallback',
      value: qualityGatePolicy.fullProjectFallback,
      hint: describeExecutionSetupQualityGatePolicy('fullProjectFallback', qualityGatePolicy.fullProjectFallback),
    },
  ] as const

  return (
    <CollapsibleSection title="Quality Gate Policy" defaultOpen>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {qualityGateEntries.map((entry) => (
          <MetadataCard
            key={entry.label}
            label={entry.label}
            value={entry.value || 'Not specified'}
            hint={entry.hint}
            tone="info"
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function ExecutionSetupReusableArtifacts({
  artifacts,
}: {
  artifacts: ExecutionSetupProfileData['reusableArtifacts']
}) {
  return (
    <CollapsibleSection
      title={(
        <span className="flex items-center gap-2">
          <span>Reusable Artifacts</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{artifacts.length}</span>
        </span>
      )}
      defaultOpen={artifacts.length > 0}
    >
      {artifacts.length > 0 ? (
        <div className="space-y-2">
          {artifacts.map((artifact, index) => (
            <div key={`${artifact.path}:${index}`} className="rounded-md border border-border bg-background px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-mono break-all">{artifact.path}</code>
                {artifact.kind ? (
                  <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {artifact.kind}
                  </span>
                ) : null}
              </div>
              {artifact.purpose ? <p className="mt-2 text-xs text-muted-foreground leading-5">{artifact.purpose}</p> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No reusable artifacts were recorded.</div>
      )}
    </CollapsibleSection>
  )
}

function ExecutionSetupProfileSummary({
  profile,
}: {
  profile: ExecutionSetupProfileData
}) {
  const statusReady = profile.status === 'ready'
  const statusTone = statusReady
    ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
    : 'border-blue-300 bg-blue-50 text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100'
  const workspacePassed = profile.workspaceProbeReceipts.filter((receipt) => receipt.status === 'passed').length
  const hooksPassed = profile.gitHooks.validationReceipts.filter((receipt) => receipt.status === 'passed').length

  return (
    <div className="space-y-4">
      <div className={cn('rounded-md border px-3 py-3', statusTone)}>
        <div className="flex items-start gap-2">
          {statusReady
            ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
            : <FileCode2 className="h-4 w-4 shrink-0 mt-0.5" />}
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">{profile.summary || 'Execution setup profile'}</div>
            <div className="mt-1 text-xs leading-5">
              Reusable workspace runtime guidance for coding beads.
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 xl:grid-cols-11 gap-3">
        <MetadataCard label="Status" value={profile.status || 'Unknown'} tone={statusReady ? 'success' : 'info'} />
        <MetadataCard label="Temp Roots" value={profile.tempRoots.length.toLocaleString()} tone="info" />
        <MetadataCard label="Workspace Inputs" value={profile.workspaceInputs.length.toLocaleString()} tone={profile.workspaceInputs.length > 0 ? 'info' : 'default'} />
        <MetadataCard label="Bootstrap" value={profile.bootstrapCommands.length.toLocaleString()} tone={profile.bootstrapCommands.length > 0 ? 'info' : 'default'} />
        <MetadataCard label="Probes" value={profile.toolingProbeCommands.length.toLocaleString()} tone={profile.toolingProbeCommands.length > 0 ? 'success' : 'default'} />
        <MetadataCard label="Workspace Probes" value={profile.workspaceProbes.length.toLocaleString()} tone={profile.workspaceProbes.length > 0 ? 'success' : 'warning'} />
        <MetadataCard label="Hook Checks" value={profile.gitHooks.validationCommands.length.toLocaleString()} tone={profile.gitHooks.validationCommands.length > 0 ? 'success' : 'default'} />
        <MetadataCard label="Workspace Results" value={`${workspacePassed}/${profile.workspaceProbeReceipts.length}`} tone={workspacePassed === profile.workspaceProbeReceipts.length && workspacePassed > 0 ? 'success' : 'default'} />
        <MetadataCard label="Hook Results" value={`${hooksPassed}/${profile.gitHooks.validationReceipts.length}`} tone={hooksPassed === profile.gitHooks.validationReceipts.length && hooksPassed > 0 ? 'success' : 'default'} />
        <MetadataCard label="Reusable" value={profile.reusableArtifacts.length.toLocaleString()} tone={profile.reusableArtifacts.length > 0 ? 'success' : 'default'} />
        <MetadataCard label="Ticket" value={profile.ticketId || 'Unknown'} mono />
      </div>

      <CollapsibleSection title="Workspace and Git Hook Verification" defaultOpen>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <ArtifactListSection
            title="Workspace Probes"
            items={profile.workspaceProbes.map((probe) => `${probe.id}: ${probe.command}${probe.purpose ? ` — ${probe.purpose}` : ''}`)}
            emptyLabel="No repository-level workspace probes were recorded."
          />
          <ArtifactListSection
            title="Approved Workspace Inputs"
            items={profile.workspaceInputs.map((input) => `${input.path} (${input.kind}, ${input.sourceStatus}): ${input.reason}`)}
            emptyLabel="No workspace inputs were approved."
          />
          <ArtifactListSection
            title="Workspace Probe Outcomes"
            items={profile.workspaceProbeReceipts.map((receipt) => `${receipt.id}: ${receipt.status} (${receipt.durationMs}ms${receipt.exitCode == null ? '' : `; exit ${receipt.exitCode}`})${receipt.outputExcerpt ? ` — ${receipt.outputExcerpt}` : ''}`)}
            emptyLabel="No workspace probe outcomes were recorded."
            tone="default"
          />
          <div className="space-y-3">
            <MetadataCard label="Git Hook Policy" value={profile.gitHooks.policy.replaceAll('_', ' ')} tone="info" />
            <ArtifactListSection
              title="Detected Git Hooks"
              items={profile.gitHooks.detected.map((hook) => `${hook.name}: ${hook.path} (${hook.source || 'unknown source'})`)}
              emptyLabel="No Git hooks were detected."
            />
            <ArtifactListSection
              title="Git Hook Validation Commands"
              items={profile.gitHooks.validationCommands.map((entry) => `${entry.hook || 'hook'}: ${entry.command}`)}
              emptyLabel="No explicit hook validation commands were approved."
            />
            <ArtifactListSection
              title="Git Hook Validation Outcomes"
              items={profile.gitHooks.validationReceipts.map((receipt) => `${receipt.id}: ${receipt.status} (${receipt.durationMs}ms${receipt.exitCode == null ? '' : `; exit ${receipt.exitCode}`})${receipt.outputExcerpt ? ` — ${receipt.outputExcerpt}` : ''}`)}
              emptyLabel="No Git-hook validation outcomes were recorded."
            />
          </div>
        </div>
      </CollapsibleSection>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ArtifactListSection
          title="Temporary Roots"
          items={profile.tempRoots}
          emptyLabel="No temporary runtime roots were recorded."
          tone="default"
        />
        <ArtifactListSection
          title="Bootstrap Commands"
          items={profile.bootstrapCommands}
          emptyLabel="No bootstrap commands were recorded."
          tone="default"
        />
        <ArtifactListSection
          title="Tooling Probes"
          items={profile.toolingProbeCommands}
          emptyLabel="No tooling probes were recorded."
          tone="default"
        />
      </div>

      <ExecutionSetupReusableArtifacts artifacts={profile.reusableArtifacts} />
      <ExecutionSetupCommandFamilies projectCommands={profile.projectCommands} />
      <ExecutionSetupQualityGateGrid qualityGatePolicy={profile.qualityGatePolicy} />
      <ArtifactListSection
        title="Cautions"
        items={profile.cautions}
        emptyLabel="No profile cautions were recorded."
        tone="error"
      />
    </div>
  )
}

function ExecutionSetupProfileView({ content }: { content: string }) {
  const profile = parseExecutionSetupProfile(content)
  if (!profile) {
    return <RawContentWithCopy content={content} />
  }

  return (
    <WithRawTab
      content={content}
      structuredLabel="Profile"
      header={<div className="text-xs font-semibold px-1">Execution Setup Profile</div>}
    >
      <ExecutionSetupProfileSummary profile={profile} />
    </WithRawTab>
  )
}

function getExecutionSetupCheckTone(value: string): 'default' | 'success' | 'warning' | 'danger' | 'info' {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return 'default'
  if (normalized === 'pass' || normalized === 'passed' || normalized === 'ready' || normalized === 'ok') return 'success'
  if (normalized === 'fail' || normalized === 'failed' || normalized === 'error') return 'danger'
  return 'warning'
}

function ExecutionSetupChecksView({
  checks,
}: {
  checks: NonNullable<ExecutionSetupRuntimeReportData['checks']>
}) {
  const entries = [
    { label: 'Workspace', value: checks.workspace },
    { label: 'Tooling', value: checks.tooling },
    { label: 'Temp Scope', value: checks.tempScope },
    { label: 'Policy', value: checks.policy },
  ]

  return (
    <CollapsibleSection title="Checks" defaultOpen>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {entries.map((entry) => (
          <MetadataCard
            key={entry.label}
            label={entry.label}
            value={entry.value || 'Not recorded'}
            tone={getExecutionSetupCheckTone(entry.value)}
          />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function ExecutionSetupAttemptHistoryView({
  attempts,
}: {
  attempts: ExecutionSetupRuntimeReportData['attemptHistory']
}) {
  return (
    <CollapsibleSection
      title={(
        <span className="flex items-center gap-2">
          <span>Attempt History</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{attempts.length}</span>
        </span>
      )}
      defaultOpen={attempts.length > 0}
    >
      {attempts.length > 0 ? (
        <div className="space-y-3">
          {attempts.map((attempt) => {
            const failed = attempt.status === 'failed'
            const checkedAtLabel = formatArtifactTimestampLabel(attempt.checkedAt)
            return (
              <div key={attempt.attempt} className="rounded-md border border-border bg-background px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">Attempt {attempt.attempt}</span>
                  <span className={cn(
                    'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider',
                    failed
                      ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-200'
                      : 'border-green-300 bg-green-50 text-green-800 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-200',
                  )}>
                    {attempt.status}
                  </span>
                  {checkedAtLabel ? <span className="text-[11px] text-muted-foreground">{checkedAtLabel}</span> : null}
                </div>
                {attempt.summary ? <p className="mt-2 text-xs text-muted-foreground leading-5">{attempt.summary}</p> : null}
                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                  <ArtifactListSection
                    title="Temp Roots"
                    items={attempt.tempRoots}
                    emptyLabel="No temp roots were recorded for this attempt."
                  />
                  <ArtifactListSection
                    title="Bootstrap Commands"
                    items={attempt.bootstrapCommands}
                    emptyLabel="No bootstrap commands were recorded for this attempt."
                  />
                </div>
                {(attempt.errors.length > 0 || attempt.failureReason || attempt.noteAppended) ? (
                  <div className="mt-3 space-y-3">
                    <ArtifactListSection
                      title="Errors"
                      items={attempt.errors.length > 0 ? attempt.errors : (attempt.failureReason ? [attempt.failureReason] : [])}
                      emptyLabel="No attempt errors were recorded."
                      tone="error"
                    />
                    {attempt.noteAppended ? (
                      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground leading-5">
                        <span className="font-medium text-foreground">Retry note:</span> {attempt.noteAppended}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No attempt history was recorded.</div>
      )}
    </CollapsibleSection>
  )
}

function ExecutionSetupReportView({ content, runtimeLabel = false }: { content: string; runtimeLabel?: boolean }) {
  const report = parseExecutionSetupRuntimeReport(content)
  if (!report) {
    return <RawContentWithCopy content={content} />
  }

  const failed = report.ready === false || report.status === 'failed'
  const checkedAtLabel = formatArtifactTimestampLabel(report.checkedAt)
  const attemptCount = report.attemptHistory.length || report.attempt || 0
  const statusLabel = failed ? 'failed' : report.status || (report.ready ? 'ready' : 'unknown')
  const statusTone = failed
    ? 'border-red-300 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100'
    : 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
  const rawSourceLabel = formatRawAttemptSourceLabel('Execution setup', report.preparedBy)
  const rawSources: RawContentSource[] | undefined = report.modelOutput || report.rawAttempts?.length
    ? [{
        id: 'execution-setup-model-output',
        label: rawSourceLabel,
        modelId: report.preparedBy,
        variants: dedupeRawContentVariants([
          ...(report.modelOutput ? [{
            id: 'execution-setup-model-output:current',
            label: 'Model Output',
            content: report.modelOutput,
            displayContent: report.modelOutput,
            ariaLabel: `${rawSourceLabel} Model Output`,
            title: 'Show execution setup model output',
          }] : []),
          ...buildRawAttemptVariants('execution-setup', rawSourceLabel, report.rawAttempts),
        ]),
        disabled: !report.modelOutput && !report.rawAttempts?.length,
        title: 'Show execution setup raw diagnostics',
      }]
    : undefined
  const header = report.preparedBy
    ? (
      <ModelBadge modelId={report.preparedBy} active className="px-3 py-2 h-auto flex-1 justify-start">
        <div className="text-left">
          <div className="text-xs font-medium">{getModelDisplayName(report.preparedBy)}</div>
          <div className="text-[10px] opacity-80 mt-0.5">
            {runtimeLabel ? 'Execution setup runtime' : 'Execution setup report'}
            {checkedAtLabel ? ` · ${checkedAtLabel}` : ''}
          </div>
        </div>
      </ModelBadge>
      )
    : <div className="text-xs font-semibold px-1">{runtimeLabel ? 'Execution Setup Runtime' : 'Execution Setup Report'}</div>

  return (
    <WithRawTab
      content={content}
      structuredLabel={runtimeLabel ? 'Runtime' : 'Report'}
      header={header}
      notice={<ArtifactProcessingNotice structuredOutput={report.structuredOutput} kind="artifact" status={failed ? 'failed' : 'completed'} />}
      rawSources={rawSources}
    >
      <div className="space-y-4">
        <div className={cn('rounded-md border px-3 py-3', statusTone)}>
          <div className="flex items-start gap-2">
            {failed
              ? <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
              : <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{report.summary || (failed ? 'Execution setup failed' : 'Execution setup ready')}</div>
              <div className="mt-1 text-xs leading-5">
                {failed
                  ? 'Workspace runtime setup did not produce an accepted reusable profile.'
                  : 'Workspace runtime setup produced a reusable profile for coding beads.'}
              </div>
              {checkedAtLabel ? <div className="mt-2 text-[11px] opacity-80">Checked at {checkedAtLabel}</div> : null}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-5 gap-3">
          <MetadataCard label="Status" value={statusLabel} tone={failed ? 'danger' : 'success'} />
          <MetadataCard label="Ready" value={report.ready === undefined ? 'Unknown' : report.ready ? 'Yes' : 'No'} tone={report.ready ? 'success' : failed ? 'danger' : 'default'} />
          <MetadataCard label="Attempt" value={report.attempt?.toLocaleString() ?? (attemptCount > 0 ? attemptCount.toLocaleString() : 'Unknown')} tone="info" />
          <MetadataCard label="Max Iterations" value={report.maxIterations == null ? 'Unlimited' : report.maxIterations.toLocaleString()} tone="default" />
          <MetadataCard label="Added Commands" value={report.executionAddedCommands.length.toLocaleString()} tone={report.executionAddedCommands.length > 0 ? 'warning' : 'success'} />
        </div>

        {report.checks ? <ExecutionSetupChecksView checks={report.checks} /> : null}

        {report.profile ? (
          <CollapsibleSection title="Profile Snapshot" defaultOpen>
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground leading-5">{report.profile.summary || 'No profile summary was recorded.'}</p>
              <div className="grid grid-cols-2 xl:grid-cols-7 gap-3">
                <MetadataCard label="Temp Roots" value={report.profile.tempRoots.length.toLocaleString()} tone="info" />
                <MetadataCard label="Bootstrap" value={report.profile.bootstrapCommands.length.toLocaleString()} tone={report.profile.bootstrapCommands.length > 0 ? 'info' : 'default'} />
                <MetadataCard label="Probes" value={report.profile.toolingProbeCommands.length.toLocaleString()} tone={report.profile.toolingProbeCommands.length > 0 ? 'success' : 'default'} />
                <MetadataCard label="Workspace Probes" value={report.profile.workspaceProbes.length.toLocaleString()} tone={report.profile.workspaceProbes.length > 0 ? 'success' : 'warning'} />
                <MetadataCard label="Hook Checks" value={report.profile.gitHooks.validationCommands.length.toLocaleString()} tone={report.profile.gitHooks.validationCommands.length > 0 ? 'success' : 'default'} />
                <MetadataCard label="Reusable" value={report.profile.reusableArtifacts.length.toLocaleString()} tone={report.profile.reusableArtifacts.length > 0 ? 'success' : 'default'} />
                <MetadataCard label="Status" value={report.profile.status || 'Unknown'} tone={report.profile.status === 'ready' ? 'success' : 'default'} />
              </div>
            </div>
          </CollapsibleSection>
        ) : null}

        <ExecutionSetupAttemptHistoryView attempts={report.attemptHistory} />

        <CollapsibleSection title="Command Audit" defaultOpen={report.executionAddedCommands.length > 0}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <ArtifactListSection
              title="Approved Plan Commands"
              items={report.approvedPlanCommands}
              emptyLabel="No approved plan commands were recorded."
            />
            <ArtifactListSection
              title="Execution Added Commands"
              items={report.executionAddedCommands}
              emptyLabel="No additional execution setup commands were recorded."
              tone={report.executionAddedCommands.length > 0 ? 'error' : 'preserved'}
            />
          </div>
        </CollapsibleSection>

        <ArtifactListSection
          title="Retry Notes"
          items={report.retryNotes}
          emptyLabel="No retry notes were recorded."
          tone="default"
        />

        <ArtifactListSection
          title="Worktree Warnings"
          items={report.worktreeWarnings}
          emptyLabel="No worktree warnings were recorded."
          tone="warning"
        />

        <ArtifactListSection
          title="Errors"
          items={report.errors}
          emptyLabel="No execution setup errors were recorded."
          tone="error"
        />

        {report.modelOutput && !failed ? (
          <CollapsibleSection title="Model Output">
            <div className="space-y-2">
              <div className="flex justify-end">
                <CopyButton content={report.modelOutput} title="Copy model output" />
              </div>
              <pre className="rounded-md border border-border bg-background p-3 text-[11px] font-mono whitespace-pre-wrap break-all overflow-x-auto overflow-y-hidden">
                {report.modelOutput}
              </pre>
            </div>
          </CollapsibleSection>
        ) : null}
      </div>
    </WithRawTab>
  )
}

function ExecutionSetupRuntimeView({ content }: { content: string }) {
  if (parseExecutionSetupRuntimeReport(content)) {
    return <ExecutionSetupReportView content={content} runtimeLabel />
  }
  if (parseExecutionSetupProfile(content)) {
    return <ExecutionSetupProfileView content={content} />
  }
  return <RawContentWithCopy content={content} />
}

function FinalTestResultsView({ content }: { content: string }) {
  const parsed = tryParseStructuredContent(content) as FinalTestExecutionReportData | null
  if (
    !parsed
    || typeof parsed !== 'object'
    || !Array.isArray(parsed.commands)
    || !Array.isArray(parsed.errors)
    || typeof parsed.modelOutput !== 'string'
  ) {
    return <RawContentWithCopy content={content} />
  }

  const checkedAtLabel = Number.isNaN(Date.parse(parsed.checkedAt))
    ? parsed.checkedAt
    : new Date(parsed.checkedAt).toLocaleString()
  const header = parsed.plannedBy
    ? (
      <ModelBadge modelId={parsed.plannedBy} active className="px-3 py-2 h-auto flex-1 justify-start">
        <div className="text-left">
          <div className="text-xs font-medium">{getModelDisplayName(parsed.plannedBy)}</div>
          <div className="text-[10px] opacity-80 mt-0.5">Final test results</div>
        </div>
      </ModelBadge>
      )
    : <div className="text-xs font-semibold px-1">Final Test Results</div>
  const rawSourceLabel = formatRawAttemptSourceLabel('final test generation', parsed.plannedBy)
  const rawSources: RawContentSource[] | undefined = parsed.modelOutput || parsed.rawAttempts?.length
    ? [{
        id: 'final-test-model-output',
        label: rawSourceLabel,
        modelId: parsed.plannedBy,
        variants: dedupeRawContentVariants([
          ...(parsed.modelOutput ? [{
            id: 'final-test-model-output:current',
            label: 'Model Output',
            content: parsed.modelOutput,
            displayContent: parsed.modelOutput,
            ariaLabel: `${rawSourceLabel} Model Output`,
            title: 'Show final-test model output',
          }] : []),
          ...buildRawAttemptVariants('final-test', rawSourceLabel, parsed.rawAttempts),
        ]),
        disabled: !parsed.modelOutput && !parsed.rawAttempts?.length,
        title: 'Show final-test raw diagnostics',
      }]
    : undefined

  return (
    <WithRawTab
      content={content}
      structuredLabel="Results"
      header={header}
      notice={<ArtifactProcessingNotice structuredOutput={parsed.planStructuredOutput} kind="final-test" />}
      rawSources={rawSources}
    >
      <div className="space-y-4">
        <div className={`rounded-md border px-3 py-2 text-xs font-medium ${
          parsed.passed
            ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200'
            : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200'
        }`}>
          {parsed.passed ? 'Final test commands passed' : 'Final test commands failed'}
        </div>

        <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Checked at {checkedAtLabel}.
          {parsed.summary ? ` Summary: ${parsed.summary}` : ''}
        </div>

        {parsed.testFiles && parsed.testFiles.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Test Files</div>
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs font-mono text-foreground space-y-0.5">
              {parsed.testFiles.map((file, i) => (
                <div key={i}>{file}</div>
              ))}
            </div>
          </div>
        )}

        {parsed.fileEffects && parsed.fileEffects.length > 0 && (
          <div className="space-y-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">File Effects</div>
            <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground space-y-1">
              {parsed.fileEffects.map((effect, i) => (
                <div key={`${effect.path}:${effect.intent}:${i}`} className="flex flex-wrap gap-2">
                  <span className="font-mono">{effect.path}</span>
                  <Badge variant="outline" className="text-[10px]">{effect.intent}</Badge>
                  {effect.reason ? <span className="text-muted-foreground">{effect.reason}</span> : null}
                </div>
              ))}
            </div>
          </div>
        )}

        {parsed.commands.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Executed Commands</div>
            {parsed.commands.map((command, index) => {
              const commandLabel = command.displayCommand?.trim()
                || (typeof command.command === 'string'
                  ? command.command
                  : (() => {
                      const structuredCommand = commandSpecSchema.safeParse(command.command)
                      return structuredCommand.success ? renderCommandSpec(structuredCommand.data) : 'Unknown command'
                    })())
              const commandStatus = command.timedOut
                ? 'Timed Out'
                : command.exitCode === 0
                  ? 'Passed'
                  : 'Failed'
              return (
                <CollapsibleSection
                  key={`${commandLabel}:${index}`}
                  title={(
                    <span className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-[11px]">{commandLabel}</span>
                      <span className="text-[10px] text-muted-foreground">{commandStatus}</span>
                      <span className="text-[10px] text-muted-foreground">{command.durationMs}ms</span>
                    </span>
                  )}
                >
                  <div className="space-y-2">
                    <div className="text-[11px] text-muted-foreground">
                      Exit code: {command.exitCode ?? 'none'}
                      {command.signal ? ` · Signal: ${command.signal}` : ''}
                      {command.setupWrapperApplied ? ' · Setup wrapper applied' : ''}
                    </div>
                    {command.effectiveCommand ? (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Effective Command</div>
                        <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                          {command.effectiveCommand}
                        </pre>
                      </div>
                    ) : null}
                    {command.stdout ? (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Stdout</div>
                        <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                          {command.stdout}
                        </pre>
                      </div>
                    ) : null}
                    {command.stderr ? (
                      <div>
                        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Stderr</div>
                        <pre className="text-[11px] font-mono bg-background rounded border border-border p-2 overflow-x-auto whitespace-pre-wrap">
                          {command.stderr}
                        </pre>
                      </div>
                    ) : null}
                  </div>
                </CollapsibleSection>
              )
            })}
          </div>
        ) : (
          <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            No final test commands were executed.
          </div>
        )}

        {parsed.errors.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Errors</div>
            <div className="space-y-2">
              {parsed.errors.map((error, index) => (
                <div key={`${error}:${index}`} className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                  {error}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </WithRawTab>
  )
}

function formatArtifactTimestampLabel(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString()
}

function MetadataCard({
  label,
  value,
  hint,
  mono = false,
  tone = 'default',
}: {
  label: string
  value: React.ReactNode
  hint?: React.ReactNode
  mono?: boolean
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info'
}) {
  const toneClassName = tone === 'success'
    ? 'border-green-300/70 bg-green-50/70 dark:border-green-900/60 dark:bg-green-950/20'
    : tone === 'warning'
      ? 'border-amber-300/70 bg-amber-50/70 dark:border-amber-900/60 dark:bg-amber-950/20'
      : tone === 'danger'
        ? 'border-red-300/70 bg-red-50/70 dark:border-red-900/60 dark:bg-red-950/20'
        : tone === 'info'
          ? 'border-blue-300/70 bg-blue-50/70 dark:border-blue-900/60 dark:bg-blue-950/20'
          : 'border-border bg-background'

  return (
    <div className={cn('rounded-md border px-3 py-2 min-w-0', toneClassName)}>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-1 text-sm font-semibold text-foreground break-all', mono && 'font-mono text-[11px] leading-5')}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-[10px] text-muted-foreground leading-4">{hint}</div> : null}
    </div>
  )
}

function ArtifactListSection({
  title,
  items,
  emptyLabel,
  tone = 'default',
}: {
  title: string
  items: string[]
  emptyLabel: string
  tone?: 'default' | 'removed' | 'preserved' | 'warning' | 'error'
}) {
  const itemClassName = tone === 'removed'
    ? 'border-red-200 bg-red-50/70 text-red-950 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-100'
    : tone === 'preserved'
      ? 'border-blue-200 bg-blue-50/70 text-blue-950 dark:border-blue-900/50 dark:bg-blue-950/20 dark:text-blue-100'
      : tone === 'warning' || tone === 'error'
        ? 'border-amber-200 bg-amber-50/80 text-amber-950 dark:border-amber-900/50 dark:bg-amber-950/20 dark:text-amber-100'
        : 'border-border bg-background text-foreground'

  return (
    <CollapsibleSection
      title={(
        <span className="flex items-center gap-2">
          <span>{title}</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            {items.length}
          </span>
        </span>
      )}
      defaultOpen={items.length > 0}
    >
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div
              key={`${title}:${item}:${index}`}
              className={cn('rounded-md border px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all', itemClassName)}
            >
              {item}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">{emptyLabel}</div>
      )}
    </CollapsibleSection>
  )
}

function IntegrationReportView({ content }: { content: string }) {
  const parsed: IntegrationReportData | null = parseIntegrationReport(content)
  if (!parsed) {
    return <RawContentWithCopy content={content} />
  }

  const completedAtLabel = formatArtifactTimestampLabel(parsed.completedAt)
  const isPassed = parsed.status === 'passed'
  const isFailed = parsed.status === 'failed'
  const title = isPassed
    ? 'Integration candidate prepared'
    : isFailed
      ? 'Integration failed'
      : 'Integration report'
  const message = parsed.message
    ?? (isPassed
      ? 'Integration completed and the squashed candidate is ready for manual verification.'
      : 'Integration details were recorded.')

  const metadataCards: Array<React.ReactNode> = []

  if (parsed.baseBranch) {
    metadataCards.push(
      <MetadataCard key="base-branch" label="Base Branch" value={parsed.baseBranch} mono hint="Destination branch for verification merge" />,
    )
  }
  if (parsed.candidateCommitSha) {
    metadataCards.push(
      <MetadataCard key="candidate-commit" label="Candidate Commit" value={parsed.candidateCommitSha} mono hint="Squashed candidate commit ready for review" />,
    )
  }
  if (parsed.mergeBase) {
    metadataCards.push(
      <MetadataCard key="merge-base" label="Merge Base" value={parsed.mergeBase} mono hint="Common ancestor used for the squash" />,
    )
  }
  if (parsed.preSquashHead) {
    metadataCards.push(
      <MetadataCard key="pre-squash-head" label="Pre-Squash Head" value={parsed.preSquashHead} mono hint="Ticket branch head before creating the candidate commit" />,
    )
  }
  if (parsed.commitCount != null) {
    metadataCards.push(
      <MetadataCard
        key="commit-count"
        label="Squashed Commits"
        value={parsed.commitCount.toLocaleString()}
        hint={`${parsed.commitCount} commit${parsed.commitCount === 1 ? '' : 's'} consolidated into the candidate commit`}
        tone={parsed.commitCount > 0 ? 'info' : 'default'}
      />,
    )
  }

  return (
    <WithRawTab
      content={content}
      structuredLabel="Report"
      header={<div className="text-xs font-semibold px-1">Integration Report</div>}
    >
      <div className="space-y-4">
        <div className={cn(
          'rounded-md border px-3 py-3',
          isPassed
            ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
            : isFailed
              ? 'border-red-300 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100'
              : 'border-border bg-background text-foreground',
        )}>
          <div className="flex items-start gap-2">
            {isPassed
              ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              : isFailed
                ? <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <div className="text-sm font-semibold">{title}</div>
              <div className="mt-1 text-xs leading-5">{message}</div>
              {completedAtLabel ? (
                <div className="mt-2 text-[11px] opacity-80">Completed at {completedAtLabel}</div>
              ) : null}
            </div>
          </div>
        </div>

        {metadataCards.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {metadataCards}
          </div>
        ) : null}

        {parsed.pushDeferred && parsed.pushed === false && !parsed.pushError ? (
          <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-800 dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-200">
            Remote ticket branch stays on the last bead backup until manual verification. Verifying rewrites it once to this squashed candidate.
          </div>
        ) : null}

        {parsed.pushError ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
            <div className="font-semibold">Remote update failed</div>
            <div className="mt-1 whitespace-pre-wrap break-words">{parsed.pushError}</div>
          </div>
        ) : null}
      </div>
    </WithRawTab>
  )
}

interface PullRequestBodySection {
  title: string
  lines: string[]
}

function parsePullRequestBodySections(body: string): PullRequestBodySection[] {
  const sections: PullRequestBodySection[] = []
  let current: PullRequestBodySection | null = null

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    const heading = line.match(/^##\s+(.+)$/)
    if (heading?.[1]) {
      current = { title: heading[1].trim(), lines: [] }
      sections.push(current)
      continue
    }
    if (!current) {
      if (!line) continue
      current = { title: 'Body', lines: [] }
      sections.push(current)
    }
    if (line) current.lines.push(line.replace(/^-\s+/, ''))
  }

  return sections
}

function PullRequestBodyPreview({ body }: { body: string }) {
  const sections = parsePullRequestBodySections(body)
  if (sections.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        No pull request body was recorded.
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {sections.map((section) => (
        <div key={section.title} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{section.title}</div>
          {section.lines.length > 0 ? (
            <ul className="mt-2 space-y-1.5 text-xs text-foreground">
              {section.lines.map((line, index) => (
                <li key={`${section.title}:${index}`} className="flex gap-2 leading-5">
                  <span className="mt-2 h-1 w-1 rounded-full bg-muted-foreground/70 shrink-0" />
                  <span className="min-w-0 whitespace-pre-wrap break-words">{line}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-2 text-xs text-muted-foreground">No details recorded.</div>
          )}
        </div>
      ))}
    </div>
  )
}

function normalizeCandidateAuditDecisionLabel(decision: string): string {
  const normalized = decision.toLowerCase()
  if (normalized === 'include' || normalized === 'included') return 'Included'
  if (normalized === 'exclude' || normalized === 'excluded') return 'Excluded'
  if (normalized === 'ignore' || normalized === 'ignored') return 'Ignored'
  if (normalized === 'review' || normalized === 'reviewed') return 'Reviewed'
  return decision
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function isExcludedCandidateAuditEntry(entry: PullRequestCandidateFileAuditEntry): boolean {
  const normalized = entry.decision.toLowerCase()
  return normalized === 'exclude' || normalized === 'excluded' || normalized === 'ignore' || normalized === 'ignored'
}

function buildCandidateAuditEntriesForPaths(
  audit: PullRequestCandidateFileAuditData,
  paths: string[],
  fallbackDecision: string,
  predicate: (entry: PullRequestCandidateFileAuditEntry) => boolean,
): PullRequestCandidateFileAuditEntry[] {
  const byPath = new Map<string, PullRequestCandidateFileAuditEntry>()
  for (const entry of audit.entries) {
    if (predicate(entry) || paths.includes(entry.path)) {
      byPath.set(entry.path, entry)
    }
  }
  for (const path of paths) {
    if (!byPath.has(path)) byPath.set(path, { path, decision: fallbackDecision })
  }
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path))
}

function CandidateAuditEntryList({
  entries,
  emptyLabel,
}: {
  entries: PullRequestCandidateFileAuditEntry[]
  emptyLabel: string
}) {
  if (entries.length === 0) {
    return (
      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {entries.map((entry) => (
        <div key={`${entry.decision}:${entry.path}`} className="rounded-md border border-border bg-background px-3 py-2">
          <div className="flex min-w-0 items-start gap-2">
            <FileCode2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 break-all font-mono text-[11px] font-semibold text-foreground">{entry.path}</span>
                <span className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {normalizeCandidateAuditDecisionLabel(entry.decision)}
                </span>
              </div>
              <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {entry.reason || 'No reason recorded.'}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

function PullRequestCandidateFileAuditView({ audit }: { audit: PullRequestCandidateFileAuditData }) {
  const excludedEntries = buildCandidateAuditEntriesForPaths(
    audit,
    audit.excludedFiles,
    audit.ignoredFiles.length > 0 ? 'ignored' : 'exclude',
    isExcludedCandidateAuditEntry,
  )
  const includedCount = audit.stats?.includedFiles ?? audit.includedFiles.length
  const excludedCount = audit.stats?.excludedFiles ?? audit.excludedFiles.length
  const reviewedCount = audit.stats?.reviewedFiles ?? audit.reviewedFiles.length
  const totalCount = audit.stats?.totalFiles
    ?? new Set([...audit.includedFiles, ...audit.excludedFiles, ...audit.reviewedFiles]).size

  return (
    <CollapsibleSection
      title="Candidate File Audit"
      defaultOpen={excludedEntries.length > 0 || audit.warnings.length > 0}
    >
      <div className="space-y-3">
        {audit.message ? (
          <div className="rounded-md border border-border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground">
            {audit.message}
          </div>
        ) : null}

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <MetadataCard label="Total Files" value={totalCount.toLocaleString()} />
          <MetadataCard label="Included" value={includedCount.toLocaleString()} tone={includedCount > 0 ? 'success' : 'default'} />
          <MetadataCard label="Excluded" value={excludedCount.toLocaleString()} tone={excludedCount > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Reviewed" value={reviewedCount.toLocaleString()} tone={reviewedCount > 0 ? 'info' : 'default'} />
        </div>

        <div className="space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ignored / Excluded Files</div>
          <CandidateAuditEntryList
            entries={excludedEntries}
            emptyLabel="No ignored or excluded candidate files were recorded."
          />
        </div>

        {audit.warnings.length > 0 ? (
          <ArtifactListSection
            title="Audit Warnings"
            items={audit.warnings}
            emptyLabel="No audit warnings were recorded."
            tone="warning"
          />
        ) : null}
      </div>
    </CollapsibleSection>
  )
}

function PullRequestReportView({ content }: { content: string }) {
  const parsed: PullRequestReportData | null = parsePullRequestReport(content)
  if (!parsed) {
    return <RawContentWithCopy content={content} />
  }

  const completedAtLabel = formatArtifactTimestampLabel(parsed.completedAt)
  const createdAtLabel = formatArtifactTimestampLabel(parsed.createdAt)
  const updatedAtLabel = formatArtifactTimestampLabel(parsed.updatedAt)
  const isPassed = parsed.status === 'passed'
  const isFailed = parsed.status === 'failed'
  const title = isPassed
    ? 'Draft pull request ready'
    : isFailed
      ? 'Pull request creation failed'
      : 'Pull request report'
  const message = parsed.message
    ?? (isPassed
      ? 'The candidate branch was pushed and the draft pull request metadata was recorded.'
      : 'Pull request metadata was recorded.')
  const safePrUrl = getSafeGitHubPullRequestUrl(parsed.prUrl)

  const metadataCards: Array<React.ReactNode> = []

  if (parsed.prNumber != null) {
    metadataCards.push(
      <MetadataCard key="pr-number" label="PR Number" value={`#${parsed.prNumber}`} hint="GitHub pull request number" tone="info" />,
    )
  }
  if (parsed.prState) {
    metadataCards.push(
      <MetadataCard key="pr-state" label="PR State" value={parsed.prState} hint="Current state when this report was recorded" tone={parsed.prState === 'draft' || parsed.prState === 'open' ? 'success' : 'default'} />,
    )
  }
  if (parsed.baseBranch) {
    metadataCards.push(
      <MetadataCard key="base-branch" label="Base Branch" value={parsed.baseBranch} mono hint="Target branch for the pull request" />,
    )
  }
  if (parsed.headBranch) {
    metadataCards.push(
      <MetadataCard key="head-branch" label="Head Branch" value={parsed.headBranch} mono hint="Ticket branch pushed to GitHub" />,
    )
  }
  if (parsed.candidateCommitSha) {
    metadataCards.push(
      <MetadataCard key="candidate-commit" label="Candidate Commit" value={parsed.candidateCommitSha} mono hint="Squashed candidate commit used for the PR" />,
    )
  }
  if (parsed.prHeadSha) {
    metadataCards.push(
      <MetadataCard key="pr-head" label="PR Head SHA" value={parsed.prHeadSha} mono hint="GitHub head SHA reported for the PR" />,
    )
  }

  const body = parsed.body ?? ''

  return (
    <WithRawTab
      content={content}
      structuredLabel="Report"
      header={<div className="text-xs font-semibold px-1">Pull Request Report</div>}
    >
      <div className="space-y-4">
        <div className={cn(
          'rounded-md border px-3 py-3',
          isPassed
            ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
            : isFailed
              ? 'border-red-300 bg-red-50 text-red-950 dark:border-red-900/60 dark:bg-red-950/20 dark:text-red-100'
              : 'border-border bg-background text-foreground',
        )}>
          <div className="flex items-start gap-2">
            {isPassed
              ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              : isFailed
                ? <XCircle className="h-4 w-4 shrink-0 mt-0.5" />
                : <GitPullRequest className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{title}</div>
              <div className="mt-1 text-xs leading-5">{message}</div>
              {completedAtLabel ? (
                <div className="mt-2 text-[11px] opacity-80">Completed at {completedAtLabel}</div>
              ) : null}
            </div>
          </div>
        </div>

        {safePrUrl ? (
          <a
            href={safePrUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-start gap-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-blue-950 transition-colors hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100 dark:hover:bg-blue-950/30"
          >
            <GitPullRequest className="h-4 w-4 shrink-0 mt-0.5" />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-semibold">Open draft PR in GitHub</span>
              <span className="mt-1 block text-[11px] font-mono break-all">{safePrUrl}</span>
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          </a>
        ) : parsed.prUrl ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
            Recorded pull request URL is not a valid GitHub PR link.
          </div>
        ) : (
          <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
            No pull request URL was recorded yet.
          </div>
        )}

        {parsed.title ? (
          <div className="rounded-md border border-border bg-background px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">PR Title</div>
            <div className="mt-1 text-sm font-semibold text-foreground break-words">{parsed.title}</div>
          </div>
        ) : null}

        {metadataCards.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {metadataCards}
          </div>
        ) : null}

        {(createdAtLabel || updatedAtLabel || parsed.mergedAt || parsed.closedAt) ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {createdAtLabel ? <MetadataCard label="Created At" value={createdAtLabel} /> : null}
            {updatedAtLabel ? <MetadataCard label="Updated At" value={updatedAtLabel} /> : null}
            {parsed.mergedAt ? <MetadataCard label="Merged At" value={formatArtifactTimestampLabel(parsed.mergedAt)} tone="success" /> : null}
            {parsed.closedAt ? <MetadataCard label="Closed At" value={formatArtifactTimestampLabel(parsed.closedAt)} tone="warning" /> : null}
          </div>
        ) : null}

        {parsed.candidateFileAudit ? (
          <PullRequestCandidateFileAuditView audit={parsed.candidateFileAudit} />
        ) : null}

        <CollapsibleSection
          title="Generated PR Description"
          defaultOpen={Boolean(body)}
        >
          <PullRequestBodyPreview body={body} />
        </CollapsibleSection>
      </div>
    </WithRawTab>
  )
}

function CleanupReportView({ content }: { content: string }) {
  const parsed: CleanupReportData | null = parseCleanupReport(content)
  if (!parsed) {
    return <RawContentWithCopy content={content} />
  }

  const removedPathCount = parsed.removedDirs.length + parsed.removedFiles.length
  const cleanupSucceeded = parsed.status === 'clean'

  return (
    <WithRawTab
      content={content}
      structuredLabel="Report"
      header={<div className="text-xs font-semibold px-1">Cleanup Report</div>}
    >
      <div className="space-y-4">
        <div className={cn(
          'rounded-md border px-3 py-3',
          cleanupSucceeded
            ? 'border-green-300 bg-green-50 text-green-950 dark:border-green-900/60 dark:bg-green-950/20 dark:text-green-100'
            : 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100',
        )}>
          <div className="flex items-start gap-2">
            {cleanupSucceeded
              ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
            <div className="min-w-0">
              <div className="text-sm font-semibold">
                {cleanupSucceeded ? 'Cleanup completed cleanly' : 'Cleanup completed with warnings'}
              </div>
              <div className="mt-1 text-xs leading-5">
                Removed {removedPathCount} runtime path{removedPathCount === 1 ? '' : 's'} and preserved {parsed.preservedPaths.length} audit artifact{parsed.preservedPaths.length === 1 ? '' : 's'}.
              </div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
          <MetadataCard label="Removed Dirs" value={parsed.removedDirs.length.toLocaleString()} tone={parsed.removedDirs.length > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Removed Files" value={parsed.removedFiles.length.toLocaleString()} tone={parsed.removedFiles.length > 0 ? 'warning' : 'default'} />
          <MetadataCard label="Preserved Paths" value={parsed.preservedPaths.length.toLocaleString()} tone={parsed.preservedPaths.length > 0 ? 'info' : 'default'} />
          <MetadataCard label="Errors" value={parsed.errors.length.toLocaleString()} tone={parsed.errors.length > 0 ? 'danger' : 'success'} />
        </div>

        <div className="space-y-3">
          <ArtifactListSection
            title="Removed Directories"
            items={parsed.removedDirs}
            emptyLabel="No directories were removed."
            tone="removed"
          />
          <ArtifactListSection
            title="Removed Files"
            items={parsed.removedFiles}
            emptyLabel="No files were removed."
            tone="removed"
          />
          <ArtifactListSection
            title="Preserved Paths"
            items={parsed.preservedPaths}
            emptyLabel="No preserved paths were recorded."
            tone="preserved"
          />
          <ArtifactListSection
            title="Errors"
            items={parsed.errors}
            emptyLabel="No cleanup errors were recorded."
            tone="error"
          />
        </div>
      </div>
    </WithRawTab>
  )
}

interface PreFlightCheck {
  name: string
  category: string
  result: 'pass' | 'fail' | 'warning'
  message: string
  details?: string
}

interface PreFlightReportData {
  passed: boolean
  checks: PreFlightCheck[]
  criticalFailures: PreFlightCheck[]
  warnings: PreFlightCheck[]
}

const CATEGORY_LABELS: Record<string, string> = {
  connectivity: 'Connectivity',
  git: 'Git',
  artifacts: 'Artifacts',
  config: 'Configuration',
  graph: 'Dependency Graph',
}

const CATEGORY_ORDER = ['connectivity', 'git', 'artifacts', 'config', 'graph']

function PreFlightReportView({ content }: { content: string }) {
  const report = useMemo<PreFlightReportData | null>(() => {
    try {
      return JSON.parse(content) as PreFlightReportData
    } catch {
      return null
    }
  }, [content])

  const grouped = useMemo(() => {
    if (!report) return []
    const map = new Map<string, PreFlightCheck[]>()
    for (const check of report.checks) {
      const existing = map.get(check.category) ?? []
      existing.push(check)
      map.set(check.category, existing)
    }
    return CATEGORY_ORDER
      .filter(cat => map.has(cat))
      .map(cat => ({ category: cat, checks: map.get(cat)! }))
  }, [report])

  if (!report) {
    return <RawContentView content={content} />
  }

  return (
    <WithRawTab content={content} structuredLabel="Report">
      <div className="space-y-4">
        <div className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-2',
          report.passed
            ? 'border-green-500/30 bg-green-500/5 text-green-700 dark:text-green-400'
            : 'border-red-500/30 bg-red-500/5 text-red-700 dark:text-red-400',
        )}>
          {report.passed
            ? <CheckCircle2 className="h-4 w-4 shrink-0" />
            : <XCircle className="h-4 w-4 shrink-0" />}
          <span className="text-sm font-medium">
            {report.passed
              ? `All checks passed (${report.checks.length} checks)`
              : `Pre-flight failed — ${report.criticalFailures.length} critical issue${report.criticalFailures.length === 1 ? '' : 's'}`}
          </span>
          {report.warnings.length > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400 ml-auto">
              {report.warnings.length} warning{report.warnings.length === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {grouped.map(({ category, checks }) => (
          <div key={category} className="space-y-1">
            <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              {CATEGORY_LABELS[category] ?? category}
            </div>
            <div className="space-y-0.5">
              {checks.map((check, i) => (
                <div key={`${check.name}-${i}`} className="flex items-start gap-2 rounded px-2 py-1.5 text-xs">
                  {check.result === 'pass' && <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0 mt-0.5" />}
                  {check.result === 'fail' && <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />}
                  {check.result === 'warning' && <AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />}
                  <div className="min-w-0">
                    <div className={cn(
                      'font-medium',
                      check.result === 'fail' && 'text-red-700 dark:text-red-400',
                      check.result === 'warning' && 'text-amber-700 dark:text-amber-400',
                    )}>
                      {check.message}
                    </div>
                    {check.details && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">{check.details}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </WithRawTab>
  )
}

function DiffFileSection({ file }: { file: FileDiff }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="border border-border/60 rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-accent/40 transition-colors"
      >
        {isOpen
          ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-xs font-mono font-medium text-foreground truncate flex-1">{file.filename}</span>
        <span className="text-[11px] font-mono text-green-600 dark:text-green-400 shrink-0">+{file.additions}</span>
        <span className="text-[11px] font-mono text-red-600 dark:text-red-400 shrink-0">-{file.deletions}</span>
      </button>
      {isOpen && (() => {
        const numbered = computeLineNumbersWithWordDiff(file.lines)
        return (
          <div className="border-t border-border/40 bg-[var(--color-card)] overflow-auto">
            <div className="text-xs font-mono leading-[1.6]">
              {numbered.map((info, i) => {
                if (info.text.startsWith('---') || info.text.startsWith('+++')) return null
                let className = 'px-4'
                if (info.text.startsWith('@@')) {
                  className += ' text-blue-600 dark:text-blue-400 bg-blue-500/5 py-0.5 font-medium border-y border-blue-500/10'
                } else if (info.text.startsWith('+')) {
                  className += ' text-green-700 dark:text-green-300 bg-green-500/10'
                } else if (info.text.startsWith('-')) {
                  className += ' text-red-700 dark:text-red-300 bg-red-500/10'
                } else {
                  className += ' text-muted-foreground/80'
                }
                return (
                  <span key={i} className={`${className} grid grid-cols-[3.5ch_3.5ch_minmax(0,1fr)] items-start gap-x-1`}>
                    <span className="text-right text-muted-foreground/50 select-none">{info.oldNum ?? ' '}</span>
                    <span className="text-right text-muted-foreground/50 select-none">{info.newNum ?? ' '}</span>
                    <span className="min-w-0 whitespace-pre-wrap break-words break-all [overflow-wrap:anywhere]">
                      {renderUnifiedDiffLineText(info.text, info.wordDiffSegments)}
                    </span>
                  </span>
                )
              })}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function DiffStatsRow({ label, stats }: { label: string; stats: ReturnType<typeof parseDiffStats> }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-1 py-1 text-xs text-muted-foreground">
      <span className="font-medium">{label}</span>
      <span>{stats.files} file{stats.files !== 1 ? 's' : ''}</span>
      <span className="text-green-600 dark:text-green-400 font-mono">+{stats.additions}</span>
      <span className="text-red-600 dark:text-red-400 font-mono">-{stats.deletions}</span>
    </div>
  )
}

function EmptyDiffState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
      {children}
    </div>
  )
}

function DiffFileList({ diff }: { diff: string }) {
  const files = useMemo(() => parseFileDiffs(diff), [diff])

  if (files.length === 0) {
    return <EmptyDiffState>No changed files were found in this diff.</EmptyDiffState>
  }

  return (
    <div className="flex flex-col gap-1.5">
      {files.map((file, index) => (
        <DiffFileSection key={`${file.filename}:${index}`} file={file} />
      ))}
    </div>
  )
}

function BeadDiffSection({ bead, index }: { bead: ReturnType<typeof parseBeadCommitsDiffContent>['beads'][number]; index: number }) {
  const stats = parseDiffStats(bead.diff)
  const label = [
    bead.priority != null ? `#${bead.priority}` : null,
    bead.beadId,
    bead.label,
  ].filter(Boolean).join(' · ')

  return (
    <CollapsibleSection
      title={(
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="font-mono text-[11px]">{label || `bead-${index + 1}`}</span>
          <span className="text-[10px] text-muted-foreground">
            {stats.files} file{stats.files !== 1 ? 's' : ''} · +{stats.additions} -{stats.deletions}
          </span>
        </span>
      )}
      defaultOpen={index === 0}
      scrollOnOpen={false}
    >
      <DiffFileList diff={bead.diff} />
    </CollapsibleSection>
  )
}

function FileGroupSection({ group }: { group: FileDiffGroup }) {
  return (
    <CollapsibleSection
      title={(
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate font-mono text-[11px]">{group.filename}</span>
          <span className="text-[10px] text-muted-foreground">
            touched in {group.occurrences.length} bead{group.occurrences.length !== 1 ? 's' : ''} · +{group.additions} -{group.deletions}
          </span>
        </span>
      )}
      defaultOpen={false}
      scrollOnOpen={false}
    >
      <div className="space-y-2">
        {group.occurrences.map((occurrence, index) => (
          <div key={`${group.filename}:${occurrence.beadId ?? occurrence.beadIndex}:${index}`} className="space-y-1">
            <div className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {occurrence.beadLabel
                ? [
                    occurrence.beadPriority != null ? `#${occurrence.beadPriority}` : null,
                    occurrence.beadId ?? `bead-${occurrence.beadIndex + 1}`,
                    occurrence.beadLabel,
                  ].filter(Boolean).join(' · ')
                : [
                    occurrence.beadPriority != null ? `#${occurrence.beadPriority}` : null,
                    occurrence.beadId ?? `bead-${occurrence.beadIndex + 1}`,
                  ].filter(Boolean).join(' · ')}
            </div>
            <DiffFileSection file={occurrence} />
          </div>
        ))}
      </div>
    </CollapsibleSection>
  )
}

function BeadCommitsDiffView({ content }: { content: string }) {
  const parsed = useMemo(() => parseBeadCommitsDiffContent(content), [content])
  const netDiff = parsed.netDiff ?? ''
  const hasNetDiff = netDiff.trim().length > 0
  const hasBeadDiffs = parsed.beads.length > 0
  const defaultMode = hasNetDiff ? 'net' : hasBeadDiffs ? 'bead' : 'net'
  const [viewMode, setViewMode] = useState<'net' | 'bead' | 'file'>(defaultMode)
  const netStats = parseDiffStats(netDiff)
  const orderedBeads = useMemo(() => sortBeadCommitsByPriority(parsed.beads), [parsed.beads])
  const beadDiff = useMemo(() => buildCombinedDiffFromBeads(orderedBeads), [orderedBeads])
  const beadStats = useMemo(() => parseDiffStats(beadDiff), [beadDiff])
  const fileGroups = useMemo(() => groupFileDiffsByPath(orderedBeads), [orderedBeads])

  useEffect(() => {
    setViewMode(defaultMode)
  }, [defaultMode, content])

  const tabs = [
    {
      id: 'net' as const,
      label: 'Net Diff',
      disabled: !hasNetDiff,
      tooltip: !hasNetDiff ? 'Net diff will be available after passing the integration phase.' : undefined,
    },
    { id: 'bead' as const, label: 'By Bead', disabled: !hasBeadDiffs },
    { id: 'file' as const, label: 'By File', disabled: !hasBeadDiffs },
  ]
  const effectiveMode = tabs.some((tab) => tab.id === viewMode && !tab.disabled) ? viewMode : defaultMode

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-md border border-border bg-muted/40 p-0.5">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              disabled={tab.disabled}
              title={tab.tooltip}
              onClick={() => setViewMode(tab.id)}
              className={cn(
                'rounded px-2 py-1 text-xs font-medium transition-colors',
                effectiveMode === tab.id
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
                tab.disabled && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {effectiveMode === 'net' ? (
        <div className="flex flex-col gap-1.5">
          <DiffStatsRow label="Final PR net diff" stats={netStats} />
          {hasNetDiff ? <DiffFileList diff={netDiff} /> : <EmptyDiffState>No final net diff was captured.</EmptyDiffState>}
        </div>
      ) : null}

      {effectiveMode === 'bead' ? (
        <div className="flex flex-col gap-1.5">
          <DiffStatsRow label="Per-bead git commits" stats={beadStats} />
          {orderedBeads.map((bead, index) => (
            <BeadDiffSection key={`${bead.beadId}:${index}`} bead={bead} index={index} />
          ))}
        </div>
      ) : null}

      {effectiveMode === 'file' ? (
        <div className="flex flex-col gap-1.5">
          <DiffStatsRow label="Per-file git commits" stats={beadStats} />
          {fileGroups.length > 0
            ? fileGroups.map((group) => <FileGroupSection key={group.filename} group={group} />)
            : <EmptyDiffState>No bead file touches were captured.</EmptyDiffState>}
        </div>
      ) : null}
    </div>
  )
}

interface ManualQaArtifactItem {
  id: string
  title: string
  behavior: string
  severity: string
  source: string
  recheckState?: string
  prerequisites: string[]
  actions: string[]
  expectedResult: string
  watchNotes: string[]
  prdRefs: Array<{ ref: string; coverage?: string }>
  beadRefs: string[]
}

interface ManualQaArtifactChecklist {
  version: number | null
  generatedAt?: string
  summary?: string
  items: ManualQaArtifactItem[]
  notApplicablePrdRefs: Array<{ ref: string; reason: string }>
}

function manualQaArtifactRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function manualQaArtifactStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : []
}

/**
 * The repair trail generation recorded, folded into the artifact by the panel.
 *
 * Manual QA generation retries and repairs like every other artifact-processing
 * path, and until this was read the checklist view showed only the result — so
 * an operator never learned a repair had happened, and a generation that gave
 * up showed nothing at all.
 */
function readManualQaProcessingMetadata(content: string): {
  structuredOutput?: ArtifactStructuredOutputData
  validationError?: string
} {
  try {
    const envelope = JSON.parse(content) as { structuredOutput?: unknown; validationError?: unknown }
    return {
      ...(envelope.structuredOutput && typeof envelope.structuredOutput === 'object'
        ? { structuredOutput: envelope.structuredOutput as ArtifactStructuredOutputData }
        : {}),
      ...(typeof envelope.validationError === 'string' ? { validationError: envelope.validationError } : {}),
    }
  } catch {
    // The artifact can also be the canonical YAML document, which carries none.
    return {}
  }
}

function parseManualQaArtifactChecklist(content: string): { raw: string; checklist: ManualQaArtifactChecklist } | null {
  let raw = content
  try {
    const envelope = JSON.parse(content) as { checklist?: unknown }
    if (typeof envelope.checklist === 'string' && envelope.checklist.trim()) raw = envelope.checklist
  } catch {
    // The artifact can also be the canonical YAML document itself.
  }

  try {
    const parsed = manualQaArtifactRecord(jsYaml.load(raw))
    if (!parsed || !Array.isArray(parsed.items)) return null
    const items = parsed.items.map((value) => {
      const item = manualQaArtifactRecord(value)
      if (!item) return null
      const prdValues = Array.isArray(item.prdRefs) ? item.prdRefs : Array.isArray(item.prd_refs) ? item.prd_refs : []
      return {
        id: String(item.id ?? ''),
        title: String(item.title ?? ''),
        behavior: String(item.behavior ?? ''),
        severity: String(item.severity ?? 'optional'),
        source: String(item.source ?? 'implementation_diff'),
        recheckState: typeof (item.recheckState ?? item.recheck_state) === 'string' ? String(item.recheckState ?? item.recheck_state) : undefined,
        prerequisites: manualQaArtifactStrings(item.prerequisites),
        actions: manualQaArtifactStrings(item.actions),
        expectedResult: String(item.expectedResult ?? item.expected_result ?? ''),
        watchNotes: manualQaArtifactStrings(item.watchNotes ?? item.watch_notes),
        beadRefs: manualQaArtifactStrings(item.beadRefs ?? item.bead_refs),
        prdRefs: prdValues.map((referenceValue) => {
          const reference = manualQaArtifactRecord(referenceValue)
          return reference
            ? { ref: String(reference.ref ?? ''), coverage: typeof reference.coverage === 'string' ? reference.coverage : undefined }
            : { ref: String(referenceValue) }
        }).filter((reference) => reference.ref),
      }
    }).filter((item) => item !== null) as ManualQaArtifactItem[]
    const notApplicableValues = Array.isArray(parsed.notApplicablePrdRefs)
      ? parsed.notApplicablePrdRefs
      : Array.isArray(parsed.not_applicable_prd_refs)
        ? parsed.not_applicable_prd_refs
        : []
    const generatedAt = parsed.generatedAt ?? parsed.generated_at
    return {
      raw,
      checklist: {
        version: typeof parsed.version === 'number' ? parsed.version : null,
        generatedAt: typeof generatedAt === 'string'
          ? generatedAt
          : generatedAt instanceof Date
            ? generatedAt.toISOString()
            : undefined,
        summary: typeof parsed.summary === 'string' ? parsed.summary : undefined,
        items,
        notApplicablePrdRefs: notApplicableValues.map((value) => {
          const entry = manualQaArtifactRecord(value)
          return { ref: String(entry?.ref ?? ''), reason: String(entry?.reason ?? '') }
        }).filter((entry) => entry.ref && entry.reason),
      },
    }
  } catch {
    return null
  }
}

function ManualQaChecklistArtifactView({ parsed }: { parsed: ManualQaArtifactChecklist }) {
  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-muted/20 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-semibold">Manual QA checklist</p>
          {parsed.version !== null && <Badge variant="outline">Round v{parsed.version}</Badge>}
          <Badge variant="secondary">{parsed.items.length} check{parsed.items.length === 1 ? '' : 's'}</Badge>
        </div>
        {parsed.generatedAt && <p className="mt-1 text-xs text-muted-foreground">Generated {new Date(parsed.generatedAt).toLocaleString()}</p>}
        {parsed.summary && <p className="mt-2 text-sm text-muted-foreground">{parsed.summary}</p>}
      </div>

      {parsed.items.map((item, index) => (
        <section key={item.id || index} className="space-y-3 rounded-md border border-border p-3">
          <div>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h4 className="text-sm font-semibold">{index + 1}. {item.title || item.behavior || item.id}</h4>
              <div className="flex flex-wrap gap-1">
                <Badge variant={item.severity === 'required' ? 'default' : 'outline'}>{item.severity}</Badge>
                <Badge variant="secondary">{item.source.replace(/_/g, ' ')}</Badge>
                {item.recheckState && item.recheckState !== 'new' && <Badge variant="outline">{item.recheckState.replace(/_/g, ' ')}</Badge>}
              </div>
            </div>
            {item.behavior && item.behavior !== item.title && <p className="mt-1 text-xs text-muted-foreground">{item.behavior}</p>}
          </div>
          {item.prerequisites.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prerequisites</p><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{item.prerequisites.map((value, valueIndex) => <li key={`${value}:${valueIndex}`}>{value}</li>)}</ul></div>}
          <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Actions</p><ol className="mt-1 list-decimal space-y-1 pl-5 text-sm">{item.actions.map((value, valueIndex) => <li key={`${value}:${valueIndex}`}>{value}</li>)}</ol></div>
          <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-300">Expected result</p><p className="mt-1 text-sm">{item.expectedResult}</p></div>
          {item.watchNotes.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Watch for</p><ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{item.watchNotes.map((value, valueIndex) => <li key={`${value}:${valueIndex}`}>{value}</li>)}</ul></div>}
          {(item.prdRefs.length > 0 || item.beadRefs.length > 0) && <div className="flex flex-wrap gap-1">{item.prdRefs.map((reference) => <Badge key={`${reference.ref}:${reference.coverage}`} variant="outline">{reference.ref}{reference.coverage ? ` · ${reference.coverage}` : ''}</Badge>)}{item.beadRefs.map((reference) => <Badge key={reference} variant="outline">{reference}</Badge>)}</div>}
        </section>
      ))}

      {parsed.notApplicablePrdRefs.length > 0 && (
        <section className="rounded-md border border-border p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Not applicable to Manual QA</p>
          <dl className="mt-2 space-y-2 text-xs">{parsed.notApplicablePrdRefs.map((entry) => <div key={entry.ref}><dt className="font-mono font-medium">{entry.ref}</dt><dd className="text-muted-foreground">{entry.reason}</dd></div>)}</dl>
        </section>
      )}
    </div>
  )
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
