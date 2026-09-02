import { useMemo } from 'react'
import {
  WORKFLOW_GROUPS,
  WORKFLOW_PHASES,
  type WorkflowPhaseMeta,
} from '@shared/workflowMeta'

/**
 * The workflow's groups and phases, read from the shared table.
 *
 * This used to be a React Query query over `/api/workflow/meta` that could never
 * reach the network: it was seeded with these same constants as `initialData`,
 * held at `staleTime: Infinity` with mount and focus refetching off, and nothing
 * invalidated its key — so the fetcher was dead code and `isLoading` was always
 * false. Both sides derive this from one shared module anyway, and making it
 * actually fetch would add a request on first mount, which is a behaviour change
 * rather than a cleanup.
 *
 * `isLoading` is kept so consumers do not change. The route still exists and is
 * unchanged.
 */
export function useWorkflowMeta() {
  const phaseMap = useMemo(
    () => Object.fromEntries(WORKFLOW_PHASES.map((phase) => [phase.id, phase])) as Record<string, WorkflowPhaseMeta>,
    [],
  )

  return {
    groups: WORKFLOW_GROUPS,
    phases: WORKFLOW_PHASES,
    phaseMap,
    isLoading: false,
  }
}
