import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { InterviewDocument, InterviewDocumentQuestion } from '@shared/interviewArtifact'
import {
  getInterviewAnswerSummary,
  getInterviewFollowUpsAnchorId,
  getInterviewQuestionAnchorId,
  getInterviewSummaryAnchorId,
  hasInterviewSummaryContent,
  groupInterviewDocumentQuestions,
} from '@/lib/interviewDocument'
import { CollapsibleSection } from './ArtifactContentViewer'

function MetaPill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('rounded-full border border-border bg-background px-2.5 py-1 text-[10px] uppercase tracking-wider text-foreground', className)}>
      {children}
    </span>
  )
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="space-y-2 rounded-xl border border-border/70 bg-background/70 p-3">
      <div className="section-label">{title}</div>
      {items.length > 0 ? (
        <ul className="space-y-1.5 text-sm text-foreground">
          {items.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-[0.4rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/70" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-xs text-muted-foreground">No items recorded.</div>
      )}
    </div>
  )
}

function QuestionMeta({ question }: { question: InterviewDocumentQuestion }) {
  const isChoice = question.answer_type === 'single_choice' || question.answer_type === 'multiple_choice'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge variant="outline" className="font-mono text-[10px]">{question.id}</Badge>
      <Badge variant="outline" className="text-[10px] capitalize">{question.answer_type.replace(/_/g, ' ')}</Badge>
      {question.source !== 'compiled' && (
        <Badge variant="outline" className="text-[10px]">
          {question.source === 'prompt_follow_up'
            ? 'PROM4 follow-up'
            : question.source === 'coverage_follow_up'
              ? 'Coverage follow-up'
              : 'Final free-form'}
        </Badge>
      )}
      {question.follow_up_round ? (
        <Badge variant="outline" className="text-[10px]">Round {question.follow_up_round}</Badge>
      ) : null}
      {isChoice ? (
        <MetaPill>{question.options.length} option{question.options.length === 1 ? '' : 's'}</MetaPill>
      ) : null}
    </div>
  )
}

function AnswerBlock({ question, hideAiAnswerBadge }: { question: InterviewDocumentQuestion; hideAiAnswerBadge?: boolean }) {
  const answerSummary = getInterviewAnswerSummary(question.answer, question.options)
  const isAiAnswer = question.answer.answered_by === 'ai_skip'

  if (answerSummary.skipped && !isAiAnswer) {
    return (
      <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
        <div>This question was skipped and left for downstream drafting to interpret.</div>
        {question.answer.skip_reason ? (
          <div className="whitespace-pre-wrap">
            <span className="font-medium">Why it was skipped:</span> {question.answer.skip_reason}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {isAiAnswer && !hideAiAnswerBadge && (
        <div className="inline-flex items-center gap-1.5 rounded-md border border-purple-200 bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-800 dark:border-purple-900/60 dark:bg-purple-900/20 dark:text-purple-300">
          <span className="shrink-0 leading-none pb-[1px]">✨</span>
          <span>Answered automatically by AI in Drafting specs status</span>
        </div>
      )}
      {answerSummary.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {answerSummary.labels.map((label) => (
            <span key={label} className="inline-flex items-center rounded-full bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary">
              {label}
            </span>
          ))}
        </div>
      ) : null}
      {answerSummary.freeText ? (
        <div className="whitespace-pre-wrap text-sm leading-6 text-foreground/95">{answerSummary.freeText}</div>
      ) : answerSummary.labels.length === 0 ? (
        <div className="text-xs text-muted-foreground">No free-text note recorded.</div>
      ) : null}
    </div>
  )
}

function QuestionCard({ question, hideAiAnswerBadge }: { question: InterviewDocumentQuestion; hideAiAnswerBadge?: boolean }) {
  return (
    <article
      id={getInterviewQuestionAnchorId(question.id)}
      className="rounded-xl border border-border bg-background/80 p-4 shadow-sm scroll-mt-6"
    >
      <div className="space-y-3">
        <QuestionMeta question={question} />
        <div className="text-sm font-medium leading-6 text-foreground">{question.prompt}</div>
        <AnswerBlock question={question} hideAiAnswerBadge={hideAiAnswerBadge} />
      </div>
    </article>
  )
}

export function InterviewDocumentView({
  document,
  className,
  hideSummary = false,
  defaultGroupsOpen = false,
  hideAiAnswerBadge = false,
}: {
  document: InterviewDocument
  className?: string
  hideSummary?: boolean
  defaultGroupsOpen?: boolean
  hideAiAnswerBadge?: boolean
}) {
  const groups = groupInterviewDocumentQuestions(document)
  const hasSummary = !hideSummary && hasInterviewSummaryContent(document)

  return (
    <div className={cn('space-y-5', className)}>
      {hasSummary && (
        <section
          id={getInterviewSummaryAnchorId()}
          className="scroll-mt-6"
        >
          <CollapsibleSection
            title={(
              <div className="flex flex-wrap items-center gap-2">
                <div className="text-sm font-semibold text-foreground">Interview Summary</div>
                <MetaPill>Status: {document.status}</MetaPill>
                {document.generated_by.winner_model ? <MetaPill>{document.generated_by.winner_model}</MetaPill> : null}
                {document.generated_by.generated_at ? <MetaPill>{document.generated_by.generated_at}</MetaPill> : null}
              </div>
            )}
            defaultOpen
            className="rounded-2xl border border-border bg-gradient-to-br from-background via-background to-muted/40 shadow-sm"
            triggerClassName="px-4 py-4"
            contentClassName="px-4 pb-4"
          >
            <div className="space-y-3">
              <div className="grid gap-3 md:grid-cols-3">
                <SummaryList title="Goals" items={document.summary.goals} />
                <SummaryList title="Constraints" items={document.summary.constraints} />
                <SummaryList title="Non-goals" items={document.summary.non_goals} />
              </div>
              <div className="rounded-xl border border-border/70 bg-background/70 p-3">
                <div className="section-label">Final Free-Form Answer</div>
                <div className="mt-2 whitespace-pre-wrap text-sm leading-6 text-foreground">
                  {document.summary.final_free_form_answer || 'No final free-form answer recorded.'}
                </div>
              </div>
            </div>
          </CollapsibleSection>
        </section>
      )}

      {groups.map((group) => (
        <section
          key={group.id}
          id={group.anchorId}
          className="scroll-mt-6"
        >
          <CollapsibleSection
            title={
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-foreground">{group.label}</span>
                <MetaPill>{group.questions.length} question{group.questions.length === 1 ? '' : 's'}</MetaPill>
                <span className="text-xs text-muted-foreground">{group.description}</span>
              </div>
            }
            defaultOpen={defaultGroupsOpen}
          >
            <div className="space-y-3">
              {group.questions.map((question) => (
                <QuestionCard key={question.id} question={question} hideAiAnswerBadge={hideAiAnswerBadge} />
              ))}
            </div>
          </CollapsibleSection>
        </section>
      ))}

      {document.follow_up_rounds.length > 0 ? (
        <section
          id={getInterviewFollowUpsAnchorId()}
          className="scroll-mt-6"
        >
          <CollapsibleSection
            title={<div className="text-sm font-semibold text-foreground">Follow-up Rounds</div>}
            defaultOpen
            className="rounded-2xl border border-border bg-background/80 shadow-sm"
            triggerClassName="px-4 py-4"
            contentClassName="px-4 pb-4"
          >
            <div className="grid gap-3 md:grid-cols-2">
              {document.follow_up_rounds.map((round) => (
                <div key={`${round.source}-${round.round_number}`} className="rounded-xl border border-border/70 bg-muted/30 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <MetaPill>{round.source === 'coverage' ? 'Coverage' : 'PROM4'}</MetaPill>
                    <MetaPill>Round {round.round_number}</MetaPill>
                  </div>
                  <div className="mt-2 text-xs text-muted-foreground">
                    Questions: {round.question_ids.length > 0 ? round.question_ids.join(', ') : 'None recorded'}
                  </div>
                </div>
              ))}
            </div>
          </CollapsibleSection>
        </section>
      ) : null}

    </div>
  )
}
