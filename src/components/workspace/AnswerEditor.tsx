import type { InterviewQuestionStatus, InterviewQuestionAnswerType, InterviewQuestionOption } from '@shared/interviewSession'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LoadingText } from '@/components/ui/LoadingText'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ChoiceAnswerInput } from './ChoiceAnswerInput'
import { AutosaveStatus, type AutosaveStatusState } from './AutosaveStatus'
import { SkipReasonField } from './SkipReasonField'

function priorityBadgeVariant(priority: string): 'destructive' | 'default' | 'secondary' | 'outline' {
  switch (priority) {
    case 'critical': return 'destructive'
    case 'high': return 'default'
    case 'medium': return 'secondary'
    default: return 'outline'
  }
}

function statusBadgeVariant(status: InterviewQuestionStatus): 'default' | 'secondary' | 'outline' {
  switch (status) {
    case 'answered': return 'default'
    case 'skipped': return 'secondary'
    case 'current': return 'outline'
    default: return 'outline'
  }
}

export interface BatchQuestion {
  id: string
  question: string
  rationale?: string | null
  priority?: string | null
  source: string
  phase: string
  answerType?: InterviewQuestionAnswerType
  options?: InterviewQuestionOption[]
}

export interface AnswerEditorProps {
  questions: BatchQuestion[]
  batchAnswers: Record<string, string>
  batchSkipped: Set<string>
  batchSelectedOptions: Record<string, string[]>
  batchSkipReasons: Record<string, string>
  isBusy: boolean
  isSubmitting: boolean
  autosaveState: AutosaveStatusState
  lastAutosavedAt: Date | null
  allBatchAnswersFilled: boolean
  onBatchAnswer: (questionId: string, value: string) => void
  onOptionToggle: (questionId: string, optionId: string) => void
  onSkipQuestion: (questionId: string) => void
  onUnskipQuestion: (questionId: string) => void
  onSkipReasonChange: (questionId: string, reason: string) => void
  onSubmitBatch: () => void
  onShowSkipConfirm: () => void
  questionRefs: React.RefObject<Record<string, HTMLDivElement | null>>
  currentBatch: {
    source: string
    roundNumber?: number | null
    batchNumber: number
    isFinalFreeForm?: boolean
    progress: { current: number; total: number }
    aiCommentary?: string | null
  }
}

export function AnswerEditor({
  questions,
  batchAnswers,
  batchSkipped,
  batchSelectedOptions,
  batchSkipReasons,
  isBusy,
  isSubmitting,
  autosaveState,
  lastAutosavedAt,
  allBatchAnswersFilled,
  onBatchAnswer,
  onOptionToggle,
  onSkipQuestion,
  onUnskipQuestion,
  onSkipReasonChange,
  onSubmitBatch,
  onShowSkipConfirm,
  questionRefs,
  currentBatch,
}: AnswerEditorProps) {
  return (
    <>
      {currentBatch.aiCommentary && (
        <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/30 p-3">
          <p className="text-xs text-blue-700 dark:text-blue-300">{currentBatch.aiCommentary}</p>
        </div>
      )}

      <Card>
        <CardHeader className="py-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">
              {currentBatch.source === 'coverage'
                ? `Coverage Follow-up${currentBatch.roundNumber ? ` · Round ${currentBatch.roundNumber}` : ''}`
                : currentBatch.isFinalFreeForm
                  ? 'Final Question'
                  : `Interview Q&A — Batch ${currentBatch.batchNumber}`}
            </CardTitle>
            {currentBatch.progress.total > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="text-xs whitespace-nowrap cursor-default">
                    {currentBatch.progress.current}/{currentBatch.progress.total}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Interview batch {currentBatch.progress.current} of {currentBatch.progress.total} estimated
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pb-3">
          <p className="text-[11px] text-muted-foreground">
            Submit the batch when ready. Blank answers are treated as skips and preserved explicitly.
          </p>
          {questions.map((question) => {
            const isSkipped = batchSkipped.has(question.id)
            const isChoiceQ = question.answerType === 'single_choice' || question.answerType === 'multiple_choice'
            const selectedIds = batchSelectedOptions[question.id] ?? []
            return (
              <div
                key={question.id}
                ref={(node) => { questionRefs.current[question.id] = node }}
                className={`rounded-lg border p-3 space-y-2 ${isSkipped ? 'border-muted bg-muted/20 opacity-60' : 'border-border bg-accent/30'}`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] text-muted-foreground font-mono">{question.id}</span>
                  <Badge variant={isSkipped ? statusBadgeVariant('skipped') : statusBadgeVariant('current')} className="text-[10px] h-4">
                    {isSkipped ? 'skipped' : 'current'}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {question.source === 'coverage_follow_up'
                      ? 'Coverage Follow-up'
                      : question.source === 'prompt_follow_up'
                        ? 'PROM4 Follow-up'
                        : question.source === 'final_free_form'
                          ? 'Final Free-Form'
                          : question.phase}
                  </span>
                  {question.priority && (
                    <Badge variant={priorityBadgeVariant(question.priority)} className="text-[10px] h-4">
                      {question.priority}
                    </Badge>
                  )}
                  {isChoiceQ && (
                    <Badge variant="outline" className="text-[10px] h-4 font-normal">
                      {question.answerType === 'single_choice'
                        ? (question.options?.length === 2 && question.options[0]?.id === 'yes' && question.options[1]?.id === 'no'
                          ? 'yes / no'
                          : 'single choice')
                        : 'multi select'}
                    </Badge>
                  )}
                </div>
                <p className={`text-xs font-medium ${isSkipped ? 'line-through text-muted-foreground' : ''}`}>{question.question}</p>
                {question.rationale && (
                  <p className="text-[10px] text-muted-foreground italic">{question.rationale}</p>
                )}
                {isSkipped ? (
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] italic text-muted-foreground">This question will be skipped. A model answers it later, reading whatever you write below.</p>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px] px-2"
                        onClick={() => onUnskipQuestion(question.id)}
                        disabled={isBusy}
                      >
                        Undo Skip
                      </Button>
                    </div>
                    <SkipReasonField
                      label="Why skip this"
                      value={batchSkipReasons[question.id] ?? ''}
                      onChange={(value) => { onSkipReasonChange(question.id, value) }}
                      disabled={isBusy}
                      placeholder="Optional. The model answering this question gets to read it."
                      help="Saved with the interview, and given to the model that fills this answer in."
                    />
                  </div>
                ) : isChoiceQ && question.options && question.options.length > 0 ? (
                  <>
                    <ChoiceAnswerInput
                      questionId={question.id}
                      answerType={question.answerType!}
                      options={question.options}
                      selectedIds={selectedIds}
                      freeText={batchAnswers[question.id] ?? ''}
                      isBusy={isBusy}
                      onToggle={(optionId) => onOptionToggle(question.id, optionId)}
                      onTextChange={(value) => onBatchAnswer(question.id, value)}
                    />
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => onSkipQuestion(question.id)}
                        disabled={isBusy}
                      >
                        Skip Question
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <textarea
                      className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs min-h-[72px] focus:outline-none focus:ring-1 focus:ring-ring"
                      placeholder="Type your answer here."
                      value={batchAnswers[question.id] ?? ''}
                      onChange={(event) => onBatchAnswer(question.id, event.target.value)}
                      disabled={isBusy}
                    />
                    <div className="flex justify-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                        onClick={() => onSkipQuestion(question.id)}
                        disabled={isBusy}
                      >
                        Skip Question
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )
          })}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={onShowSkipConfirm}
              disabled={isBusy || questions.length === 0}
              className="h-8 text-xs"
            >
              Skip All Questions
            </Button>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <AutosaveStatus state={autosaveState} lastSavedAt={lastAutosavedAt} />
              <Button
                size="sm"
                onClick={onSubmitBatch}
                disabled={isBusy || questions.length === 0}
                className="h-8 text-xs"
              >
                {isSubmitting
                  ? <LoadingText text="Submitting" />
                  : allBatchAnswersFilled
                    ? 'Submit Answers'
                    : 'Submit Batch'}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  )
}
