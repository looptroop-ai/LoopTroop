import { useState, useRef, useEffect, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useCreateProject, useUpdateProject, useDeleteProject, useProjects } from '@/hooks/useProjects'
import type { ExistingProjectPreview, ExistingStateAction, IgnoreMode, Project } from '@/hooks/useProjects'
import { useToast } from '@/components/shared/useToast'
import { ArrowLeft } from 'lucide-react'
import { FolderPicker } from '@/components/project/FolderPicker'
import { PROJECT_GIT_CHECK_DEBOUNCE_MS } from '@/lib/constants'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import type { AiQuestionsOverride, AiQuestionWindowOverride } from '@/lib/aiQuestionSetting'
import { useProfile } from '@/hooks/useProfile'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import { throwIfNotOk } from '@/lib/fetchError'
import { ProjectIdentitySection, ProjectAppearanceSection, ProjectAdvancedSection, ProjectFormActions, ProjectMaintenanceDialog } from './ProjectFormSections'
import { ProjectFolderSection, type GitCheckResponse } from './ProjectFolderSection'
import { ProjectRestoreSection, ProjectRestoreConfirmation } from './ProjectRestoreSection'
import {
  initialProjectIdentity, initialProjectAppearance, initialProjectAiSettings,
  initialProjectManualQa, initialProjectGitHookPolicy, initialProjectIgnoreMode,
  resolveProjectManualQa, resolveProjectGitHookPolicy, resolveProjectIgnoreMode,
  projectProfileValues, profileIgnoreMode, shouldPrefillSavedProject, isRestoringProject,
  getSavedShortnameLocked, isProjectShortnameLocked, isProjectStartingFresh,
  projectIdentityConflicts, isProjectDraftDirty, hasProjectDraftChanges,
  canApplyProfileDefaults, isProjectFormBusy, hasProjectCreationBlockers, showProjectIgnoreMode,
} from './projectFormValues'

interface ProjectFormProps {
  onClose: () => void
  onBack?: () => void
  project?: Project
  onDirtyChange?: (isDirty: boolean) => void
}

const projectDraftSnapshot = (values: {
  name: string
  shortname: string
  folder: string
  icon: string
  color: string
  manualQaOverride: ManualQaOverride
  aiQuestionsOverride: AiQuestionsOverride
  aiQuestionWindowOverride: AiQuestionWindowOverride
  gitHookPolicy: GitHookPolicy
  ignoreMode: IgnoreMode
  existingStateAction: ExistingStateAction
}): string => {
  return JSON.stringify(values)
}

const projectRestoreSnapshot = (snapshot: string | null): string | null => {
  if (snapshot === null) return null
  try {
    const values = JSON.parse(snapshot) as Record<string, unknown>
    delete values.folder
    return JSON.stringify(values)
  } catch {
    return snapshot
  }
}

const projectSnapshotWithFolder = (snapshot: string, folder: string): string => {
  try {
    const values = JSON.parse(snapshot) as Record<string, unknown>
    values.folder = folder
    return JSON.stringify(values)
  } catch {
    return snapshot
  }
}

const ProjectDetailsCard = ({ children }: { children: ReactNode }) => (
  <Card className="rounded-xl border border-border/70 bg-card shadow-2xs">
    <CardHeader><CardTitle className="text-sm font-semibold text-foreground">Project Details</CardTitle></CardHeader>
    <CardContent className="space-y-4">{children}</CardContent>
  </Card>
)

const RESTORE_SUCCESS_MESSAGES: Record<ExistingStateAction, string> = {
  restore: 'Project restored from existing LoopTroop data.',
  clear_tickets: 'Project attached with its settings and a clean ticket list.',
  start_fresh: 'Fresh project created after removing existing LoopTroop state.',
}

export const ProjectForm = ({ onClose, onBack, project, onDirtyChange }: ProjectFormProps) => {
  const createProject = useCreateProject()
  const updateProject = useUpdateProject()
  const deleteProject = useDeleteProject()
  const { addToast } = useToast()
  const { data: profile, isLoading: profileLoading } = useProfile()
  const { data: projects } = useProjects()
  const [createdProject, setCreatedProject] = useState<Project | null>(null)
  const editingProject = project ?? createdProject
  const isEditing = !!editingProject
  const initialIdentity = initialProjectIdentity(project)
  const initialAppearance = initialProjectAppearance(project)
  const initialAiSettings = initialProjectAiSettings(project)
  const { gitHookPolicy: profileGitHookPolicy, manualQaEnabled: profileManualQaEnabled } = projectProfileValues(profile)
  const [name, setName] = useState(initialIdentity.name)
  const [shortname, setShortname] = useState(initialIdentity.shortname)
  const [folder, setFolder] = useState(initialIdentity.folder)
  const [icon, setIcon] = useState(initialAppearance.icon)
  const [color, setColor] = useState(initialAppearance.color)
  const [manualQaOverride, setManualQaOverride] = useState<ManualQaOverride>(
    initialProjectManualQa(project, profile),
  )
  // Both AI question settings inherit by default, and cascade independently.
  const [aiQuestionsOverride, setAiQuestionsOverride] = useState<AiQuestionsOverride>(
    initialAiSettings.aiQuestionsOverride,
  )
  const [aiQuestionWindowOverride, setAiQuestionWindowOverride] = useState<AiQuestionWindowOverride>(
    initialAiSettings.aiQuestionWindowOverride,
  )
  const [hasAiQuestionWaitError, setHasAiQuestionWaitError] = useState(false)
  const [gitHookPolicy, setGitHookPolicy] = useState<GitHookPolicy>(
    initialProjectGitHookPolicy(project, profile),
  )
  const [isIconPickerOpen, setIsIconPickerOpen] = useState(false)
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false)
  const [gitInfo, setGitInfo] = useState<GitCheckResponse>({ isGit: false, status: 'none' })
  const [isFolderPickerOpen, setIsFolderPickerOpen] = useState(false)
  const [isWorktreesDialogOpen, setIsWorktreesDialogOpen] = useState(false)
  const [existingStateAction, setExistingStateAction] = useState<ExistingStateAction>('restore')
  const [ignoreMode, setIgnoreMode] = useState<IgnoreMode>(
    initialProjectIgnoreMode(project, profile),
  )
  const [isExistingStateConfirmOpen, setIsExistingStateConfirmOpen] = useState(false)
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)
  const restorePrefillKeyRef = useRef<string | null>(null)
  const profileDefaultsAppliedRef = useRef(isEditing || !!profile)
  const projectBaselineRef = useRef<string | null>(null)
  const projectInitialValuesRef = useRef({
    name,
    shortname,
    folder,
    icon,
    color,
    aiQuestionsOverride,
    aiQuestionWindowOverride,
    existingStateAction,
  })
  const closeView = onBack ?? onClose
  const restoreMode = isRestoringProject(isEditing, gitInfo)
  const isSavedShortnameLocked = getSavedShortnameLocked(restoreMode, existingStateAction)
  const { duplicateNameProject, duplicateShortnameProject, hasProjectIdentityConflict } = projectIdentityConflicts(projects, name, shortname, isEditing)
  const draftSnapshot = projectDraftSnapshot({
    name,
    shortname,
    folder,
    icon,
    color,
    manualQaOverride,
    aiQuestionsOverride,
    aiQuestionWindowOverride,
    gitHookPolicy,
    ignoreMode,
    existingStateAction,
  })
  const draftSnapshotRef = useRef(draftSnapshot)
  draftSnapshotRef.current = draftSnapshot
  const projectInitialDraftRef = useRef(draftSnapshot)

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
    const applySavedIdentity = (saved: ExistingProjectPreview) => {
      setName(saved.name)
      setShortname(saved.shortname)
      setIcon(saved.icon ?? '📁')
      setColor(saved.color ?? '#3b82f6')
    }
    const applySavedAiSettings = (saved: ExistingProjectPreview) => {
      if (saved.aiQuestionsOverride !== undefined) setAiQuestionsOverride(saved.aiQuestionsOverride)
      if (saved.aiQuestionWindowOverride !== undefined) setAiQuestionWindowOverride(saved.aiQuestionWindowOverride)
    }
    const applySavedAdvancedSettings = (saved: ExistingProjectPreview) => {
      if (saved.manualQaOverride !== undefined) setManualQaOverride(resolveProjectManualQa(saved.manualQaOverride, profileManualQaEnabled))
      if (saved.gitHookPolicy !== undefined) setGitHookPolicy(resolveProjectGitHookPolicy(saved.gitHookPolicy, profileGitHookPolicy))
      if (saved.ignoreMode !== undefined) setIgnoreMode(resolveProjectIgnoreMode(saved.ignoreMode))
    }
    const prefillSavedProject = (data: GitCheckResponse) => {
      if (!data.existingProject || !data.repoRoot) return
      const currentRestoreDraft = projectRestoreSnapshot(draftSnapshotRef.current)
      const baselineRestoreDraft = projectRestoreSnapshot(projectBaselineRef.current ?? projectInitialDraftRef.current)
      if (currentRestoreDraft !== baselineRestoreDraft) return
      profileDefaultsAppliedRef.current = true
      applySavedIdentity(data.existingProject)
      applySavedAiSettings(data.existingProject)
      applySavedAdvancedSettings(data.existingProject)
      setExistingStateAction('restore')
      setIsExistingStateConfirmOpen(false)
      restorePrefillKeyRef.current = data.repoRoot
    }
    const timer = setTimeout(() => {
      fetch(`/api/projects/check-git?path=${encodeURIComponent(folder)}`)
        // A refused request is not a git verdict: without this the error body was
        // read as a `GitCheckResponse`, so a 500 became "not a git repository".
        .then(async (r) => {
          await throwIfNotOk(r, 'Git check failed')
          return r.json() as Promise<GitCheckResponse>
        })
        .then((data: GitCheckResponse) => {
          if (cancelled) return
          if (shouldPrefillSavedProject(isEditing, data, restorePrefillKeyRef.current)) prefillSavedProject(data)
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
  }, [folder, isEditing, profileGitHookPolicy, profileManualQaEnabled])

  useEffect(() => {
    if (!profile || !canApplyProfileDefaults(profileDefaultsAppliedRef.current, isEditing, restorePrefillKeyRef.current)) return
    const currentDraftIsDirty = hasProjectDraftChanges(draftSnapshotRef.current, projectBaselineRef.current, projectInitialDraftRef.current)
    const nextManualQaOverride = profile.manualQaEnabled
    const nextGitHookPolicy = profile.gitHookPolicy
    const nextIgnoreMode = profileIgnoreMode(profile)
    profileDefaultsAppliedRef.current = true
    if (currentDraftIsDirty) {
      // Keep the draft, but compare it with the values that arrived from the
      // profile so the modal still explains what would be discarded. Identity
      // fields and explicit overrides have no profile value: their baseline is
      // the value present before hydration, never text typed while it raced.
      projectBaselineRef.current = projectDraftSnapshot({
        ...projectInitialValuesRef.current,
        manualQaOverride: nextManualQaOverride,
        aiQuestionsOverride: projectInitialValuesRef.current.aiQuestionsOverride,
        aiQuestionWindowOverride: projectInitialValuesRef.current.aiQuestionWindowOverride,
        gitHookPolicy: nextGitHookPolicy,
        ignoreMode: nextIgnoreMode,
        existingStateAction: projectInitialValuesRef.current.existingStateAction,
      })
      onDirtyChange?.(true)
      return
    }
    projectBaselineRef.current = projectDraftSnapshot({
      name,
      shortname,
      folder,
      icon,
      color,
      manualQaOverride: nextManualQaOverride,
      aiQuestionsOverride,
      aiQuestionWindowOverride,
      gitHookPolicy: nextGitHookPolicy,
      ignoreMode: nextIgnoreMode,
      existingStateAction,
    })
    setManualQaOverride(nextManualQaOverride)
    setGitHookPolicy(nextGitHookPolicy)
    setIgnoreMode(nextIgnoreMode)
  }, [aiQuestionWindowOverride, aiQuestionsOverride, color, existingStateAction, folder, icon, ignoreMode, isEditing, manualQaOverride, name, onDirtyChange, profile, shortname])

  useEffect(() => {
    if (projectBaselineRef.current === null) {
      // The first draft is the meaningful baseline even while profile defaults
      // are still loading. Identity fields have no profile default; if no
      // profile arrives, never turn a value typed during loading into a clean
      // baseline.
      projectBaselineRef.current = projectInitialDraftRef.current
    }
  }, [draftSnapshot, isEditing, profile, profileLoading])

  const isDirty = [hasAiQuestionWaitError, isProjectDraftDirty(projectBaselineRef.current, draftSnapshot)].some(Boolean)
  useEffect(() => {
    onDirtyChange?.(isDirty)
  }, [isDirty, onDirtyChange])

  const handleCloseView = () => {
    if (isDirty && !window.confirm('Discard your unsaved project changes?')) return
    closeView()
  }

  const handleBrowseFolder = () => {
    setIsFolderPickerOpen(true)
  }

  const handleFolderSelected = (path: string) => {
    setFolder(path)
    setIsFolderPickerOpen(false)
  }

  const effectiveManualQaOverride = resolveProjectManualQa(manualQaOverride, profileManualQaEnabled)

  const createProjectWithSelectedAction = () => {
    if (hasAiQuestionWaitError) return
    const submittedSnapshot = draftSnapshotRef.current
    createProject.mutate(
      {
        name,
        shortname,
        folderPath: folder,
        icon,
        color,
        gitHookPolicy,
        ignoreMode,
        manualQaOverride: effectiveManualQaOverride,
        aiQuestionsOverride,
        aiQuestionWindowOverride,
        ...(restoreMode ? { existingStateAction } : {}),
      },
      {
        onSuccess: (created: Project) => {
          setCreatedProject(created)
          // The server stores the repository root even when the form started
          // from a subfolder. Treat that canonical identity as part of the
          // submitted snapshot while preserving any later editable fields.
          const canonicalSubmittedSnapshot = projectSnapshotWithFolder(submittedSnapshot, created.folderPath)
          const canonicalCurrentSnapshot = projectSnapshotWithFolder(draftSnapshotRef.current, created.folderPath)
          projectBaselineRef.current = canonicalSubmittedSnapshot
          setFolder(created.folderPath)
          onDirtyChange?.(canonicalCurrentSnapshot !== canonicalSubmittedSnapshot)
          const successMessage = restoreMode ? RESTORE_SUCCESS_MESSAGES[existingStateAction] : 'Project created.'
          addToast('success', successMessage)
          if (canonicalCurrentSnapshot === canonicalSubmittedSnapshot) closeView()
        },
      },
    )
  }

  const updateEditingProject = (editing: Project) => {
    const submittedSnapshot = draftSnapshotRef.current
    updateProject.mutate(
      {
        id: editing.id,
        name,
        icon,
        color,
        gitHookPolicy,
        manualQaOverride: effectiveManualQaOverride,
        aiQuestionsOverride,
        aiQuestionWindowOverride,
      },
      {
        onSuccess: (updated: Project) => {
          if (!project) setCreatedProject(updated)
          projectBaselineRef.current = submittedSnapshot
          onDirtyChange?.(draftSnapshotRef.current !== submittedSnapshot)
          addToast('success', 'Project updated.')
          if (draftSnapshotRef.current === submittedSnapshot) closeView()
        },
      },
    )
  }

  const submitNewProject = () => {
    if (isCreationBlocked) return
    if (restoreMode && existingStateAction !== 'restore') {
      setIsExistingStateConfirmOpen(true)
      return
    }
    createProjectWithSelectedAction()
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (hasAiQuestionWaitError) return
    if (editingProject) {
      updateEditingProject(editingProject)
      return
    }
    submitNewProject()
  }

  const handleExistingStateActionChange = (action: ExistingStateAction) => {
    setExistingStateAction(action)
    if (action !== 'start_fresh' && gitInfo.existingProject) {
      setShortname(gitInfo.existingProject.shortname)
    }
  }

  const handleDelete = () => {
    if (!editingProject) return
    if (!confirm('Are you sure you want to delete this project? This will remove its local .looptroop state from the repo and cannot be undone.')) return
    deleteProject.mutate(editingProject.id, {
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

  const isBusy = isProjectFormBusy(createProject.isPending, updateProject.isPending, deleteProject.isPending)
  const isCreationBlocked = hasProjectCreationBlockers(gitInfo, hasProjectIdentityConflict)

  return (
    <>
      <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-6">
        {onBack && (
          <Button type="button" variant="ghost" size="sm" onClick={handleCloseView}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back to list
          </Button>
        )}
        <ProjectDetailsCard>
          <ProjectIdentitySection
            name={name}
            shortname={shortname}
            onNameChange={setName}
            onShortnameChange={setShortname}
            duplicateNameProject={duplicateNameProject}
            duplicateShortnameProject={duplicateShortnameProject}
            shortnameLocked={isProjectShortnameLocked(isEditing, createProject.isPending, isSavedShortnameLocked)}
            isSavedShortnameLocked={isSavedShortnameLocked}
            isStartingFresh={isProjectStartingFresh(restoreMode, existingStateAction)}
          />
          <ProjectAppearanceSection
            icon={icon}
            color={color}
            isIconPickerOpen={isIconPickerOpen}
            isColorPickerOpen={isColorPickerOpen}
            onIconOpenChange={setIsIconPickerOpen}
            onColorOpenChange={setIsColorPickerOpen}
            onIconChange={setIcon}
            onColorChange={setColor}
          />
          <ProjectAdvancedSection
            profile={profile}
            profileLoading={profileLoading}
            isOpen={isAdvancedOpen}
            onToggle={() => setIsAdvancedOpen(open => !open)}
            hasWaitError={hasAiQuestionWaitError}
            onWaitValidationChange={setHasAiQuestionWaitError}
            manualQaOverride={manualQaOverride}
            onManualQaChange={setManualQaOverride}
            aiQuestionsOverride={aiQuestionsOverride}
            onAiQuestionsChange={setAiQuestionsOverride}
            aiQuestionWindowOverride={aiQuestionWindowOverride}
            onAiQuestionWindowChange={setAiQuestionWindowOverride}
            gitHookPolicy={gitHookPolicy}
            onGitHookPolicyChange={setGitHookPolicy}
            ignoreMode={ignoreMode}
            onIgnoreModeChange={setIgnoreMode}
            showIgnoreMode={showProjectIgnoreMode(isEditing, gitInfo)}
            isEditing={isEditing}
            isBusy={isBusy}
          />
          <ProjectFolderSection project={editingProject} folder={folder} onFolderChange={setFolder} onBrowse={handleBrowseFolder} isPending={createProject.isPending} restoreMode={restoreMode} gitInfo={gitInfo} />
          <ProjectRestoreSection project={gitInfo.existingProject} restoreMode={restoreMode} action={existingStateAction} onActionChange={handleExistingStateActionChange} isBusy={isBusy} scope={gitInfo.scope} repoRoot={gitInfo.repoRoot} name={name} shortname={shortname} />
        </ProjectDetailsCard>
        <ProjectFormActions
          isEditing={isEditing}
          isBusy={isBusy}
          hasWaitError={hasAiQuestionWaitError}
          isCreationBlocked={isCreationBlocked}
          restoreMode={restoreMode}
          existingStateAction={existingStateAction}
          onDelete={handleDelete}
          onWorktreesOpen={() => setIsWorktreesDialogOpen(true)}
          onCancel={handleCloseView}
        />
      </form>
      <FolderPicker open={isFolderPickerOpen} onClose={() => setIsFolderPickerOpen(false)} onSelect={handleFolderSelected} initialPath={folder} />
      <ProjectMaintenanceDialog project={editingProject} open={isWorktreesDialogOpen} onClose={() => setIsWorktreesDialogOpen(false)} />
      <ProjectRestoreConfirmation open={isExistingStateConfirmOpen} action={existingStateAction} project={gitInfo.existingProject} restoreMode={restoreMode} nextShortname={shortname} isPending={createProject.isPending} onCancel={() => setIsExistingStateConfirmOpen(false)} onConfirm={createProjectWithSelectedAction} />
    </>
  )
}
