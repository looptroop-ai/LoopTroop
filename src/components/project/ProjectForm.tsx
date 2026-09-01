import { useState, useRef, useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useCreateProject, useUpdateProject, useDeleteProject, useProjects } from '@/hooks/useProjects'
import type { ExistingProjectPreview, ExistingStateAction, IgnoreMode, Project } from '@/hooks/useProjects'
import { useToast } from '@/components/shared/useToast'
import { ArrowLeft, HardDrive, Trash2, CheckCircle2, XCircle, CircleDot, AlertTriangle, ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FolderPicker } from '@/components/project/FolderPicker'
import { EmojiPickerSection, ColorPickerSection } from './AppearancePickers'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { DeleteWorktreesDialog } from './DeleteWorktreesDialog'
import { SHARED_PROFILE_DEFAULTS as PROFILE_DEFAULTS } from '@shared/profileDefaults'
import { PROJECT_GIT_CHECK_DEBOUNCE_MS, SECONDS_PER_HOUR, SECONDS_PER_DAY } from '@/lib/constants'
import { ManualQaSetting } from '@/components/manual-qa/ManualQaSetting'
import { ConfigurationDocsLink } from '@/components/config/ConfigurationDocsLink'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import { TriStateSetting } from '@/components/settings/TriStateSetting'
import { InheritableDurationField } from '@/components/settings/InheritableDurationField'
import { AI_QUESTIONS_INHERITABLE_OPTIONS, AI_QUESTION_WAIT_HINT } from '@/components/settings/aiQuestionOptions'
import type { AiQuestionsOverride, AiQuestionWindowOverride } from '@/lib/aiQuestionSetting'
import { AI_QUESTION_WINDOW_MAX_MS, AI_QUESTION_WINDOW_MIN_MS, formatAiQuestionWindow } from '@shared/aiQuestions'
import { useProfile } from '@/hooks/useProfile'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import { ExistingProjectActionDialog } from './ExistingProjectActionDialog'
import { GitHookPolicySetting } from '@/components/git-hooks/GitHookPolicySetting'
import { normalizeGitHookPolicySetting } from '@/lib/gitHookPolicySetting'
import { IgnoreModeSetting } from './IgnoreModeSetting'
import { DEFAULT_IGNORE_MODE, normalizeIgnoreMode } from '@shared/ignoreMode'
import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'

interface ProjectFormProps {
  onClose: () => void
  onBack?: () => void
  project?: Project
}

interface GitCheckResponse {
  isGit: boolean
  status: 'none' | 'checking' | 'valid' | 'invalid'
  message?: string
  performanceWarning?: string | null
  githubOriginWriteAccess?: 'writable' | 'read_only' | 'unknown'
  githubViewerPermission?: string | null
  githubWriteWarning?: string | null
  scope?: 'root' | 'subfolder'
  repoRoot?: string
  hasLoopTroopState?: boolean
  existingProject?: ExistingProjectPreview | null
  alreadyAttached?: boolean
  attachedProject?: {
    id: number
    name: string
    shortname: string
    folderPath: string
  } | null
}

function formatRelativeTime(dateStr: string) {
  const date = new Date(dateStr)
  const diffInSeconds = Math.floor((Date.now() - date.getTime()) / 1000)
  
  if (diffInSeconds < 60) return 'Just now'
  if (diffInSeconds < SECONDS_PER_HOUR) return `${Math.floor(diffInSeconds / 60)} minutes ago`
  if (diffInSeconds < SECONDS_PER_DAY) return `${Math.floor(diffInSeconds / SECONDS_PER_HOUR)} hours ago`
  const days = Math.floor(diffInSeconds / SECONDS_PER_DAY)
  if (days === 1) return 'Yesterday'
  if (days < 30) return `${days} days ago`
  if (days < 365) return `${Math.floor(days / 30)} months ago`
  return `${Math.floor(days / 365)} years ago`
}

export function ProjectForm({ onClose, onBack, project }: ProjectFormProps) {
  const createProject = useCreateProject()
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()
  const { addToast } = useToast()
  const { data: profile } = useProfile()
  const { data: projects = [] } = useProjects()
  const isEditing = !!project
  const [name, setName] = useState(project?.name ?? '')
  const [shortname, setShortname] = useState(project?.shortname ?? '')
  const [folder, setFolder] = useState(project?.folderPath ?? '')
  const [icon, setIcon] = useState(project?.icon ?? '📦')
  const [color, setColor] = useState(project?.color ?? '#3b82f6')
  const [manualQaOverride, setManualQaOverride] = useState<ManualQaOverride>(
    project?.manualQaOverride ?? profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled,
  )
  // Both AI question settings inherit by default, and cascade independently.
  const [aiQuestionsOverride, setAiQuestionsOverride] = useState<AiQuestionsOverride>(
    project?.aiQuestionsOverride ?? null,
  )
  const [aiQuestionWindowOverride, setAiQuestionWindowOverride] = useState<AiQuestionWindowOverride>(
    project?.aiQuestionWindowOverride ?? null,
  )
  const [gitHookPolicy, setGitHookPolicy] = useState<GitHookPolicy>(
    normalizeGitHookPolicySetting(project?.gitHookPolicy)
      ?? normalizeGitHookPolicySetting(profile?.gitHookPolicy)
      ?? DEFAULT_GIT_HOOK_POLICY,
  )
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false)
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false)
  const [gitInfo, setGitInfo] = useState<GitCheckResponse>({ isGit: false, status: 'none' })
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [isWorktreesDialogOpen, setIsWorktreesDialogOpen] = useState(false)
  const [existingStateAction, setExistingStateAction] = useState<ExistingStateAction>('restore')
  const [ignoreMode, setIgnoreMode] = useState<IgnoreMode>(
    normalizeIgnoreMode(project?.ignoreMode) ?? normalizeIgnoreMode(profile?.ignoreMode) ?? DEFAULT_IGNORE_MODE,
  )
  const [isExistingStateConfirmOpen, setIsExistingStateConfirmOpen] = useState(false)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const restorePrefillKeyRef = useRef<string | null>(null)
  const profileDefaultsAppliedRef = useRef(isEditing || !!profile)
  const closeView = onBack ?? onClose
  const restoreMode = !isEditing
    && !gitInfo.alreadyAttached
    && gitInfo.hasLoopTroopState === true
    && !!gitInfo.existingProject
  const isSavedShortnameLocked = restoreMode && existingStateAction !== 'start_fresh'
  const gitStatus = gitInfo.status
  const gitMessage = gitInfo.message ?? ''
  const projectStatePath = `${folder.replace(/[\\/]+$/, '')}/.looptroop`
  const duplicateNameProject = !isEditing && name.trim()
    ? projects.find((existingProject) => existingProject.name.trim().toLowerCase() === name.trim().toLowerCase())
    : undefined
  const duplicateShortnameProject = !isEditing && shortname.trim()
    ? projects.find((existingProject) => existingProject.shortname.trim().toUpperCase() === shortname.trim().toUpperCase())
    : undefined
  const hasProjectIdentityConflict = !!duplicateNameProject || !!duplicateShortnameProject

  useEffect(() => {
    if (!folder.trim()) {
      setGitInfo({ isGit: false, status: 'none' })
      restorePrefillKeyRef.current = null
      return
    }
    let cancelled = false
    setGitInfo({
      isGit: false,
      status: 'checking',
      message: 'Checking repository...',
    })
    const timer = setTimeout(() => {
      fetch(`/api/projects/check-git?path=${encodeURIComponent(folder)}`)
        .then(r => r.json())
        .then((data: GitCheckResponse) => {
          if (cancelled) return
          if (
            !isEditing
            && !data.alreadyAttached
            && data.hasLoopTroopState === true
            && data.existingProject
            && data.repoRoot
            && restorePrefillKeyRef.current !== data.repoRoot
          ) {
            profileDefaultsAppliedRef.current = true
            setName(data.existingProject.name)
            setShortname(data.existingProject.shortname)
            setIcon(data.existingProject.icon ?? '📁')
            setColor(data.existingProject.color ?? '#3b82f6')
            if (data.existingProject.manualQaOverride !== undefined) {
              setManualQaOverride(data.existingProject.manualQaOverride ?? profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled)
            }
            if (data.existingProject.aiQuestionsOverride !== undefined) {
              setAiQuestionsOverride(data.existingProject.aiQuestionsOverride)
            }
            if (data.existingProject.aiQuestionWindowOverride !== undefined) {
              setAiQuestionWindowOverride(data.existingProject.aiQuestionWindowOverride)
            }
            if (data.existingProject.gitHookPolicy !== undefined) {
              setGitHookPolicy(
                normalizeGitHookPolicySetting(data.existingProject.gitHookPolicy)
                  ?? normalizeGitHookPolicySetting(profile?.gitHookPolicy)
                  ?? DEFAULT_GIT_HOOK_POLICY,
              )
            }
            if (data.existingProject.ignoreMode !== undefined) {
              setIgnoreMode(normalizeIgnoreMode(data.existingProject.ignoreMode) ?? DEFAULT_IGNORE_MODE)
            }
            setExistingStateAction('restore')
            setIsExistingStateConfirmOpen(false)
            restorePrefillKeyRef.current = data.repoRoot
          }
          setGitInfo(data)
        })
        .catch(() => {
          if (cancelled) return
          setGitInfo({
            isGit: false,
            status: 'invalid',
            message: 'Git check failed. Verify the absolute folder path and try again.',
          })
        })
    }, PROJECT_GIT_CHECK_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [folder, isEditing, profile?.gitHookPolicy, profile?.manualQaEnabled])

  useEffect(() => {
    if (profileDefaultsAppliedRef.current || isEditing || !profile || restorePrefillKeyRef.current) return
    profileDefaultsAppliedRef.current = true
    setManualQaOverride(profile.manualQaEnabled)
    setGitHookPolicy(profile.gitHookPolicy)
    setIgnoreMode(profile.ignoreMode ?? DEFAULT_IGNORE_MODE)
  }, [isEditing, profile])

  const handleBrowseFolder = () => {
    setIsFolderPickerOpen(true)
  }

  const handleFolderSelected = (path: string) => {
    setFolder(path)
    setIsFolderPickerOpen(false)
  }

  const createProjectWithSelectedAction = () => {
    createProject.mutate(
      {
        name,
        shortname,
        folderPath: folder,
        icon,
        color,
        gitHookPolicy,
        ignoreMode,
        manualQaOverride: manualQaOverride ?? profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled,
        aiQuestionsOverride,
        aiQuestionWindowOverride,
        ...(restoreMode ? { existingStateAction } : {}),
      },
      {
        onSuccess: () => {
          const successMessage = !restoreMode
            ? 'Project created.'
            : existingStateAction === 'clear_tickets'
              ? 'Project attached with its settings and a clean ticket list.'
              : existingStateAction === 'start_fresh'
                ? 'Fresh project created after removing existing LoopTroop state.'
                : 'Project restored from existing LoopTroop data.'
          addToast('success', successMessage)
          closeView()
        },
      },
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isEditing) {
      updateProject.mutate(
        {
          id: project.id,
          name,
          icon,
          color,
          gitHookPolicy,
          manualQaOverride: manualQaOverride ?? profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled,
          aiQuestionsOverride,
          aiQuestionWindowOverride,
        },
        {
          onSuccess: () => {
            addToast('success', 'Project updated.')
            closeView()
          },
        },
      )
      return
    }

    if (gitInfo.alreadyAttached || hasProjectIdentityConflict) return

    if (restoreMode && existingStateAction !== 'restore') {
      setIsExistingStateConfirmOpen(true)
      return
    }
    createProjectWithSelectedAction()
  }

  const handleExistingStateActionChange = (action: ExistingStateAction) => {
    setExistingStateAction(action)
    if (action !== 'start_fresh' && gitInfo.existingProject) {
      setShortname(gitInfo.existingProject.shortname)
    }
  }

  const handleDelete = () => {
    if (!project) return
    if (!confirm('Are you sure you want to delete this project? This will remove its local .looptroop state from the repo and cannot be undone.')) return
    deleteProject.mutate(project.id, {
      onSuccess: () => {
        addToast('success', 'Project deleted and local LoopTroop state removed.')
        closeView()
      },
      onError: (err) => {
        const message = (err as Error)?.message || 'Failed to delete project'
        addToast('error', message, 5000)
      },
    })
  }

  // Show error in toast when mutation fails
  useEffect(() => {
    const err = createProject.error || updateProject.error
    if (err) {
      const message = (err as Error)?.message || 'Failed to save project'
      addToast('error', message, 5000)
    }
  }, [createProject.error, updateProject.error, addToast])

  const isBusy = createProject.isPending || updateProject.isPending || deleteProject.isPending

  return (
    <>
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
      {onBack && (
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to list
        </Button>
      )}
      <Card className="rounded-xl border border-border/70 bg-card shadow-2xs">
        <CardHeader><CardTitle className="text-sm font-semibold text-foreground">Project Details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <label htmlFor="project-name" className="text-sm font-medium block mb-1">Project Name</label>
              <input
                id="project-name"
                name="projectName"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
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
            <div className="w-32">
              <label htmlFor="project-shortname" className="text-sm font-medium block mb-1">Short Name</label>
              {isEditing || isSavedShortnameLocked ? (
                <span className="inline-block px-3 py-2 text-sm font-mono text-muted-foreground uppercase">{shortname}</span>
              ) : (
                <input
                  id="project-shortname"
                  name="projectShortname"
                  type="text"
                  value={shortname}
                  onChange={e => setShortname(e.target.value.toUpperCase().slice(0, 5))}
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
              )}
              {duplicateShortnameProject && (
                <p role="alert" className="mt-1 text-xs text-destructive">
                  The short name <span className="font-mono font-medium">{shortname.trim().toUpperCase()}</span> is already used by <span className="font-medium">{duplicateShortnameProject.name}</span>. Choose a different short name.
                </p>
              )}
              {isSavedShortnameLocked && (
                <p className="mt-1 text-xs text-muted-foreground">Kept from the existing project identity.</p>
              )}
              {restoreMode && existingStateAction === 'start_fresh' && (
                <p className="mt-1 text-xs text-muted-foreground">Editable because fresh state will be created.</p>
              )}
            </div>
          </div>
          <div>
            <label className="text-sm font-medium block mb-2">Appearance</label>
            <div className="flex items-center gap-4">
              <EmojiPickerSection
                icon={icon}
                isIconPickerOpen={isIconPickerOpen}
                onIconOpenChange={setIsIconPickerOpen}
                onIconChange={setIcon}
              />

              <ColorPickerSection
                color={color}
                isColorPickerOpen={isColorPickerOpen}
                onColorOpenChange={setIsColorPickerOpen}
                onColorChange={setColor}
              />

              {/* Preview */}
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Preview</span>
                <div
                  className="flex h-10 w-10 items-center justify-center rounded-xl text-xl shadow"
                  style={{ backgroundColor: color + '22', border: `2px solid ${color}` }}
                >
                  {icon?.startsWith('data:') ? <img src={icon} className="h-5 w-5 rounded" alt="icon" /> : icon}
                </div>
              </div>
            </div>
          </div>
          <div className="rounded-md border-2 border-border">
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
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <label className="text-sm font-medium">Manual QA checkpoint</label>
                      <ConfigurationDocsLink
                        docsPath="/configuration#manual-qa"
                        label="project Manual QA checkpoint"
                        description="Choose whether tickets in this project pause for your verification. Open the Manual QA documentation."
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Choose whether newly started tickets pause for your QA checklist after final tests.
                    </p>
                  </div>
                  <ManualQaSetting
                    idPrefix="project-manual-qa"
                    value={manualQaOverride}
                    onChange={(value) => setManualQaOverride(value ?? false)}
                    inheritedEnabled={profile?.manualQaEnabled ?? PROFILE_DEFAULTS.manualQaEnabled}
                    compact
                  />
                </div>
                <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <label className="text-sm font-medium">AI questions</label>
                      <ConfigurationDocsLink
                        docsPath="/configuration#ai-questions"
                        label="project AI questions"
                        description="Choose whether a model may stop a step to ask you a question in this project. Open the AI questions documentation."
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Choose whether a model may stop a step to ask you a question. Tickets can set their own answer.
                    </p>
                  </div>
                  <TriStateSetting
                    idPrefix="project-ai-questions"
                    groupLabel="AI questions setting"
                    options={AI_QUESTIONS_INHERITABLE_OPTIONS}
                    value={aiQuestionsOverride}
                    onChange={setAiQuestionsOverride}
                    compact
                  />
                </div>
                <div className="border-t border-border pt-3">
                  <InheritableDurationField
                    label="AI question wait"
                    idPrefix="project-ai-question-wait"
                    value={aiQuestionWindowOverride}
                    onChange={setAiQuestionWindowOverride}
                    inheritedMs={profile?.aiQuestionWindow ?? PROFILE_DEFAULTS.aiQuestionWindow}
                    inheritedSourceLabel="Configuration"
                    minMs={AI_QUESTION_WINDOW_MIN_MS}
                    maxMs={AI_QUESTION_WINDOW_MAX_MS}
                    formatValue={formatAiQuestionWindow}
                    hint={`How long a question waits before the run carries on. ${AI_QUESTION_WAIT_HINT}`}
                  />
                </div>
                <div className="flex flex-wrap items-start justify-between gap-3 border-t border-border pt-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <label className="text-sm font-medium">Git hook policy</label>
                      <ConfigurationDocsLink
                        docsPath="/configuration#git-hook-policy"
                        label="project Git hook policy"
                        description="Choose the default hook behavior for tickets in this project. Open the Git hook policy documentation."
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Choose how LoopTroop handles repository hooks.
                    </p>
                  </div>
                  <GitHookPolicySetting
                    value={gitHookPolicy}
                    onChange={setGitHookPolicy}
                    inheritedPolicy={profile?.gitHookPolicy ?? DEFAULT_GIT_HOOK_POLICY}
                    compact
                  />
                </div>
                {(isEditing || (gitStatus === 'valid' && !gitInfo.alreadyAttached)) && (
                  <div className="border-t border-border pt-3">
                    <IgnoreModeSetting
                      idPrefix="project"
                      value={ignoreMode}
                      onChange={setIgnoreMode}
                      disabled={isBusy || isEditing}
                    />
                    {isEditing && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Saved when this project was attached. Existing ignore rules are not removed automatically.
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {isEditing ? (
            <div className="space-y-4">
              <div>
                <label className="text-sm font-medium block mb-1">Project Folder</label>
                <span className="text-sm text-muted-foreground font-mono">{folder}</span>
              </div>
              <div>
                <div className="mb-1 flex items-center gap-1.5">
                  <label className="text-sm font-medium">State Folder</label>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="State folder info"
                        className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] font-semibold text-muted-foreground transition-colors hover:text-foreground"
                      >
                        ?
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      LoopTroop keeps this project&apos;s local runtime state here.
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-sm text-muted-foreground font-mono">{projectStatePath}</span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-border pt-4">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1 block">Project Created</label>
                  <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span 
                                                          className="text-sm font-medium cursor-help"
                                                        >
                                                          {formatRelativeTime(project.createdAt)}
                                                        </span>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-xs text-center text-balance">{new Date(project.createdAt).toLocaleString()}</TooltipContent>
                                      </Tooltip>
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1 block">Last Update</label>
                  <Tooltip>
                                        <TooltipTrigger asChild>
                                          <span 
                                                          className="text-sm font-medium cursor-help"
                                                        >
                                                          {formatRelativeTime(project.updatedAt)}
                                                          {project.latestActivityTicketExternalId && (
                                                            <span className="ml-1 text-muted-foreground font-normal">
                                                              ({project.latestActivityTicketExternalId})
                                                            </span>
                                                          )}
                                                        </span>
                                        </TooltipTrigger>
                                        <TooltipContent className="max-w-xs text-center text-balance">{`${new Date(project.updatedAt).toLocaleString()}${project.latestActivityTicketExternalId ? ` - Ticket ${project.latestActivityTicketExternalId}` : ''}`}</TooltipContent>
                                      </Tooltip>
                </div>
              </div>
            </div>
          ) : (
            <div>
              <label htmlFor="project-folder" className="text-sm font-medium block mb-1">Project Folder <span className="text-muted-foreground font-normal">(must be git-initialized{' '}
                {gitStatus === 'none' && <CircleDot className="inline h-4 w-4 text-orange-500 align-text-bottom" />}
                {gitStatus === 'checking' && <CircleDot className="inline h-4 w-4 text-orange-500 animate-pulse align-text-bottom" />}
                {gitStatus === 'valid' && <CheckCircle2 className="inline h-4 w-4 text-green-500 align-text-bottom" />}
                {gitStatus === 'invalid' && <XCircle className="inline h-4 w-4 text-red-500 align-text-bottom" />}
                )</span></label>
              <div className="space-y-2">
                <div className="flex gap-2">
                  <input
                    id="project-folder"
                    name="projectFolder"
                    type="text"
                    value={folder}
                    onChange={e => setFolder(e.target.value)}
                    className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm font-mono"
                    placeholder="Choose a folder or type a path"
                    autoComplete="off"
                    required
                  />
                  <Button type="button" variant="outline" onClick={handleBrowseFolder}>
                    Browse...
                  </Button>
                </div>
                {gitMessage && !restoreMode && (
                  <p className={cn(
                    'text-xs',
                    gitStatus === 'valid' ? 'text-green-600 dark:text-green-400' : gitStatus === 'invalid' ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground',
                  )}>
                    {gitMessage}
                  </p>
                )}
              </div>
              {gitInfo.alreadyAttached && (
                <div role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    <div>
                      <p className="font-medium text-destructive">Project already added</p>
                      <p className="mt-1 text-xs text-destructive/90">
                        This directory is already attached
                        {gitInfo.attachedProject ? ` as ${gitInfo.attachedProject.name} (${gitInfo.attachedProject.shortname})` : ''}.
                        Choose a different repository or open the existing project from the project list.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {gitInfo.performanceWarning && (
                <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/20">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div>
                      <p className="font-medium text-amber-900 dark:text-amber-100">WSL mounted-drive warning</p>
                      <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">
                        {gitInfo.performanceWarning}
                      </p>
                    </div>
                  </div>
                </div>
              )}
              {gitInfo.githubWriteWarning && (
                <div className="rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/20">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    <div>
                      <p className="font-medium text-amber-900 dark:text-amber-100">GitHub write access not detected</p>
                      <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">
                        {gitInfo.githubWriteWarning}
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
          {restoreMode && gitInfo.existingProject && (
            <div className="space-y-4 rounded-lg border border-amber-300/70 bg-amber-50/70 p-4 text-sm dark:border-amber-700/60 dark:bg-amber-950/20">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <div className="min-w-0">
                  <p className="font-medium text-amber-900 dark:text-amber-100">Existing LoopTroop project detected</p>
                  <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">
                    Choose which saved project data to keep when attaching this repository.
                  </p>
                  {gitInfo.scope === 'subfolder' && gitInfo.repoRoot && (
                    <p className="mt-1 text-xs text-amber-800/90 dark:text-amber-200/80">
                      Repository root: <span className="font-mono">{gitInfo.repoRoot}</span>
                    </p>
                  )}
                </div>
              </div>

              <fieldset className="grid gap-2" disabled={isBusy}>
                <legend className="sr-only">Existing project action</legend>
                {([
                  {
                    value: 'restore',
                    title: 'Restore everything',
                    description: `Keep all ${gitInfo.existingProject.ticketCount} tickets, workflow data, settings, and the current counter.`,
                  },
                  {
                    value: 'clear_tickets',
                    title: 'Keep project settings, clear tickets',
                    description: 'Keep project identity and overrides, but permanently remove every ticket and its content.',
                  },
                  {
                    value: 'start_fresh',
                    title: 'Start fresh',
                    description: 'Delete the entire .looptroop state folder and create a new project from this form.',
                  },
                ] as const).map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex cursor-pointer gap-3 rounded-md border bg-background/70 p-3 transition-colors',
                      existingStateAction === option.value
                        ? 'border-primary ring-1 ring-primary'
                        : 'border-border hover:border-muted-foreground/50',
                    )}
                  >
                    <input
                      type="radio"
                      name="existing-state-action"
                      value={option.value}
                      checked={existingStateAction === option.value}
                      onChange={() => handleExistingStateActionChange(option.value)}
                      className="mt-0.5 h-4 w-4 accent-primary"
                    />
                    <span>
                      <span className="block font-medium text-foreground">{option.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{option.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>

              {existingStateAction !== 'restore' && (gitInfo.existingProject.activeTicketCount ?? 0) > 0 && (
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs font-medium text-destructive">
                  Warning: {gitInfo.existingProject.activeTicketCount}{' '}
                  {gitInfo.existingProject.activeTicketCount === 1 ? 'ticket is' : 'tickets are'} currently active and will be deleted.
                </p>
              )}

              <div className="grid gap-3 rounded-md border border-amber-300/60 bg-background/50 p-3 sm:grid-cols-2 dark:border-amber-700/50">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-green-700 dark:text-green-300">
                    {existingStateAction === 'start_fresh' ? 'Created from current form' : 'Kept'}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {existingStateAction === 'restore' && (
                      <>
                        <li>{gitInfo.existingProject.ticketCount} tickets and all workflow/artifact data</li>
                        <li>Ticket counter at {gitInfo.existingProject.ticketCounter}</li>
                        <li>Project identity, timestamps, and overrides</li>
                      </>
                    )}
                    {existingStateAction === 'clear_tickets' && (
                      <>
                        <li>Short name <span className="font-mono">{gitInfo.existingProject.shortname}</span></li>
                        <li>Project identity, appearance, creation time, and overrides</li>
                      </>
                    )}
                    {existingStateAction === 'start_fresh' && (
                      <>
                        <li>Name: {name}</li>
                        <li>Short name: <span className="font-mono">{shortname}</span></li>
                        <li>Appearance and settings shown above</li>
                      </>
                    )}
                    {existingStateAction !== 'start_fresh' && (
                      <li>Current form edits to visible project settings</li>
                    )}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-destructive">
                    {existingStateAction === 'restore' ? 'Not deleted' : 'Deleted'}
                  </p>
                  <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                    {existingStateAction === 'restore' ? (
                      <li>No saved LoopTroop data</li>
                    ) : existingStateAction === 'clear_tickets' ? (
                      <>
                        <li>All tickets, workflow data, logs, and artifacts</li>
                        <li>Managed worktrees and saved OpenCode sessions</li>
                        <li>Ticket counter resets to 0</li>
                      </>
                    ) : (
                      <>
                        <li>The entire existing <span className="font-mono">.looptroop</span> state folder</li>
                        <li>All tickets, artifacts, worktrees, and saved metadata</li>
                      </>
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
      <div className="flex justify-between gap-2.5 pt-2">
        {isEditing && (
          <div className="flex gap-2">
            <Button type="button" variant="destructive" onClick={handleDelete} disabled={isBusy} className="rounded-lg shadow-2xs">
              <Trash2 className="h-4 w-4 mr-1.5" />
              Delete Project
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setIsWorktreesDialogOpen(true)}
              disabled={isBusy}
              className="rounded-lg border border-border/70 shadow-2xs"
            >
              <HardDrive className="h-4 w-4 mr-1.5" />
              Free Disk Space…
            </Button>
          </div>
        )}
        <div className="flex gap-2.5 ml-auto">
          <Button type="button" variant="outline" onClick={closeView} className="rounded-lg">Cancel</Button>
          <Button
            type="submit"
            disabled={isBusy || (!isEditing && (gitStatus !== 'valid' || gitInfo.alreadyAttached || hasProjectIdentityConflict))}
            className="rounded-lg bg-foreground text-background font-semibold hover:opacity-95 active:scale-[0.98] shadow-2xs"
          >
            {isEditing
              ? 'Save Changes'
              : restoreMode
                ? existingStateAction === 'clear_tickets'
                  ? 'Clear Tickets & Attach'
                  : existingStateAction === 'start_fresh'
                    ? 'Start Fresh'
                    : 'Restore Project'
                : 'Create Project'}
          </Button>
        </div>
      </div>
    </form>

    <FolderPicker
      open={isFolderPickerOpen}
      onClose={() => setIsFolderPickerOpen(false)}
      onSelect={handleFolderSelected}
      initialPath={folder}
    />

    {isEditing && project && (
      <DeleteWorktreesDialog
        open={isWorktreesDialogOpen}
        onClose={() => setIsWorktreesDialogOpen(false)}
        projectId={project.id}
        projectName={project.name}
      />
    )}
    {restoreMode && gitInfo.existingProject && existingStateAction !== 'restore' && (
      <ExistingProjectActionDialog
        open={isExistingStateConfirmOpen}
        action={existingStateAction}
        project={gitInfo.existingProject}
        nextShortname={shortname}
        isPending={createProject.isPending}
        onCancel={() => setIsExistingStateConfirmOpen(false)}
        onConfirm={createProjectWithSelectedAction}
      />
    )}
    </>
  )
}
