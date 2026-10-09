import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingText } from '@/components/ui/LoadingText'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownPicker } from '@/components/shared/DropdownPicker'
import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { AdvancedSettingRow, AdvancedSettings } from '@/components/settings/AdvancedSettings'
import { InheritableDurationField } from '@/components/settings/InheritableDurationField'
import { TriStateSetting } from '@/components/settings/TriStateSetting'
import { AI_QUESTIONS_INHERITABLE_OPTIONS, AI_QUESTION_WAIT_DISABLED_HINT, AI_QUESTION_WAIT_HELP, AI_QUESTION_WAIT_HINT } from '@/components/settings/aiQuestionOptions'
import type { Profile } from '@/hooks/useProfile'
import type { Project } from '@/hooks/useProjects'
import { describeSettingSource, resolveAiQuestionsSettingLabel, resolveAiQuestionWindowLabel, type AiQuestionsOverride, type AiQuestionWindowOverride } from '@/lib/aiQuestionSetting'
import { resolveManualQaSettingLabel, type ManualQaOverride } from '@/lib/manualQaSetting'
import { cn } from '@/lib/utils'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS, formatAiQuestionWindow } from '@shared/aiQuestions'
import { SHARED_PROFILE_DEFAULTS as PROFILE_DEFAULTS } from '@shared/profileDefaults'
import { TicketDescriptionTabs, type TicketDescriptionMode } from './TicketDescriptionTabs'
import { TicketDescriptionViewer } from './TicketDescriptionViewer'

const TicketFieldLabel = ({ label, help, className }: { label: string; help: string; className?: string }) => (
  <Tooltip>
    <TooltipTrigger asChild><label className={cn('text-sm font-medium', className)}>{label}</label></TooltipTrigger>
    <TooltipContent className="max-w-xs text-center text-balance">{help}</TooltipContent>
  </Tooltip>
)

const TicketProjectDisplay = ({ project }: { project: Project }) => (
  <span className="flex items-center gap-2 min-w-0 text-left overflow-hidden flex-1">
    <span className="shrink-0 flex items-center">
      {project.icon?.startsWith('data:')
        ? <img src={project.icon} className="h-5 w-5 rounded block" alt="" />
        : <span>{project.icon}</span>}
    </span>
    <span className="truncate">{project.name} ({project.shortname})</span>
  </span>
)

interface TicketProjectTriggerProps {
  project?: Project
  open: boolean
  disabled: boolean
}

const TicketProjectTrigger = ({ project, open, disabled }: TicketProjectTriggerProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        disabled={disabled}
        className={cn('w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-all shadow-2xs', open && 'ring-2 ring-brand-500/30')}
        style={project?.color ? { borderColor: `${project.color}45`, backgroundColor: `${project.color}0D` } : { borderColor: 'var(--color-border)' }}
      >
        {project ? <TicketProjectDisplay project={project} /> : <span className="truncate text-left text-muted-foreground">Select a project...</span>}
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs text-center text-balance">Choose project</TooltipContent>
  </Tooltip>
)

interface TicketProjectOptionProps {
  project: Project
  selected: boolean
  last: boolean
  disabled: boolean
  onSelect: () => void
}

const TicketProjectOption = ({ project, selected, last, disabled, onSelect }: TicketProjectOptionProps) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        disabled={disabled}
        className={cn('w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors', !last && 'border-b border-input', selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50')}
        onClick={onSelect}
      >
        <TicketProjectDisplay project={project} />
        {selected && <Check className="h-4 w-4 text-primary" />}
      </button>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs text-center text-balance">{`Use project ${project.name}`}</TooltipContent>
  </Tooltip>
)

interface TicketProjectOptionsProps {
  projects: Project[]
  project?: Project
  disabled: boolean
  onSelect: (id: number) => void
}

const TicketProjectOptions = ({ projects, project, disabled, onSelect }: TicketProjectOptionsProps) => (
  <div className="w-[420px] max-w-[calc(100vw-48px)]">
    <div className="rounded-md border border-input overflow-hidden">
      {projects.length === 0 && <div className="px-3 py-2 text-sm text-muted-foreground">No projects available</div>}
      {projects.map((candidate, index) => (
        <TicketProjectOption key={candidate.id} project={candidate} selected={project?.id === candidate.id} last={index === projects.length - 1} disabled={disabled} onSelect={() => onSelect(candidate.id)} />
      ))}
    </div>
  </div>
)

export const TicketProjectField = ({ projects, project, disabled, onSelect }: TicketProjectOptionsProps) => {
  const [open, setOpen] = useState(false)
  const selectProject = (id: number) => {
    onSelect(id)
    setOpen(false)
  }
  return (
    <div>
      <TicketFieldLabel label="Project" help="Project where the ticket will run" className="block mb-1" />
      <DropdownPicker open={open} onOpenChange={setOpen} trigger={<TicketProjectTrigger project={project} open={open} disabled={disabled} />}>
        <TicketProjectOptions projects={projects} project={project} disabled={disabled} onSelect={selectProject} />
      </DropdownPicker>
      {projects.length === 0 && <p className="mt-1 text-xs text-muted-foreground">No projects are attached yet. Add a project before creating a ticket.</p>}
    </div>
  )
}

export const TicketTitleField = ({ title, onChange }: { title: string; onChange: (title: string) => void }) => (
  <div>
    <TicketFieldLabel label="Title" help="Short summary of the requested work" className="block mb-1" />
    <input type="text" value={title} onChange={event => onChange(event.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" placeholder="Brief summary of the work" required />
  </div>
)

export const TicketDescriptionField = ({ description, onChange }: { description: string; onChange: (description: string) => void }) => {
  const [mode, setMode] = useState<TicketDescriptionMode>('raw')
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <TicketFieldLabel label="Description" help="Detailed implementation request" />
        <TicketDescriptionTabs mode={mode} onModeChange={setMode} />
      </div>
      {mode === 'raw' ? (
        <textarea aria-label="Ticket description" value={description} onChange={event => onChange(event.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm min-h-[140px]" placeholder="Describe what you want to build..." />
      ) : (
        <div className="min-h-[140px] max-h-[280px] overflow-y-auto rounded-md border border-input bg-muted/30 px-3 py-2">
          {description ? <TicketDescriptionViewer description={description} /> : <p className="text-sm text-muted-foreground">No description yet.</p>}
        </div>
      )}
    </div>
  )
}

export const TicketPriorityField = ({ priority, onChange }: { priority: number; onChange: (priority: number) => void }) => (
  <div>
    <TicketFieldLabel label="Priority" help="Ticket urgency and processing order" className="block mb-1" />
    <select value={priority} onChange={event => onChange(Number(event.target.value))} className="w-48 rounded-md border border-input bg-background px-3 py-2 text-sm">
      <option value={1}>1: Very High</option>
      <option value={2}>2: High</option>
      <option value={3}>3: Normal</option>
      <option value={4}>4: Low</option>
      <option value={5}>5: Very Low</option>
    </select>
  </div>
)

interface TicketWorkflowFieldsProps {
  project?: Project
  profile?: Profile | null
  locked: boolean
  questionsDisabled: boolean
  manualQaOverride: ManualQaOverride
  onManualQaChange: (value: ManualQaOverride) => void
  aiQuestionsOverride: AiQuestionsOverride
  onAiQuestionsChange: (value: AiQuestionsOverride) => void
  aiQuestionWindowOverride: AiQuestionWindowOverride
  onAiQuestionWindowChange: (value: AiQuestionWindowOverride) => void
  onValidationChange: (hasError: boolean) => void
}

const TicketManualQaField = ({ project, profile, locked, manualQaOverride, onManualQaChange }: Pick<TicketWorkflowFieldsProps, 'project' | 'profile' | 'locked' | 'manualQaOverride' | 'onManualQaChange'>) => {
  const effectiveManualQa = resolveManualQaSettingLabel(manualQaOverride, project?.manualQaOverride ?? null, profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled)
  return (
    <AdvancedSettingRow label="Manual QA checkpoint" description="Choose whether this ticket pauses for your QA checklist after final tests." help={<ConfigurationDocsLink docsPath="/configuration#manual-qa" label="ticket Manual QA checkpoint" description="Choose whether this ticket pauses for your verification after final tests. Open the Manual QA documentation." />}>
      <ManualQaSetting idPrefix="ticket-manual-qa" value={manualQaOverride} onChange={onManualQaChange} inheritedEnabled={effectiveManualQa.enabled} disabled={locked} compact />
    </AdvancedSettingRow>
  )
}

const getInheritedTicketQuestions = (project?: Project, profile?: Profile | null) => resolveAiQuestionsSettingLabel(null, project?.aiQuestionsOverride, profile?.aiQuestionsEnabled ?? PROFILE_DEFAULTS.aiQuestionsEnabled)

const getInheritedTicketWait = (project?: Project, profile?: Profile | null) => resolveAiQuestionWindowLabel(null, project?.aiQuestionWindowOverride, profile?.aiQuestionWindow ?? PROFILE_DEFAULTS.aiQuestionWindow)

const TicketQuestionsInheritance = ({ override, inherited }: { override: AiQuestionsOverride; inherited: ReturnType<typeof resolveAiQuestionsSettingLabel> }) => {
  if (override !== null) return null
  return <p className="mt-1 text-right text-xs text-muted-foreground">Inherits <span className="font-medium text-foreground">{inherited.enabled ? 'On' : 'Off'}</span> from {describeSettingSource(inherited.source)}.</p>
}

const TicketQuestionFields = ({ project, profile, questionsDisabled, aiQuestionsOverride, onAiQuestionsChange, aiQuestionWindowOverride, onAiQuestionWindowChange, onValidationChange }: Omit<TicketWorkflowFieldsProps, 'locked' | 'manualQaOverride' | 'onManualQaChange'>) => {
  const inheritedQuestions = getInheritedTicketQuestions(project, profile)
  const inheritedWait = getInheritedTicketWait(project, profile)
  const enabled = aiQuestionsOverride ?? inheritedQuestions.enabled
  return (
    <>
      <AdvancedSettingRow label="AI questions" description="Choose whether a model may pause a step to ask you a question." className="border-t border-border pt-3" help={<ConfigurationDocsLink docsPath="/configuration#ai-questions" label="ticket AI questions" description="Choose whether a model may pause a step to ask you a question in this ticket. Open the AI questions documentation." />}>
        <TriStateSetting idPrefix="ticket-ai-questions" groupLabel="AI questions setting" options={AI_QUESTIONS_INHERITABLE_OPTIONS} value={aiQuestionsOverride} onChange={onAiQuestionsChange} disabled={questionsDisabled} footer={<TicketQuestionsInheritance override={aiQuestionsOverride} inherited={inheritedQuestions} />} />
      </AdvancedSettingRow>
      <div className="pl-4">
        <InheritableDurationField label="AI question wait" idPrefix="ticket-ai-question-wait" value={aiQuestionWindowOverride} onChange={onAiQuestionWindowChange} onValidationChange={onValidationChange} inheritedMs={inheritedWait.windowMs} inheritedSourceLabel={describeSettingSource(inheritedWait.source)} disabled={questionsDisabled || !enabled} disabledReason={!enabled ? AI_QUESTION_WAIT_DISABLED_HINT : undefined} minMs={AI_QUESTION_WINDOW_MIN_MS} maxMs={AI_QUESTION_WINDOW_MAX_MS} formatValue={formatAiQuestionWindow} hint={AI_QUESTION_WAIT_HINT} help={<ConfigurationDocsLink docsPath="/configuration#ai-question-wait" label="ticket AI question wait" description={`${AI_QUESTION_WAIT_HELP} Open the AI question wait documentation.`} />} />
      </div>
    </>
  )
}

const TicketWorkflowFields = (props: TicketWorkflowFieldsProps) => (
  <>
    {props.locked && <p className="text-xs text-muted-foreground">Workflow settings are fixed once the ticket starts. Title, description, and priority remain editable.</p>}
    <TicketManualQaField {...props} />
    <TicketQuestionFields {...props} />
  </>
)

export const TicketAdvancedFields = ({ hasWaitError, ...props }: TicketWorkflowFieldsProps & { hasWaitError: boolean }) => {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <AdvancedSettings isOpen={isOpen} onToggle={() => setIsOpen(open => !open)} hasWaitError={hasWaitError}>
      <TicketWorkflowFields {...props} />
    </AdvancedSettings>
  )
}

interface TicketFormActionsProps {
  editing: boolean
  canSubmit: boolean
  starting: boolean
  saving: boolean
  onClose: () => void
  onCreateAndStart: () => void
}

const TicketStartButton = ({ canSubmit, starting, onCreateAndStart }: Pick<TicketFormActionsProps, 'canSubmit' | 'starting' | 'onCreateAndStart'>) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button type="button" variant="secondary" disabled={!canSubmit} onClick={onCreateAndStart} className="rounded-lg border border-border/70 bg-muted/60 text-foreground hover:bg-muted/90 active:scale-[0.98] font-mono text-xs font-semibold shadow-2xs transition-all">
        {starting ? <LoadingText text="Starting" /> : 'Create & Start'}
      </Button>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs text-center text-balance">Create ticket and immediately start the workflow</TooltipContent>
  </Tooltip>
)

const TicketSaveButton = ({ editing, canSubmit, saving }: Pick<TicketFormActionsProps, 'editing' | 'canSubmit' | 'saving'>) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button type="submit" disabled={!canSubmit} className="rounded-lg bg-foreground text-background font-mono text-xs font-semibold hover:opacity-90 active:scale-[0.98] shadow-xs transition-all">
        {saving ? <LoadingText text={editing ? 'Saving' : 'Creating'} /> : editing ? 'Save Ticket' : 'Create Ticket'}
      </Button>
    </TooltipTrigger>
    <TooltipContent className="max-w-xs text-center text-balance">{editing ? 'Save changes to this ticket' : 'Create ticket in selected project'}</TooltipContent>
  </Tooltip>
)

export const TicketFormActions = (props: TicketFormActionsProps) => (
  <div className="flex justify-end gap-2.5 pt-2">
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="outline" onClick={props.onClose} className="rounded-lg border-border/70 bg-muted/40 text-muted-foreground hover:bg-muted/70 hover:text-foreground active:scale-[0.98] font-mono text-xs font-medium transition-all">Cancel</Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-center text-balance">{props.editing ? 'Close ticket editor' : 'Close without creating ticket'}</TooltipContent>
    </Tooltip>
    {!props.editing && <TicketStartButton {...props} />}
    <TicketSaveButton {...props} />
  </div>
)
