import { HardDrive, Trash2 } from 'lucide-react'
import type { Profile } from '@/hooks/useProfile'
import type { ExistingStateAction, IgnoreMode, Project } from '@/hooks/useProjects'
import { Button } from '@/components/ui/button'
import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { GitHookPolicySetting } from '@/components/git-hooks/GitHookPolicySetting'
import { AdvancedSettings, AdvancedSettingRow } from '@/components/settings/AdvancedSettings'
import { InheritableDurationField } from '@/components/settings/InheritableDurationField'
import { TriStateSetting } from '@/components/settings/TriStateSetting'
import { AI_QUESTIONS_INHERITABLE_OPTIONS, AI_QUESTION_WAIT_HINT, AI_QUESTION_WAIT_HELP, AI_QUESTION_WAIT_DISABLED_HINT } from '@/components/settings/aiQuestionOptions'
import type { AiQuestionsOverride, AiQuestionWindowOverride } from '@/lib/aiQuestionSetting'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import { cn } from '@/lib/utils'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS, clampAiQuestionWindowMs, formatAiQuestionWindow } from '@shared/aiQuestions'
import { SHARED_PROFILE_DEFAULTS as PROFILE_DEFAULTS } from '@shared/profileDefaults'
import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'
import { ColorPickerSection, EmojiPickerSection } from './AppearancePickers'
import { IgnoreModeSetting } from './IgnoreModeSetting'
import { DeleteWorktreesDialog } from './DeleteWorktreesDialog'

interface ProjectIdentitySectionProps {
  name: string
  shortname: string
  onNameChange: (value: string) => void
  onShortnameChange: (value: string) => void
  duplicateNameProject?: Project
  duplicateShortnameProject?: Project
  shortnameLocked: boolean
  isSavedShortnameLocked: boolean
  isStartingFresh: boolean
}

const ProjectNameField = ({ name, onNameChange, duplicateNameProject }: Pick<ProjectIdentitySectionProps, 'name' | 'onNameChange' | 'duplicateNameProject'>) => (
  <div className="flex-1">
    <label htmlFor="project-name" className="text-sm font-medium block mb-1">Project Name</label>
    <input
      id="project-name"
      name="projectName"
      type="text"
      value={name}
      onChange={e => onNameChange(e.target.value)}
      className={cn(
        'w-full rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm font-medium text-foreground transition-all focus:border-brand-500/50 focus-visible:ring-2 focus-visible:ring-brand-500/30 outline-none',
        duplicateNameProject && 'border-destructive focus:border-destructive focus-visible:ring-destructive/30',
      )}
      aria-invalid={duplicateNameProject ? true : undefined}
      autoComplete="off"
      required
    />
    {duplicateNameProject && (
      <p role="alert" className="mt-1 text-xs text-destructive">
        A project named <span className="font-medium">{name.trim()}</span> is already added. Choose a different project name.
      </p>
    )}
  </div>
)

const ProjectShortnameInput = ({ shortname, onShortnameChange, duplicateShortnameProject, shortnameLocked }: Pick<ProjectIdentitySectionProps, 'shortname' | 'onShortnameChange' | 'duplicateShortnameProject' | 'shortnameLocked'>) => {
  if (shortnameLocked) {
    return <span className="inline-block px-3 py-2 text-sm font-mono text-muted-foreground uppercase">{shortname}</span>
  }
  return (
    <input
      id="project-shortname"
      name="projectShortname"
      type="text"
      value={shortname}
      onChange={e => onShortnameChange(e.target.value.toUpperCase().slice(0, 5))}
      className={cn(
        'w-full rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-sm font-mono font-medium text-foreground uppercase transition-all focus:border-brand-500/50 focus-visible:ring-2 focus-visible:ring-brand-500/30 outline-none',
        duplicateShortnameProject && 'border-destructive focus:border-destructive focus-visible:ring-destructive/30',
      )}
      aria-invalid={duplicateShortnameProject ? true : undefined}
      autoComplete="off"
      minLength={3}
      maxLength={5}
      required
    />
  )
}

const ProjectShortnameField = (props: Omit<ProjectIdentitySectionProps, 'name' | 'onNameChange' | 'duplicateNameProject'>) => (
  <div className="w-32">
    <label htmlFor="project-shortname" className="text-sm font-medium block mb-1">Short Name</label>
    <ProjectShortnameInput {...props} />
    {props.duplicateShortnameProject && (
      <p role="alert" className="mt-1 text-xs text-destructive">
        The short name <span className="font-mono font-medium">{props.shortname.trim().toUpperCase()}</span> is already used by <span className="font-medium">{props.duplicateShortnameProject.name}</span>. Choose a different short name.
      </p>
    )}
    {props.isSavedShortnameLocked && (
      <p className="mt-1 text-xs text-muted-foreground">Kept from the existing project identity.</p>
    )}
    {props.isStartingFresh && (
      <p className="mt-1 text-xs text-muted-foreground">Editable because fresh state will be created.</p>
    )}
  </div>
)

export const ProjectIdentitySection = (props: ProjectIdentitySectionProps) => (
  <div className="flex gap-3">
    <ProjectNameField name={props.name} onNameChange={props.onNameChange} duplicateNameProject={props.duplicateNameProject} />
    <ProjectShortnameField
      shortname={props.shortname}
      onShortnameChange={props.onShortnameChange}
      duplicateShortnameProject={props.duplicateShortnameProject}
      shortnameLocked={props.shortnameLocked}
      isSavedShortnameLocked={props.isSavedShortnameLocked}
      isStartingFresh={props.isStartingFresh}
    />
  </div>
)

interface ProjectAppearanceSectionProps {
  icon: string
  color: string
  isIconPickerOpen: boolean
  isColorPickerOpen: boolean
  onIconOpenChange: (value: boolean) => void
  onColorOpenChange: (value: boolean) => void
  onIconChange: (value: string) => void
  onColorChange: (value: string) => void
}

export const ProjectAppearanceSection = (props: ProjectAppearanceSectionProps) => (
  <div>
    <label className="text-sm font-medium block mb-2">Appearance</label>
    <div className="flex items-center gap-4">
      <EmojiPickerSection icon={props.icon} isIconPickerOpen={props.isIconPickerOpen} onIconOpenChange={props.onIconOpenChange} onIconChange={props.onIconChange} />
      <ColorPickerSection color={props.color} isColorPickerOpen={props.isColorPickerOpen} onColorOpenChange={props.onColorOpenChange} onColorChange={props.onColorChange} />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Preview</span>
        <ProjectAppearancePreview icon={props.icon} color={props.color} />
      </div>
    </div>
  </div>
)

const ProjectAppearancePreview = ({ icon, color }: Pick<ProjectAppearanceSectionProps, 'icon' | 'color'>) => (
  <div className="flex h-10 w-10 items-center justify-center rounded-xl text-xl shadow" style={{ backgroundColor: color + '22', border: `2px solid ${color}` }}>
    {icon?.startsWith('data:') ? <img src={icon} className="h-5 w-5 rounded" alt="icon" /> : icon}
  </div>
)

interface ProjectAdvancedSectionProps {
  profile?: Profile | null
  profileLoading: boolean
  isOpen: boolean
  onToggle: () => void
  hasWaitError: boolean
  onWaitValidationChange: (value: boolean) => void
  manualQaOverride: ManualQaOverride
  onManualQaChange: (value: ManualQaOverride) => void
  aiQuestionsOverride: AiQuestionsOverride
  onAiQuestionsChange: (value: AiQuestionsOverride) => void
  aiQuestionWindowOverride: AiQuestionWindowOverride
  onAiQuestionWindowChange: (value: AiQuestionWindowOverride) => void
  gitHookPolicy: GitHookPolicy
  onGitHookPolicyChange: (value: GitHookPolicy) => void
  ignoreMode: IgnoreMode
  onIgnoreModeChange: (value: IgnoreMode) => void
  showIgnoreMode: boolean
  isEditing: boolean
  isBusy: boolean
}

const ProjectManualQaRow = ({ profile, manualQaOverride, onManualQaChange }: Pick<ProjectAdvancedSectionProps, 'profile' | 'manualQaOverride' | 'onManualQaChange'>) => (
  <AdvancedSettingRow
    label="Manual QA checkpoint"
    help={<ConfigurationDocsLink docsPath="/configuration#manual-qa" label="project Manual QA checkpoint" description="Choose whether tickets in this project pause for your verification. Open the Manual QA documentation." />}
    description="Choose whether newly started tickets pause for your QA checklist after final tests."
  >
    <ManualQaSetting idPrefix="project-manual-qa" value={manualQaOverride} onChange={value => onManualQaChange(value ?? false)} inheritedEnabled={profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled} compact />
  </AdvancedSettingRow>
)

interface ProjectAiQuestionsRowProps {
  inheritedEnabled: boolean
  profileLoading: boolean
  value: AiQuestionsOverride
  onChange: (value: AiQuestionsOverride) => void
}

const ProjectAiQuestionsRow = ({ inheritedEnabled, profileLoading, value, onChange }: ProjectAiQuestionsRowProps) => (
  <AdvancedSettingRow
    label="AI questions"
    className="border-t border-border pt-3"
    help={<ConfigurationDocsLink docsPath="/configuration#ai-questions" label="project AI questions" description="Choose whether a model may pause a step to ask you a question in this project. Open the AI questions documentation." />}
    description="Choose whether a model may pause a step to ask you a question. Tickets can override this."
  >
    <TriStateSetting
      idPrefix="project-ai-questions"
      groupLabel="AI questions setting"
      options={AI_QUESTIONS_INHERITABLE_OPTIONS}
      value={value}
      onChange={onChange}
      disabled={profileLoading}
      footer={value === null && <p className="mt-1 text-right text-xs text-muted-foreground">Inherits <span className="font-medium text-foreground">{inheritedEnabled ? 'On' : 'Off'}</span> from Configuration.</p>}
    />
  </AdvancedSettingRow>
)

const ProjectAiQuestionWaitRow = ({ profile, profileLoading, enabled, aiQuestionWindowOverride, onAiQuestionWindowChange, onWaitValidationChange }: Pick<ProjectAdvancedSectionProps, 'profile' | 'profileLoading' | 'aiQuestionWindowOverride' | 'onAiQuestionWindowChange' | 'onWaitValidationChange'> & { enabled: boolean }) => (
  <div className="pl-4">
    <InheritableDurationField
      label="AI question wait"
      idPrefix="project-ai-question-wait"
      value={aiQuestionWindowOverride}
      onChange={onAiQuestionWindowChange}
      onValidationChange={onWaitValidationChange}
      disabled={profileLoading || !enabled}
      disabledReason={!enabled ? AI_QUESTION_WAIT_DISABLED_HINT : undefined}
      inheritedMs={clampAiQuestionWindowMs(profile?.aiQuestionWindow)}
      inheritedSourceLabel="Configuration"
      minMs={AI_QUESTION_WINDOW_MIN_MS}
      maxMs={AI_QUESTION_WINDOW_MAX_MS}
      formatValue={formatAiQuestionWindow}
      hint={AI_QUESTION_WAIT_HINT}
      help={<ConfigurationDocsLink docsPath="/configuration#ai-question-wait" label="project AI question wait" description={`${AI_QUESTION_WAIT_HELP} Open the AI question wait documentation.`} />}
    />
  </div>
)

const ProjectGitHookRow = ({ profile, gitHookPolicy, onGitHookPolicyChange }: Pick<ProjectAdvancedSectionProps, 'profile' | 'gitHookPolicy' | 'onGitHookPolicyChange'>) => (
  <AdvancedSettingRow
    label="Git hook policy"
    className="border-t border-border pt-3"
    help={<ConfigurationDocsLink docsPath="/configuration#git-hook-policy" label="project Git hook policy" description="Choose the default hook behavior for tickets in this project. Open the Git hook policy documentation." />}
    description="Choose how LoopTroop handles repository hooks."
  >
    <GitHookPolicySetting value={gitHookPolicy} onChange={onGitHookPolicyChange} inheritedPolicy={profile?.gitHookPolicy ?? DEFAULT_GIT_HOOK_POLICY} compact />
  </AdvancedSettingRow>
)

const ProjectIgnoreModeRow = ({ ignoreMode, onIgnoreModeChange, isEditing, isBusy }: Pick<ProjectAdvancedSectionProps, 'ignoreMode' | 'onIgnoreModeChange' | 'isEditing' | 'isBusy'>) => (
  <div className="border-t border-border pt-3">
    <IgnoreModeSetting idPrefix="project" value={ignoreMode} onChange={onIgnoreModeChange} disabled={isBusy || isEditing} />
    {isEditing && <p className="mt-2 text-xs text-muted-foreground">Saved when this project was attached. Existing ignore rules are not removed automatically.</p>}
  </div>
)

export const ProjectAdvancedSection = (props: ProjectAdvancedSectionProps) => {
  const inheritedEnabled = props.profile?.aiQuestionsEnabled ?? PROFILE_DEFAULTS.aiQuestionsEnabled
  const enabled = props.aiQuestionsOverride ?? inheritedEnabled
  return (
    <AdvancedSettings isOpen={props.isOpen} onToggle={props.onToggle} hasWaitError={props.hasWaitError}>
      <ProjectManualQaRow profile={props.profile} manualQaOverride={props.manualQaOverride} onManualQaChange={props.onManualQaChange} />
      <ProjectAiQuestionsRow inheritedEnabled={inheritedEnabled} profileLoading={props.profileLoading} value={props.aiQuestionsOverride} onChange={props.onAiQuestionsChange} />
      <ProjectAiQuestionWaitRow profile={props.profile} profileLoading={props.profileLoading} enabled={enabled} aiQuestionWindowOverride={props.aiQuestionWindowOverride} onAiQuestionWindowChange={props.onAiQuestionWindowChange} onWaitValidationChange={props.onWaitValidationChange} />
      <ProjectGitHookRow profile={props.profile} gitHookPolicy={props.gitHookPolicy} onGitHookPolicyChange={props.onGitHookPolicyChange} />
      {props.showIgnoreMode && <ProjectIgnoreModeRow ignoreMode={props.ignoreMode} onIgnoreModeChange={props.onIgnoreModeChange} isEditing={props.isEditing} isBusy={props.isBusy} />}
    </AdvancedSettings>
  )
}

const RESTORE_SUBMIT_LABELS: Record<ExistingStateAction, string> = {
  restore: 'Restore Project',
  clear_tickets: 'Clear Tickets & Attach',
  start_fresh: 'Start Fresh',
}

interface ProjectFormActionsProps {
  isEditing: boolean
  isBusy: boolean
  hasWaitError: boolean
  isCreationBlocked: boolean
  restoreMode: boolean
  existingStateAction: ExistingStateAction
  onDelete: () => void
  onWorktreesOpen: () => void
  onCancel: () => void
}

const projectSubmitLabel = (isEditing: boolean, restoreMode: boolean, action: ExistingStateAction) => (
  isEditing ? 'Save Changes' : restoreMode ? RESTORE_SUBMIT_LABELS[action] : 'Create Project'
)

const ProjectSubmitButton = (props: Pick<ProjectFormActionsProps, 'isEditing' | 'isBusy' | 'hasWaitError' | 'isCreationBlocked' | 'restoreMode' | 'existingStateAction'>) => (
  <Button type="submit" disabled={props.isBusy || props.hasWaitError || (!props.isEditing && props.isCreationBlocked)} className="rounded-lg bg-foreground text-background font-semibold hover:opacity-95 active:scale-[0.98] shadow-2xs">
    {projectSubmitLabel(props.isEditing, props.restoreMode, props.existingStateAction)}
  </Button>
)

export const ProjectFormActions = (props: ProjectFormActionsProps) => (
  <div className="flex justify-between gap-2.5 pt-2">
    {props.isEditing && (
      <div className="flex gap-2">
        <Button type="button" variant="destructive" onClick={props.onDelete} disabled={props.isBusy} className="rounded-lg shadow-2xs"><Trash2 className="h-4 w-4 mr-1.5" />Delete Project</Button>
        <Button type="button" variant="outline" onClick={props.onWorktreesOpen} disabled={props.isBusy} className="rounded-lg border border-border/70 shadow-2xs"><HardDrive className="h-4 w-4 mr-1.5" />Free Disk Space…</Button>
      </div>
    )}
    <div className="flex gap-2.5 ml-auto">
      <Button type="button" variant="outline" onClick={props.onCancel} className="rounded-lg">Cancel</Button>
      <ProjectSubmitButton isEditing={props.isEditing} isBusy={props.isBusy} hasWaitError={props.hasWaitError} isCreationBlocked={props.isCreationBlocked} restoreMode={props.restoreMode} existingStateAction={props.existingStateAction} />
    </div>
  </div>
)

export const ProjectMaintenanceDialog = ({ project, open, onClose }: { project: Project | null | undefined; open: boolean; onClose: () => void }) => {
  if (!project) return null
  return <DeleteWorktreesDialog open={open} onClose={onClose} projectId={project.id} projectName={project.name} />
}
