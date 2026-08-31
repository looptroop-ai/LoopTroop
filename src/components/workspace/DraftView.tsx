import { useState, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { LoadingText } from '@/components/ui/LoadingText'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTicketAction, useUpdateTicket } from '@/hooks/useTickets'
import type { Ticket } from '@/hooks/useTickets'
import { useProjects } from '@/hooks/useProjects'
import { useProfile } from '@/hooks/useProfile'
import { CalendarDays, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EffortBadge } from '@/components/shared/EffortBadge'
import { CollapsiblePhaseLogSection } from '@/components/workspace/CollapsiblePhaseLogSection'
import { TicketDescriptionTabs, type TicketDescriptionMode } from '@/components/ticket/TicketDescriptionTabs'
import { CopyButton } from './RawTextDisplay'
import { TicketDescriptionViewer } from '@/components/ticket/TicketDescriptionViewer'
import { SHARED_PROFILE_DEFAULTS as PROFILE_DEFAULTS } from '@shared/profileDefaults'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { resolveManualQaSettingLabel, type ManualQaOverride } from '@/lib/manualQaSetting'
import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import { TriStateSetting } from '@/components/settings/TriStateSetting'
import { InheritableDurationField } from '@/components/settings/InheritableDurationField'
import { AI_QUESTIONS_INHERITABLE_OPTIONS, AI_QUESTION_WAIT_HINT } from '@/components/settings/aiQuestionOptions'
import {
  describeSettingSource,
  resolveAiQuestionsSettingLabel,
  resolveAiQuestionWindowLabel,
  type AiQuestionsOverride,
  type AiQuestionWindowOverride,
} from '@/lib/aiQuestionSetting'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS, formatAiQuestionWindow } from '@shared/aiQuestions'

const PRIORITY_LABELS: Record<number, string> = { 1: 'Very High', 2: 'High', 3: 'Normal', 4: 'Low', 5: 'Very Low' }
const PRIORITY_COLORS: Record<number, string> = {
  1: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  2: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  3: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  4: 'bg-blue-100 text-blue-600 dark:bg-blue-900/30 dark:text-blue-400',
  5: 'bg-blue-50 text-blue-500 dark:bg-blue-900/20 dark:text-blue-300',
}

interface DraftViewProps {
  ticket: Ticket
}

function parseConfiguredCouncilMembers(raw: string | null | undefined): string[] {
  if (!raw) return []

  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []

    const unique = new Set<string>()
    const members: string[] = []

    for (const value of parsed) {
      const memberId = typeof value === 'string' ? value.trim() : ''
      if (!memberId || unique.has(memberId)) continue
      unique.add(memberId)
      members.push(memberId)
    }

    return members
  } catch {
    return []
  }
}

function resolveCurrentCouncilMembers(
  mainImplementer: string | null | undefined,
  rawCouncilMembers: string | null | undefined,
): string[] {
  const resolved = new Set<string>()
  const members: string[] = []
  const normalizedMainImplementer = typeof mainImplementer === 'string' ? mainImplementer.trim() : ''

  if (normalizedMainImplementer) {
    resolved.add(normalizedMainImplementer)
    members.push(normalizedMainImplementer)
  }

  for (const memberId of parseConfiguredCouncilMembers(rawCouncilMembers)) {
    if (resolved.has(memberId)) continue
    resolved.add(memberId)
    members.push(memberId)
  }

  return members
}

function formatStartErrorMessage(message: string) {
  const trimmed = message.trim() || 'Failed to start ticket.'
  if (trimmed.includes('configured in OpenCode')) {
    return `${trimmed} Update Configuration to choose currently available models, then try again.`
  }
  return trimmed
}

export function DraftView({ ticket }: DraftViewProps) {
  const { mutate: performAction, isPending } = useTicketAction()
  const { mutateAsync: updateTicket, isPending: isSavingDescription } = useUpdateTicket()
  const { data: projects = [] } = useProjects()
  const { data: profile, isLoading: isProfileLoading } = useProfile()
  const [isStartAttemptActive, setIsStartAttemptActive] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [descriptionDraft, setDescriptionDraft] = useState(ticket.description ?? '')
  const [descriptionMode, setDescriptionMode] = useState<TicketDescriptionMode>('markdown')
  const [isEditingDescription, setIsEditingDescription] = useState(false)
  const [descriptionError, setDescriptionError] = useState<string | null>(null)
  const [lastSyncedDescription, setLastSyncedDescription] = useState(ticket.description ?? '')
  const [shouldSkipNextSync, setShouldSkipNextSync] = useState(false)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const [manualQaOverride, setManualQaOverride] = useState<ManualQaOverride>(ticket.manualQaOverride ?? null)
  const [manualQaError, setManualQaError] = useState<string | null>(null)
  const [aiQuestionsOverride, setAiQuestionsOverride] = useState<AiQuestionsOverride>(ticket.aiQuestionsOverride ?? null)
  const [aiQuestionWindowOverride, setAiQuestionWindowOverride] = useState<AiQuestionWindowOverride>(ticket.aiQuestionWindowOverride ?? null)
  const [aiQuestionError, setAiQuestionError] = useState<string | null>(null)
  const project = projects.find(p => p.id === ticket.projectId)
  const mainImplementer = typeof profile?.mainImplementer === 'string'
    ? profile.mainImplementer.trim()
    : ''
  const currentCouncilMembers = resolveCurrentCouncilMembers(
    mainImplementer,
    project?.councilMembers ?? profile?.councilMembers ?? null,
  )
  const councilMemberVariants: Record<string, string> = profile?.councilMemberVariants
    ? (() => { try { return JSON.parse(profile.councilMemberVariants) as Record<string, string> } catch { return {} } })()
    : {}
  const mainImplementerVariant = profile?.mainImplementerVariant ?? null
  const highlightedMainImplementer = mainImplementer || currentCouncilMembers[0] || ''
  const shouldShowCouncilMembers = currentCouncilMembers.length > 0 || !isProfileLoading
  const savedDescription = ticket.description ?? ''
  const hasDescription = descriptionDraft.length > 0
  const hasDescriptionChanges = descriptionDraft !== savedDescription
  const effectiveManualQa = resolveManualQaSettingLabel(
    manualQaOverride,
    project?.manualQaOverride ?? null,
    profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled,
  )
  // What applies while this ticket inherits, so each row can name its source.
  const inheritedAiQuestions = resolveAiQuestionsSettingLabel(
    null,
    project?.aiQuestionsOverride,
    profile?.aiQuestionsEnabled ?? PROFILE_DEFAULTS.aiQuestionsEnabled,
  )
  const inheritedAiQuestionWindow = resolveAiQuestionWindowLabel(
    null,
    project?.aiQuestionWindowOverride,
    profile?.aiQuestionWindow ?? PROFILE_DEFAULTS.aiQuestionWindow,
  )

  // Sync draft from prop — use useEffect to avoid setting state during render
  // which can cause issues with React StrictMode double-rendering.
  useEffect(() => {
    if (savedDescription !== lastSyncedDescription) {
      setLastSyncedDescription(savedDescription)
      if (!isEditingDescription) {
        if (shouldSkipNextSync) {
          setShouldSkipNextSync(false)
        } else {
          setDescriptionDraft(savedDescription)
        }
      }
    }
  }, [savedDescription, lastSyncedDescription, isEditingDescription, shouldSkipNextSync])

  useEffect(() => {
    setManualQaOverride(ticket.manualQaOverride ?? null)
  }, [ticket.manualQaOverride])

  useEffect(() => {
    setAiQuestionsOverride(ticket.aiQuestionsOverride ?? null)
  }, [ticket.aiQuestionsOverride])

  useEffect(() => {
    setAiQuestionWindowOverride(ticket.aiQuestionWindowOverride ?? null)
  }, [ticket.aiQuestionWindowOverride])

  const handleStart = () => {
    setIsStartAttemptActive(true)
    setStartError(null)
    performAction(
      { id: ticket.id, action: 'start' },
      {
        onSuccess: () => setStartError(null),
        onError: (error) => {
          const message = error instanceof Error ? error.message : 'Failed to start ticket.'
          setStartError(formatStartErrorMessage(message))
        },
      },
    )
  }

  const handleEditDescription = () => {
    setDescriptionDraft(savedDescription)
    setDescriptionMode('raw')
    setDescriptionError(null)
    setIsEditingDescription(true)
  }

  const handleCancelDescriptionEdit = () => {
    setDescriptionDraft(savedDescription)
    setDescriptionError(null)
    setDescriptionMode('markdown')
    setIsEditingDescription(false)
  }

  const handleSaveDescription = async () => {
    if (!hasDescriptionChanges) {
      setDescriptionMode('markdown')
      setIsEditingDescription(false)
      return
    }

    setDescriptionError(null)
    try {
      const updated = await updateTicket({
        id: ticket.id,
        description: descriptionDraft,
      })
      setDescriptionDraft(updated.description ?? descriptionDraft)
      setShouldSkipNextSync(true)
      setDescriptionMode('markdown')
      setIsEditingDescription(false)
    } catch (error) {
      setDescriptionError(error instanceof Error ? error.message : 'Failed to save description.')
    }
  }

  const handleManualQaChange = async (value: ManualQaOverride) => {
    const previous = manualQaOverride
    setManualQaOverride(value)
    setManualQaError(null)
    try {
      await updateTicket({ id: ticket.id, manualQaOverride: value })
    } catch (error) {
      setManualQaOverride(previous)
      setManualQaError(error instanceof Error ? error.message : 'Failed to update Manual QA setting.')
    }
  }

  const handleAiQuestionsChange = async (value: AiQuestionsOverride) => {
    const previous = aiQuestionsOverride
    setAiQuestionsOverride(value)
    setAiQuestionError(null)
    try {
      await updateTicket({ id: ticket.id, aiQuestionsOverride: value })
    } catch (error) {
      setAiQuestionsOverride(previous)
      setAiQuestionError(error instanceof Error ? error.message : 'Failed to update the AI questions setting.')
    }
  }

  const handleAiQuestionWindowChange = async (value: AiQuestionWindowOverride) => {
    const previous = aiQuestionWindowOverride
    setAiQuestionWindowOverride(value)
    setAiQuestionError(null)
    try {
      await updateTicket({ id: ticket.id, aiQuestionWindowOverride: value })
    } catch (error) {
      setAiQuestionWindowOverride(previous)
      setAiQuestionError(error instanceof Error ? error.message : 'Failed to update the AI question wait.')
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden relative">
      <div className="flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-4 max-w-3xl mx-auto w-full">
          <div className="text-center">
            <h3 className="text-lg font-semibold">Ready to Start</h3>
            <p className="text-xs text-muted-foreground mt-1">
              Click Start to begin the AI-driven interview process. This may take hours — LoopTroop optimizes for correctness, not speed.
            </p>
          </div>

          {/* Ticket metadata: priority, creation date, project */}
          <div className="w-full flex flex-wrap items-center justify-center gap-3 text-xs">
            <Badge variant="outline" className={PRIORITY_COLORS[ticket.priority] ?? PRIORITY_COLORS[3]}>
              P{ticket.priority} — {PRIORITY_LABELS[ticket.priority] ?? 'Normal'}
            </Badge>
            <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center gap-1 text-muted-foreground">
                                    <CalendarDays className="h-3.5 w-3.5" />
                                    Created {new Date(ticket.createdAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                                  </span>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-center text-balance">{new Date(ticket.createdAt).toLocaleString()}</TooltipContent>
                      </Tooltip>
            {project && (
              <span className="flex items-center gap-1 text-muted-foreground">
                {project.icon && (project.icon.startsWith('data:') ? <img src={project.icon} className="h-3.5 w-3.5 rounded" alt="" /> : <span>{project.icon}</span>)}
                {project.name}
              </span>
            )}
          </div>

          {shouldShowCouncilMembers && (
            <div className="w-full flex justify-center">
              <div className="inline-flex max-w-full flex-col items-center gap-1 rounded-md border border-dashed border-border/70 bg-muted/25 px-2.5 py-1.5 text-center">
                <div className="flex items-center gap-1">
                  <span className="text-[9px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
                    Current Council Members
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-full border border-border/70 text-[8px] font-semibold leading-none text-muted-foreground transition-colors hover:bg-muted/60"
                        aria-label="Council member info"
                      >
                        i
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="max-w-56 text-[11px] leading-snug">
                      If you start this ticket now, these council members will stay fixed for the entire ticket lifecycle. To change the models, go to Configuration first.
                    </TooltipContent>
                  </Tooltip>
                </div>
                {currentCouncilMembers.length > 0 ? (
                  <div className="flex flex-wrap justify-center gap-1">
                    {currentCouncilMembers.map((memberId) => {
                      const variant = memberId === highlightedMainImplementer
                        ? mainImplementerVariant
                        : (councilMemberVariants[memberId] ?? null)
                      return (
                        <Badge
                          key={memberId}
                          variant={memberId === highlightedMainImplementer ? 'default' : 'secondary'}
                          className="h-auto max-w-full gap-1 px-1.5 py-0.5 text-[9px] leading-tight whitespace-normal"
                        >
                          {memberId === highlightedMainImplementer && (
                            <span className="rounded-sm bg-background/20 px-1 py-px text-[8px] font-semibold uppercase tracking-[0.14em]">
                              Main Implementer
                            </span>
                          )}
                          <span className="font-mono break-all">{memberId}</span>
                          {variant && <EffortBadge variant={variant} className="text-[8px]" />}
                        </Badge>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    No council members are configured yet.
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="w-full rounded-md border-2 border-border">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium"
              onClick={() => setIsAdvancedOpen((open) => !open)}
              aria-expanded={isAdvancedOpen}
            >
              Advanced
              <ChevronDown className={cn('h-4 w-4 transition-transform', isAdvancedOpen && 'rotate-180')} />
            </button>
            {isAdvancedOpen && (
              <div className="space-y-3 border-t border-border px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <h4 className="text-xs font-medium">Manual QA checkpoint</h4>
                    <ConfigurationDocsLink
                      docsPath="/configuration#manual-qa"
                      label="ticket Manual QA checkpoint"
                      description="Choose whether this ticket pauses for your verification after final tests. Open the Manual QA documentation."
                    />
                  </div>
                  <ManualQaSetting
                    idPrefix="draft-manual-qa"
                    value={manualQaOverride}
                    onChange={(value) => { void handleManualQaChange(value) }}
                    inheritedEnabled={effectiveManualQa.enabled}
                    disabled={isSavingDescription}
                    compact
                  />
                </div>
                {manualQaError && <p role="alert" className="mt-2 text-xs text-destructive">{manualQaError}</p>}

                <div className="flex items-start justify-between gap-2 border-t border-border pt-3">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <h4 className="text-xs font-medium">AI questions</h4>
                    <ConfigurationDocsLink
                      docsPath="/configuration#ai-questions"
                      label="ticket AI questions"
                      description="Choose whether a model may stop a step to ask you a question in this ticket. Open the AI questions documentation."
                    />
                  </div>
                  <TriStateSetting
                    idPrefix="draft-ai-questions"
                    groupLabel="AI questions setting"
                    options={AI_QUESTIONS_INHERITABLE_OPTIONS}
                    value={aiQuestionsOverride}
                    onChange={(value) => { void handleAiQuestionsChange(value) }}
                    disabled={isSavingDescription}
                    footer={aiQuestionsOverride === null && (
                      <p className="mt-1 text-right text-xs text-muted-foreground">
                        Inherits <span className="font-medium text-foreground">{inheritedAiQuestions.enabled ? 'On' : 'Off'}</span> from {describeSettingSource(inheritedAiQuestions.source)}.
                      </p>
                    )}
                  />
                </div>
                <div className="border-t border-border pt-3">
                  <InheritableDurationField
                    label="AI question wait"
                    idPrefix="draft-ai-question-wait"
                    value={aiQuestionWindowOverride}
                    onChange={(value) => { void handleAiQuestionWindowChange(value) }}
                    inheritedMs={inheritedAiQuestionWindow.windowMs}
                    inheritedSourceLabel={describeSettingSource(inheritedAiQuestionWindow.source)}
                    minMs={AI_QUESTION_WINDOW_MIN_MS}
                    maxMs={AI_QUESTION_WINDOW_MAX_MS}
                    formatValue={formatAiQuestionWindow}
                    disabled={isSavingDescription}
                    hint={`How long a question waits before the run carries on. ${AI_QUESTION_WAIT_HINT}`}
                  />
                </div>
                {aiQuestionError && <p role="alert" className="mt-2 text-xs text-destructive">{aiQuestionError}</p>}
              </div>
            )}
          </div>

          <div className="w-full rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <h4 className="text-xs font-medium">Description</h4>
              <div className="flex items-center gap-1.5">
                <TicketDescriptionTabs mode={descriptionMode} onModeChange={setDescriptionMode} />
                {descriptionMode === 'raw' && (
                  <CopyButton content={descriptionDraft} title="Copy description" />
                )}
                {!isEditingDescription && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleEditDescription}
                    className="h-7 px-2 text-[11px]"
                  >
                    {hasDescription ? 'Edit Description' : 'Add Description'}
                  </Button>
                )}
              </div>
            </div>

            {isEditingDescription ? (
              <>
                {descriptionMode === 'raw' ? (
                  <textarea
                    aria-label="Ticket description"
                    value={descriptionDraft}
                    onChange={(event) => setDescriptionDraft(event.target.value)}
                    className="mt-2 min-h-[140px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    placeholder="Describe what you want to build..."
                  />
                ) : (
                  <div className="mt-2 min-h-[140px] max-h-[300px] overflow-y-auto rounded-md border border-input bg-muted/30 px-3 py-2">
                    {descriptionDraft
                      ? <TicketDescriptionViewer description={descriptionDraft} className="text-xs" />
                      : <p className="text-xs text-muted-foreground">No description yet.</p>}
                  </div>
                )}
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleCancelDescriptionEdit}
                    disabled={isSavingDescription}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSaveDescription}
                    disabled={isSavingDescription || !hasDescriptionChanges}
                  >
                    {isSavingDescription ? <LoadingText text="Saving" /> : 'Save'}
                  </Button>
                </div>
                {descriptionError && (
                  <p role="alert" aria-live="polite" className="mt-2 text-xs text-destructive">
                    {descriptionError}
                  </p>
                )}
              </>
            ) : hasDescription ? (
              <div className="mt-2 max-h-[300px] overflow-y-auto">
                {descriptionMode === 'markdown'
                  ? <TicketDescriptionViewer description={descriptionDraft} className="text-xs" />
                  : <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{descriptionDraft}</p>}
              </div>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                No description yet. Add more context before starting the ticket.
              </p>
            )}
          </div>
        </div>
      </div>

      {isStartAttemptActive && (
        <div className="shrink-0 bg-background px-4 pb-3">
          <CollapsiblePhaseLogSection
            phase="DRAFT"
            ticket={ticket}
            variant="bottom"
            defaultHeight={220}
          />
        </div>
      )}

      <div className="shrink-0 border-t border-border bg-background p-4 flex flex-col items-center justify-center gap-2">
        <Button
          size="lg"
          onClick={handleStart}
          disabled={isPending}
          className="w-auto"
        >
          {isPending ? <LoadingText text="Starting" /> : '🚀 Start Ticket'}
        </Button>

        {startError && (
          <p role="alert" aria-live="polite" className="max-w-md text-center text-xs text-destructive">
            {startError}
          </p>
        )}
      </div>
    </div>
  )
}
