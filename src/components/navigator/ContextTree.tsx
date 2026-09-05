import { useState } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useWorkflowMeta } from '@/hooks/useWorkflowMeta'
import type { WorkflowContextKey, WorkflowContextSection } from '@shared/workflowMeta'
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

interface ContextTreeProps {
  selectedPhase: string
}

interface ContextItem {
  id: string
  label: string
  icon: string
  description: string
}

const CONTEXT_LABELS: Record<string, ContextItem> = {
  ticket_details: {
    id: 'ticket_details',
    label: 'Ticket Details',
    icon: '📋',
    description: 'Title, description, and ticket metadata.',
  },
  relevant_files: {
    id: 'relevant_files',
    label: 'Relevant Files',
    icon: '📂',
    description: 'Source file contents identified as relevant to this ticket by AI analysis.',
  },
  drafts: {
    id: 'drafts',
    label: 'Competing Drafts',
    icon: '📝',
    description: 'Alternative model drafts used for voting/refinement.',
  },
  interview: {
    id: 'interview',
    label: 'Interview Results',
    icon: '💬',
    description: 'Interview question/answer artifact content.',
  },
  full_answers: {
    id: 'full_answers',
    label: 'Full Answers',
    icon: '🧠',
    description: 'Model-specific completed answers; PRD coverage receives only the winning model\'s artifact.',
  },
  user_answers: {
    id: 'user_answers',
    label: 'User Answers',
    icon: '✍️',
    description: 'Collected user responses during interview loop.',
  },
  votes: {
    id: 'votes',
    label: 'Council Votes',
    icon: '🗳️',
    description: 'Scoring/vote output from council phase.',
  },
  prd: {
    id: 'prd',
    label: 'PRD',
    icon: '📄',
    description: 'Product requirements artifact.',
  },
  beads: {
    id: 'beads',
    label: 'Beads Plan',
    icon: '🔗',
    description: 'Current beads artifact, including semantic blueprint content during coverage and execution-ready graph data after expansion.',
  },
  beads_draft: {
    id: 'beads_draft',
    label: 'Semantic Blueprint',
    icon: '🧩',
    description: 'Refined semantic beads blueprint used as the source for the final expansion step.',
  },
  tests: {
    id: 'tests',
    label: 'Verification Tests',
    icon: '🧪',
    description: 'Coverage/final test context and test intent.',
  },
  bead_data: {
    id: 'bead_data',
    label: 'Current Bead Data',
    icon: '⚙️',
    description: 'Active bead specification and acceptance criteria.',
  },
  bead_notes: {
    id: 'bead_notes',
    label: 'Bead Note Histories',
    icon: '📓',
    description: 'Failed Iteration Notes, User Retry Notes, and Finalization Failure Notes.',
  },
  execution_setup_plan: {
    id: 'execution_setup_plan',
    label: 'Setup Plan',
    icon: '🧾',
    description: 'Generated or approved workspace setup plan used before coding.',
  },
  execution_setup_plan_notes: {
    id: 'execution_setup_plan_notes',
    label: 'Setup Plan Notes',
    icon: '🗒️',
    description: 'Regeneration notes for the setup-plan approval gate.',
  },
  execution_setup_profile: {
    id: 'execution_setup_profile',
    label: 'Execution Setup Profile',
    icon: '🧰',
    description: 'Runtime setup profile with temp roots, tooling probes, reusable artifacts, and discovered command families. Coding can read it by reference and final testing can reuse declared wrappers.',
  },
  execution_setup_notes: {
    id: 'execution_setup_notes',
    label: 'Execution Setup Notes',
    icon: '🛠️',
    description: 'Retry-note history from prior execution setup attempts.',
  },
  final_test_notes: {
    id: 'final_test_notes',
    label: 'Final Test Notes',
    icon: '🧪',
    description: 'Retry-note history from prior final test attempts.',
  },
  error_context: {
    id: 'error_context',
    label: 'Error Context',
    icon: '❌',
    description: 'Failure context from previous blocked iteration.',
  },
}

function getContextIcon(key: string, fallback = '📦'): string {
  return CONTEXT_LABELS[key]?.icon ?? fallback
}

function outputItem(id: string, label: string, contextKey: string, description: string): ContextItem {
  return {
    id,
    label,
    icon: getContextIcon(contextKey),
    description,
  }
}

const PHASE_OUTPUTS: Record<string, ContextItem[]> = {
  DRAFT: [
    outputItem('ticket-details', 'Ticket Details', 'ticket_details', 'Seed context for the workflow.'),
  ],
  SCANNING_RELEVANT_FILES: [
    outputItem('relevant-files', 'Relevant Files', 'relevant_files', 'File context used by planning phases.'),
  ],
  COUNCIL_DELIBERATING: [
    outputItem('interview-drafts', 'Interview Drafts', 'drafts', 'Candidate question sets for voting.'),
  ],
  COUNCIL_VOTING_INTERVIEW: [
    outputItem('winning-draft', 'Winning Draft', 'drafts', 'Selected draft used to build the interview.'),
  ],
  COMPILING_INTERVIEW: [
    outputItem('interview', 'Interview', 'interview', 'Canonical questions for user answers.'),
  ],
  WAITING_INTERVIEW_ANSWERS: [
    outputItem('user-answers', 'User Answers', 'user_answers', 'Answers saved into the interview.'),
  ],
  VERIFYING_INTERVIEW_COVERAGE: [
    outputItem('coverage-result', 'Coverage Result', 'tests', 'Decision to approve or ask follow-ups.'),
    outputItem('follow-ups', 'Follow-ups', 'interview', 'Extra questions when answers are incomplete.'),
  ],
  WAITING_INTERVIEW_APPROVAL: [
    outputItem('approved-interview', 'Approved Interview', 'interview', 'Locked input for PRD drafting.'),
  ],
  DRAFTING_PRD: [
    outputItem('full-answers', 'Full Answers', 'full_answers', 'Skipped answers filled for PRD drafting.'),
    outputItem('prd-drafts', 'PRD Drafts', 'drafts', 'Candidate specs for voting.'),
  ],
  COUNCIL_VOTING_PRD: [
    outputItem('winning-prd', 'Winning PRD', 'prd', 'Selected spec used for refinement.'),
  ],
  REFINING_PRD: [
    outputItem('prd-candidate', 'PRD Candidate', 'prd', 'Refined spec for coverage checking.'),
  ],
  VERIFYING_PRD_COVERAGE: [
    outputItem('coverage-result', 'Coverage Result', 'tests', 'Coverage decision for PRD approval.'),
    outputItem('prd-candidate', 'PRD Candidate', 'prd', 'Latest checked spec for approval.'),
  ],
  WAITING_PRD_APPROVAL: [
    outputItem('approved-prd', 'Approved PRD', 'prd', 'Locked input for beads drafting.'),
  ],
  DRAFTING_BEADS: [
    outputItem('beads-drafts', 'Beads Drafts', 'drafts', 'Candidate task blueprints for voting.'),
  ],
  COUNCIL_VOTING_BEADS: [
    outputItem('winning-blueprint', 'Winning Blueprint', 'beads_draft', 'Selected blueprint used for refinement.'),
  ],
  REFINING_BEADS: [
    outputItem('semantic-blueprint', 'Semantic Blueprint', 'beads_draft', 'Refined task plan before expansion.'),
  ],
  VERIFYING_BEADS_COVERAGE: [
    outputItem('semantic-blueprint', 'Semantic Blueprint', 'beads_draft', 'Latest checked task blueprint.'),
  ],
  EXPANDING_BEADS: [
    outputItem('beads-plan', 'Beads Plan', 'beads', 'Execution-ready tasks for approval.'),
  ],
  WAITING_BEADS_APPROVAL: [
    outputItem('approved-beads', 'Approved Beads', 'beads', 'Locked task plan for coding.'),
  ],
  PRE_FLIGHT_CHECK: [
    outputItem('preflight-report', 'Preflight Report', 'tests', 'Readiness check before setup.'),
  ],
  GENERATING_EXECUTION_SETUP_PLAN: [
    outputItem('setup-plan-candidate', 'Setup Plan Candidate', 'execution_setup_plan', 'Generated readiness assessment and setup contract for approval.'),
  ],
  WAITING_EXECUTION_SETUP_APPROVAL: [
    outputItem('setup-plan', 'Setup Plan', 'execution_setup_plan', 'Approved contract for setup.'),
  ],
  PREPARING_EXECUTION_ENV: [
    outputItem('setup-profile', 'Setup Profile', 'execution_setup_profile', 'Runtime profile available to coding by file reference.'),
  ],
  CODING: [
    outputItem('code-changes', 'Code Changes', 'bead_data', 'Repository changes from beads.'),
    outputItem('bead-notes', 'Bead Note Histories', 'bead_notes', 'Separate append-only failure, user retry, and finalization histories.'),
  ],
  RUNNING_FINAL_TEST: [
    outputItem('test-report', 'Test Report', 'tests', 'Final verification for integration.'),
  ],
  GENERATING_QA_CHECKLIST: [
    outputItem('manual-qa-checklist', 'Manual QA Checklist', 'manual_qa_checklist', 'Generated user-run checks and advisory PRD coverage.'),
  ],
  WAITING_MANUAL_QA: [
    outputItem('manual-qa-checklist', 'Manual QA Checklist', 'manual_qa_checklist', 'Immutable checklist for the selected round.'),
    outputItem('manual-qa-results', 'Manual QA Results', 'manual_qa_results', 'Autosaved or submitted results and evidence references.'),
  ],
  INTEGRATING_CHANGES: [
    outputItem('candidate-commit', 'Candidate Commit', 'tests', 'Squashed commit for PR creation.'),
  ],
  CREATING_PULL_REQUEST: [
    outputItem('pull-request', 'Pull Request', 'tests', 'Draft PR for review.'),
  ],
  WAITING_PR_REVIEW: [
    outputItem('merge-result', 'Merge Result', 'tests', 'Final merge or close decision.'),
  ],
  CLEANING_ENV: [
    outputItem('cleanup-report', 'Cleanup Report', 'tests', 'What cleanup removed or kept.'),
  ],
  COMPLETED: [
    outputItem('final-record', 'Final Record', 'tests', 'Preserved ticket history.'),
  ],
  CANCELED: [
    outputItem('partial-history', 'Partial History', 'tests', 'Artifacts produced before canceling.'),
  ],
  BLOCKED_ERROR: [
    outputItem('error-context', 'Error Context', 'error_context', 'Failure details used for retry.'),
  ],
}

function getAllowedContextItems(keys: readonly WorkflowContextKey[]): ContextItem[] {
  return keys
    .map(key => CONTEXT_LABELS[key])
    .filter((item): item is ContextItem => Boolean(item))
}

function getAllowedContextSections(
  sections: readonly WorkflowContextSection[] | undefined,
  fallbackKeys: readonly WorkflowContextKey[],
): Array<{ label?: string; description?: string; items: ContextItem[] }> {
  if (!sections || sections.length === 0) {
    return [{ items: getAllowedContextItems(fallbackKeys) }]
  }

  return sections.map((section) => ({
    label: section.label,
    description: section.description,
    items: getAllowedContextItems(section.keys),
  }))
}

function ContextRow({ item }: { item: ContextItem }) {
  return (
    <Tooltip>
        <TooltipTrigger asChild>
          <div
            aria-label={item.description}
            className="w-full flex items-center gap-2 py-1 px-2 rounded-md text-xs hover:bg-accent transition-colors"
          >
            <span className="text-sm leading-none" aria-hidden>{item.icon}</span>
            <span className="truncate font-medium">{item.label}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-center text-balance">{item.description}</TooltipContent>
      </Tooltip>
  )
}

function getOutputItems(phase: string): ContextItem[] {
  return PHASE_OUTPUTS[phase] ?? []
}

export function ContextTree({ selectedPhase }: ContextTreeProps) {
  const { phaseMap } = useWorkflowMeta()
  const [isCollapsed, setIsCollapsed] = useState(true)
  const phaseMeta = phaseMap[selectedPhase]
  const sections = getAllowedContextSections(
    phaseMeta?.contextSections,
    phaseMeta?.contextSummary ?? ['ticket_details'],
  )
  const outputItems = getOutputItems(selectedPhase)
  const contextItemCount = sections.reduce((total, section) => total + section.items.length, 0)

  return (
    <div className="p-2">
      <button
        onClick={() => setIsCollapsed(c => !c)}
        className="w-full flex items-center gap-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 mb-1.5 hover:text-foreground transition-colors"
      >
        <ChevronRight className={cn('h-3 w-3 transition-transform', !isCollapsed && 'rotate-90')} />
        Context & Output
      </button>
      {!isCollapsed && (
        <ScrollArea className="max-h-[320px]">
          <div className="space-y-3">
            <div className="space-y-2">
              <div className="px-2 text-[11px] font-semibold uppercase text-muted-foreground">
                Allowed Context
              </div>
              {contextItemCount > 0 ? (
                sections.map((section, index) => (
                  <div
                    key={`${section.label ?? 'context'}-${index}`}
                    className={cn(index > 0 && 'border-t border-border/40 pt-2')}
                  >
                    {section.label ? (
                      <div className="px-2 pb-1">
                        <div className="flex items-baseline gap-1.5">
                          <span className="text-[11px] font-semibold text-foreground/80">{section.label}</span>
                          {section.description ? (
                            <span className="text-[11px] text-muted-foreground">- {section.description}</span>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                    <div className="space-y-0.5">
                      {section.items.map(item => (
                        <ContextRow key={`${section.label ?? 'context'}:${item.id}`} item={item} />
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  No default AI context is listed for this phase.
                </div>
              )}
            </div>

            <div className="border-t border-border/50 pt-2">
              <div className="px-2 pb-1 text-[11px] font-semibold uppercase text-muted-foreground">
                Output
              </div>
              {outputItems.length > 0 ? (
                <div className="space-y-0.5">
                  {outputItems.map((item) => (
                    <ContextRow key={`${selectedPhase}:${item.id}`} item={item} />
                  ))}
                </div>
              ) : (
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  No output is listed for this phase.
                </div>
              )}
            </div>
          </div>
        </ScrollArea>
      )}
    </div>
  )
}
