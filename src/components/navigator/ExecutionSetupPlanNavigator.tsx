import { Badge } from '@/components/ui/badge'
import { useQuery } from '@tanstack/react-query'
import { QUERY_STALE_TIME_5M } from '@/lib/constants'
import { EXECUTION_SETUP_PLAN_APPROVAL_FOCUS_EVENT, type ExecutionSetupPlan } from '@/lib/executionSetupPlan'
import { apiTicketPath } from '@/lib/apiPaths'
import { throwIfNotOk } from '@/lib/fetchError'
import { ApprovalOutlineShell } from './ApprovalOutlineShell'

function focusExecutionSetupPlanAnchor(ticketId: string, anchorId: string) {
  window.dispatchEvent(new CustomEvent(EXECUTION_SETUP_PLAN_APPROVAL_FOCUS_EVENT, {
    detail: { ticketId, anchorId },
  }))
}

function isExecutionSetupPlan(value: unknown): value is ExecutionSetupPlan {
  return Boolean(value)
    && typeof value === 'object'
    && Array.isArray((value as ExecutionSetupPlan).steps)
    && Boolean((value as ExecutionSetupPlan).readiness)
}

export function ExecutionSetupPlanNavigator({ ticketId }: { ticketId: string }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['artifact', ticketId, 'execution-setup-plan'],
    queryFn: async ({ signal }) => {
      const response = await fetch(apiTicketPath(ticketId, 'execution-setup-plan'), { signal })
      await throwIfNotOk(response, 'Failed to load execution setup plan')
      return response.json() as Promise<{ plan?: unknown }>
    },
    staleTime: QUERY_STALE_TIME_5M,
  })

  const plan = isExecutionSetupPlan(data?.plan) ? data.plan : null

  return (
    <ApprovalOutlineShell
      title="Setup Plan"
      headerBadges={plan ? (
        <>
          <Badge variant="outline" className="h-4 text-[10px]">{plan.readiness.status}</Badge>
          <Badge variant="outline" className="h-4 text-[10px]">{plan.steps.length}</Badge>
        </>
      ) : null}
      isLoading={isLoading}
      isError={isError}
      error={error}
      onRetry={() => void refetch()}
      loadingMessage="Loading setup plan…"
      errorTitle="The setup-plan outline could not be loaded."
      emptyMessage={plan ? null : 'The setup-plan outline will appear once the draft is ready.'}
    >
      {plan && plan.steps.length === 0 ? (
        <div className="rounded-md border border-border/70 bg-background px-2 py-2 text-xs text-muted-foreground">
          {plan.summary || 'No setup actions are currently required.'}
        </div>
      ) : (
        plan?.steps.map((step, index) => (
          <button
            key={step.id || index}
            type="button"
            onClick={() => focusExecutionSetupPlanAnchor(ticketId, `execution-setup-step-${index}`)}
            className="w-full text-left rounded-md border border-border/70 bg-background px-2 py-1.5 transition-colors hover:bg-accent/30"
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded text-[10px] font-mono shrink-0">
                #{index + 1}
              </span>
              <span className="text-xs truncate flex-1">{step.title}</span>
              <Badge variant={step.required ? 'default' : 'outline'} className="h-4 text-[10px] shrink-0">
                {step.required ? 'req' : 'opt'}
              </Badge>
            </div>
          </button>
        ))
      )}
    </ApprovalOutlineShell>
  )
}
