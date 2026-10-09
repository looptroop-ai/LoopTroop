import type { ExistingStateAction, IgnoreMode, Project } from '@/hooks/useProjects'
import type { Profile } from '@/hooks/useProfile'
import type { ManualQaOverride } from '@/lib/manualQaSetting'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import { normalizeGitHookPolicySetting } from '@/lib/gitHookPolicySetting'
import { DEFAULT_IGNORE_MODE, normalizeIgnoreMode } from '@shared/ignoreMode'
import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'
import { SHARED_PROFILE_DEFAULTS as PROFILE_DEFAULTS } from '@shared/profileDefaults'
import type { GitCheckResponse } from './ProjectFolderSection'

export const initialProjectIdentity = (project?: Project) => {
  if (!project) return { name: '', shortname: '', folder: '' }
  return { name: project.name ?? '', shortname: project.shortname ?? '', folder: project.folderPath ?? '' }
}

export const initialProjectAppearance = (project?: Project) => {
  if (!project) return { icon: '📦', color: '#3b82f6' }
  return { icon: project.icon ?? '📦', color: project.color ?? '#3b82f6' }
}

export const initialProjectAiSettings = (project?: Project) => ({
  aiQuestionsOverride: project?.aiQuestionsOverride ?? null,
  aiQuestionWindowOverride: project?.aiQuestionWindowOverride ?? null,
})

export const resolveProjectManualQa = (value: ManualQaOverride | undefined, inherited: boolean | undefined) => (
  value ?? inherited ?? PROFILE_DEFAULTS.manualQaEnabled
)

export const initialProjectManualQa = (project: Project | undefined, profile: Profile | null | undefined) => (
  resolveProjectManualQa(project?.manualQaOverride, profile?.manualQaEnabled)
)

export const resolveProjectGitHookPolicy = (value: GitHookPolicy | null | undefined, inherited: GitHookPolicy | undefined) => (
  normalizeGitHookPolicySetting(value) ?? normalizeGitHookPolicySetting(inherited) ?? DEFAULT_GIT_HOOK_POLICY
)

export const initialProjectGitHookPolicy = (project: Project | undefined, profile: Profile | null | undefined) => (
  resolveProjectGitHookPolicy(project?.gitHookPolicy, profile?.gitHookPolicy)
)

export const resolveProjectIgnoreMode = (value: IgnoreMode | undefined) => normalizeIgnoreMode(value) ?? DEFAULT_IGNORE_MODE

export const initialProjectIgnoreMode = (project: Project | undefined, profile: Profile | null | undefined) => (
  normalizeIgnoreMode(project?.ignoreMode) ?? normalizeIgnoreMode(profile?.ignoreMode) ?? DEFAULT_IGNORE_MODE
)

export const projectProfileValues = (profile: Profile | null | undefined) => ({
  gitHookPolicy: profile?.gitHookPolicy,
  manualQaEnabled: profile?.manualQaEnabled,
})

export const profileIgnoreMode = (profile: Profile) => profile.ignoreMode ?? DEFAULT_IGNORE_MODE

export const hasExistingProjectState = (data: GitCheckResponse) => (
  data.hasLoopTroopState === true && !!data.existingProject && !!data.repoRoot
)

export const shouldPrefillSavedProject = (isEditing: boolean, data: GitCheckResponse, prefilledRepoRoot: string | null) => {
  if (isEditing || data.alreadyAttached) return false
  return hasExistingProjectState(data) && data.repoRoot !== prefilledRepoRoot
}

export const isRestoringProject = (isEditing: boolean, data: GitCheckResponse) => (
  !isEditing && !data.alreadyAttached && data.hasLoopTroopState === true && !!data.existingProject
)

export const getSavedShortnameLocked = (restoreMode: boolean, action: ExistingStateAction) => restoreMode && action !== 'start_fresh'

export const isProjectShortnameLocked = (isEditing: boolean, isCreating: boolean, isSavedLocked: boolean) => (
  isEditing || isCreating || isSavedLocked
)

export const isProjectStartingFresh = (restoreMode: boolean, action: ExistingStateAction) => restoreMode && action === 'start_fresh'

const duplicateProjectName = (projects: Project[] | undefined, name: string, isEditing: boolean) => {
  if (isEditing || !name.trim()) return undefined
  return projects?.find(project => project.name.trim().toLowerCase() === name.trim().toLowerCase())
}

const duplicateProjectShortname = (projects: Project[] | undefined, shortname: string, isEditing: boolean) => {
  if (isEditing || !shortname.trim()) return undefined
  return projects?.find(project => project.shortname.trim().toUpperCase() === shortname.trim().toUpperCase())
}

export const projectIdentityConflicts = (projects: Project[] | undefined, name: string, shortname: string, isEditing: boolean) => {
  const duplicateNameProject = duplicateProjectName(projects, name, isEditing)
  const duplicateShortnameProject = duplicateProjectShortname(projects, shortname, isEditing)
  return { duplicateNameProject, duplicateShortnameProject, hasProjectIdentityConflict: !!duplicateNameProject || !!duplicateShortnameProject }
}

export const isProjectDraftDirty = (baseline: string | null, draft: string) => baseline !== null && draft !== baseline

export const hasProjectDraftChanges = (draft: string, baseline: string | null, initial: string | null) => draft !== (baseline ?? initial)

export const canApplyProfileDefaults = (defaultsApplied: boolean, isEditing: boolean, prefilledRepoRoot: string | null) => (
  !defaultsApplied && !isEditing && !prefilledRepoRoot
)

export const isProjectFormBusy = (isCreating: boolean, isUpdating: boolean, isDeleting: boolean) => isCreating || isUpdating || isDeleting

export const hasProjectCreationBlockers = (data: GitCheckResponse, hasIdentityConflict: boolean) => (
  data.status !== 'valid' || !!data.alreadyAttached || hasIdentityConflict
)

export const showProjectIgnoreMode = (isEditing: boolean, data: GitCheckResponse) => (
  isEditing || (data.status === 'valid' && !data.alreadyAttached)
)
