import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  clearTicketCaches,
  collectQueryKeyStrings,
  releaseClosingTicket,
  settleTicketUiStateSavesForDelete,
} from './useTickets'
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

/**
 * Whether a ticket id belongs to this project.
 *
 * A ticket id is `<projectId>:<externalId>` — the server builds it that way in
 * `buildTicketRef` and takes it apart the same way in `parseTicketRef`. Reading
 * the project off the id is what lets a deletion find tickets the cache knows
 * only by id: a detail query still in flight has no data to check `projectId`
 * against, and an artifact or UI-state entry never had any.
 */
function ticketIdBelongsToProject(ticketId: string, projectId: number): boolean {
  const separator = ticketId.indexOf(':')
  return separator > 0 && Number(ticketId.slice(0, separator)) === projectId
}

/**
 * Every ticket of this project the cache knows about, by any route.
 *
 * The list queries are not the whole story: opening a ticket writes
 * `['ticket', id]`, and a list refetch that no longer includes it leaves that
 * entry as the only record of the id. Nor is the detail cache — a request that
 * has not resolved yet holds no `projectId` to match on, and its response can
 * land after the delete and reinstall the ticket. So every cached key is
 * searched for an id this project owns.
 */
function collectCachedProjectTicketIds(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: number,
): Set<string> {
  const cachedTicketIds = new Set<string>()

  for (const [, tickets] of queryClient.getQueriesData<CachedProjectTicket[]>({ queryKey: ['tickets'] })) {
    for (const ticket of tickets ?? []) {
      if (ticket.projectId === projectId) cachedTicketIds.add(ticket.id)
    }
  }

  for (const query of queryClient.getQueryCache().getAll()) {
    for (const part of collectQueryKeyStrings(query.queryKey)) {
      if (ticketIdBelongsToProject(part, projectId)) cachedTicketIds.add(part)
    }
  }

  return cachedTicketIds
}

async function removeDeletedProjectTicketCaches(
  queryClient: ReturnType<typeof useQueryClient>,
  cachedTicketIds: Set<string>,
  projectId: number,
) {
  queryClient.setQueriesData<CachedProjectTicket[]>({ queryKey: ['tickets'] }, (tickets) =>
    tickets?.filter((ticket) => ticket.projectId !== projectId) ?? tickets,
  )

  await Promise.all([...cachedTicketIds].map((ticketId) => clearTicketCaches(queryClient, ticketId)))
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
      // The same barrier the ticket delete uses, for every ticket of this
      // project: a debounced approval autosave otherwise reaches the server for
      // rows the project delete is about to remove.
      const ticketIds = collectCachedProjectTicketIds(queryClient, id)
      await Promise.all([...ticketIds].map((ticketId) => settleTicketUiStateSavesForDelete(ticketId)))

      try {
        const res = await fetch(apiProjectPath(id), { method: 'DELETE' })
        await throwIfNotOk(res, 'Failed to delete project')
      } catch (error) {
        // The project and its tickets are still there, so their panels have to
        // be able to save again. Without this every collected ticket stayed
        // tombstoned for the life of the tab.
        for (const ticketId of ticketIds) releaseClosingTicket(ticketId)
        throw error
      }
      return ticketIds
    },
    onSuccess: async (ticketIds, projectId) => {
      await removeDeletedProjectTicketCaches(queryClient, ticketIds, projectId)
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
