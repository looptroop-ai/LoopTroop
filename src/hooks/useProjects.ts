import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { clearPersistedTicketLogs } from '@/context/logUtils'
import { clearErrorTicketSeen } from '@/lib/errorTicketSeen'
import { getTicketArtifactsQueryKey } from './useTicketArtifacts'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import { normalizeGitHookPolicySetting } from '@/lib/gitHookPolicySetting'
import { throwIfNotOk } from '@/lib/fetchError'
import { apiProjectPath } from '@/lib/apiPaths'
import { DEFAULT_IGNORE_MODE, normalizeIgnoreMode, type IgnoreMode } from '@shared/ignoreMode'

interface Project {
  id: number
  name: string
  shortname: string
  icon: string
  color: string
  folderPath: string
  profileId: number | null
  councilMembers: string | null
  maxIterations: number | null
  perIterationTimeout: number | null
  executionSetupTimeout: number | null
  gitHookPolicy: GitHookPolicy | null
  councilResponseTimeout: number | null
  minCouncilQuorum: number | null
  interviewQuestions: number | null
  manualQaOverride?: boolean | null
  aiQuestionsOverride?: boolean | null
  /** Milliseconds, or null to inherit the profile's wait. */
  aiQuestionWindowOverride?: number | null
  ignoreMode: IgnoreMode
  ticketCounter: number
  createdAt: string
  updatedAt: string
  latestActivityTicketExternalId?: string
}

interface ExistingProjectPreview {
  name: string
  shortname: string
  icon: string | null
  color: string | null
  ticketCounter: number
  ticketCount: number
  activeTicketCount: number
  gitHookPolicy?: GitHookPolicy | null
  manualQaOverride?: boolean | null
  aiQuestionsOverride?: boolean | null
  aiQuestionWindowOverride?: number | null
  ignoreMode?: IgnoreMode
}

type ExistingStateAction = 'restore' | 'clear_tickets' | 'start_fresh'

/**
 * Where LoopTroop's own `.looptroop/` and `.ticket/` directories are ignored:
 * the repository's tracked `.gitignore`, this clone's `.git/info/exclude`, or
 * nowhere, for a repository that already handles it.
 */
interface CreateProjectInput {
  name: string
  shortname: string
  folderPath: string
  icon?: string
  color?: string
  profileId?: number
  executionSetupTimeout?: number
  gitHookPolicy?: GitHookPolicy | null
  manualQaOverride?: boolean | null
  aiQuestionsOverride?: boolean | null
  aiQuestionWindowOverride?: number | null
  existingStateAction?: ExistingStateAction
  ignoreMode?: IgnoreMode
}

interface CachedProjectTicket {
  id: string
  projectId: number
}

function invalidateProjectQueries(queryClient: ReturnType<typeof useQueryClient>) {
  queryClient.invalidateQueries({ queryKey: ['projects'] })
  queryClient.invalidateQueries({ queryKey: ['tickets'] })
}

function removeDeletedProjectTicketCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: number,
) {
  const cachedTicketIds = new Set<string>()
  const ticketLists = queryClient.getQueriesData<CachedProjectTicket[]>({ queryKey: ['tickets'] })

  for (const [, tickets] of ticketLists) {
    for (const ticket of tickets ?? []) {
      if (ticket.projectId === projectId) {
        cachedTicketIds.add(ticket.id)
      }
    }
  }

  queryClient.setQueriesData<CachedProjectTicket[]>({ queryKey: ['tickets'] }, (tickets) =>
    tickets?.filter((ticket) => ticket.projectId !== projectId) ?? tickets,
  )

  for (const ticketId of cachedTicketIds) {
    queryClient.removeQueries({ queryKey: ['ticket', ticketId], exact: true })
    queryClient.removeQueries({ queryKey: ['interview', ticketId], exact: true })
    queryClient.removeQueries({ queryKey: ['ticket-ui-state', ticketId] })
    queryClient.removeQueries({ queryKey: getTicketArtifactsQueryKey(ticketId), exact: true })
    clearPersistedTicketLogs(ticketId)
    clearErrorTicketSeen(ticketId)
  }
}

async function fetchProjects(signal?: AbortSignal): Promise<Project[]> {
  const res = await fetch('/api/projects', { signal })
  await throwIfNotOk(res, 'Failed to fetch projects')
  const projects = await res.json() as Project[]
  return projects.map((project) => ({
    ...project,
    gitHookPolicy: normalizeGitHookPolicySetting(project.gitHookPolicy),
    ignoreMode: normalizeIgnoreMode(project.ignoreMode) ?? DEFAULT_IGNORE_MODE,
  }))
}

async function createProject(input: CreateProjectInput): Promise<Project> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  await throwIfNotOk(res, 'Failed to create project')
  const project = await res.json() as Project
  return {
    ...project,
    gitHookPolicy: normalizeGitHookPolicySetting(project.gitHookPolicy),
    ignoreMode: normalizeIgnoreMode(project.ignoreMode) ?? DEFAULT_IGNORE_MODE,
  }
}

type UpdateProjectInput = Partial<Pick<
  Project,
  'name' | 'icon' | 'color' | 'executionSetupTimeout' | 'gitHookPolicy' | 'manualQaOverride' | 'aiQuestionsOverride' | 'aiQuestionWindowOverride'
>>

async function updateProject(id: number, input: UpdateProjectInput): Promise<Project> {
  const res = await fetch(apiProjectPath(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  await throwIfNotOk(res, 'Failed to update project')
  const project = await res.json() as Project
  return {
    ...project,
    gitHookPolicy: normalizeGitHookPolicySetting(project.gitHookPolicy),
    ignoreMode: normalizeIgnoreMode(project.ignoreMode) ?? DEFAULT_IGNORE_MODE,
  }
}

export function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => fetchProjects(signal),
  })
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      invalidateProjectQueries(queryClient)
    },
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(apiProjectPath(id), { method: 'DELETE' })
      await throwIfNotOk(res, 'Failed to delete project')
    },
    onSuccess: (_, projectId) => {
      removeDeletedProjectTicketCaches(queryClient, projectId)
      invalidateProjectQueries(queryClient)
    },
  })
}

export function useUpdateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...input }: { id: number } & UpdateProjectInput) =>
      updateProject(id, input),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', variables.id] })
    },
  })
}

export function useProjectWorktreesSize(projectId: number) {
  return useQuery({
    queryKey: ['project-worktrees-size', projectId],
    queryFn: async ({ signal }) => {
      const res = await fetch(apiProjectPath(projectId, 'worktrees', 'size'), { signal })
      await throwIfNotOk(res, 'Failed to fetch worktrees size')
      return res.json() as Promise<{ bytes: number }>
    },
    enabled: false,
    staleTime: 0,
  })
}

export function useDeleteProjectWorktrees() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await fetch(apiProjectPath(id, 'worktrees'), { method: 'DELETE' })
      await throwIfNotOk(res, 'Failed to delete worktrees')
      return res.json() as Promise<{ success: boolean; freedBytes: number }>
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['tickets'] })
      queryClient.invalidateQueries({ queryKey: ['ticket'] })
    },
  })
}

export type { Project, CreateProjectInput, ExistingProjectPreview, ExistingStateAction, IgnoreMode }
