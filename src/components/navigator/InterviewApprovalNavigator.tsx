import { ScrollArea } from '@/components/ui/scroll-area'
import { Badge } from '@/components/ui/badge'
import { useInterviewQuestions } from '@/hooks/useTickets'
import {
  getInterviewFollowUpsAnchorId,
  getInterviewQuestionAnchorId,
  getInterviewSummaryAnchorId,
  hasInterviewSummaryContent,
  groupInterviewDocumentQuestions,
  INTERVIEW_APPROVAL_FOCUS_EVENT,
  normalizeInterviewDocumentLike,
  parseInterviewDocument,
} from '@/lib/interviewDocument'
import type { InterviewDocument } from '@shared/interviewArtifact'
import { QueryErrorNotice } from '@/components/shared/QueryErrorNotice'

function focusApprovalAnchor(ticketId: string, anchorId: string) {
  window.dispatchEvent(new CustomEvent(INTERVIEW_APPROVAL_FOCUS_EVENT, {
    detail: { ticketId, anchorId },
  }))
}

const OUTLINE_BUTTON_CLASS = 'w-full rounded-md border border-border/70 bg-background px-2 py-2 text-left hover:bg-accent/40 transition-colors'

/**
 * The outline itself, split out from the navigator.
 *
 * The navigator's job is choosing between loading, failed, not-ready and ready;
 * this is the ready case. They were one function, and adding the failed branch
 * pushed its cognitive complexity past what the analyser allows — which is a
 * fair reading: four states and three levels of nested list were being read at
 * once.
 */
function InterviewOutline({ ticketId, document }: { ticketId: string; document: InterviewDocument }) {
  const groups = groupInterviewDocumentQuestions(document)

  return (
    <>
      {hasInterviewSummaryContent(document) ? (
        <button
          type="button"
          onClick={() => focusApprovalAnchor(ticketId, getInterviewSummaryAnchorId())}
          className={OUTLINE_BUTTON_CLASS}
        >
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium">Summary</span>
            <Badge variant="outline" className="h-4 text-[10px]">{document.status}</Badge>
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            Goals, constraints, non-goals, and the final free-form answer.
          </div>
        </button>
      ) : null}

      {groups.map((group) => (
        <div key={group.id} className="space-y-1">
          <button
            type="button"
            onClick={() => focusApprovalAnchor(ticketId, group.anchorId)}
            className={OUTLINE_BUTTON_CLASS}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium">{group.label}</span>
              <Badge variant="outline" className="h-4 text-[10px]">
                {group.questions.length}
              </Badge>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">{group.description}</div>
          </button>

          <div className="space-y-1 pl-2">
            {group.questions.map((question) => (
              <button
                key={question.id}
                type="button"
                onClick={() => focusApprovalAnchor(ticketId, getInterviewQuestionAnchorId(question.id))}
                className="w-full rounded-md border border-border/60 bg-muted/20 px-2 py-2 text-left hover:bg-accent/30 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">{question.id}</span>
                  <Badge variant={question.answer.skipped ? 'secondary' : 'outline'} className="h-4 text-[10px]">
                    {question.answer.skipped ? 'skip' : 'answer'}
                  </Badge>
                </div>
                <div className="mt-1 text-xs leading-snug text-foreground/90">{question.prompt}</div>
              </button>
            ))}
          </div>
        </div>
      ))}

      {document.follow_up_rounds.length > 0 ? (
        <button
          type="button"
          onClick={() => focusApprovalAnchor(ticketId, getInterviewFollowUpsAnchorId())}
          className={OUTLINE_BUTTON_CLASS}
        >
          <div className="text-xs font-medium">Follow-up Rounds</div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {document.follow_up_rounds.length} round{document.follow_up_rounds.length === 1 ? '' : 's'} of PROM4 or coverage follow-ups.
          </div>
        </button>
      ) : null}
    </>
  )
}

export function InterviewApprovalNavigator({ ticketId }: { ticketId: string }) {
  const { data, isLoading, isError, error, refetch } = useInterviewQuestions(ticketId)
  const document = normalizeInterviewDocumentLike(data?.document) ?? parseInterviewDocument(data?.raw)

  return (
    <div className="p-2">
      <div className="px-2 pb-2 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        Interview Results
      </div>
      <ScrollArea className="max-h-[280px]">
        <div className="space-y-3 pr-2">
          {isLoading ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Loading interview results…</div>
          ) : isError ? (
            <QueryErrorNotice
              title="The interview results could not be loaded."
              error={error}
              onRetry={() => void refetch()}
            />
          ) : !document ? (
            <div className="px-2 py-1 text-xs text-muted-foreground">Interview results will appear once the canonical artifact is ready.</div>
          ) : (
            <InterviewOutline ticketId={ticketId} document={document} />
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
