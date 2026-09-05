import type { InterviewQuestionView, InterviewQuestionStatus } from '@shared/interviewSession'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { LoadingText } from '@/components/ui/LoadingText'

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

export interface QuestionListProps {
  historyGroups: [string, InterviewQuestionView[]][]
  showHistory: boolean
  onToggleHistory: () => void
  editingQuestionId: string | null
  editingText: string
  isEditingAnswer: boolean
  /** Why the last edit of the open answer failed, if it did. */
  editError: string | null
  onEditingTextChange: (text: string) => void
  onStartEdit: (questionId: string, currentAnswer: string) => void
  onCancelEdit: () => void
  onSaveEdit: () => void
  questionRefs: React.RefObject<Record<string, HTMLDivElement | null>>
}

export function QuestionList({
  historyGroups,
  showHistory,
  onToggleHistory,
  editingQuestionId,
  editingText,
  isEditingAnswer,
  editError,
  onEditingTextChange,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  questionRefs,
}: QuestionListProps) {
  if (historyGroups.length === 0) return null

  return (
    <div className="rounded-lg border border-border/70 bg-muted/10 p-3">
      <button
        onClick={onToggleHistory}
        className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
      >
        {showHistory ? '▼' : '▶'} Interview History ({historyGroups.reduce((sum, [, items]) => sum + items.length, 0)})
      </button>
      {showHistory && (
        <div className="mt-3 space-y-4">
          {historyGroups.map(([label, items]) => (
            <div key={label} className="space-y-2">
              <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
              {items.map((question) => {
                const isEditing = editingQuestionId === question.id
                return (
                  <div
                    key={question.id}
                    ref={(node) => { questionRefs.current[question.id] = node }}
                    className="rounded-lg border border-border bg-background p-3 space-y-2"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] text-muted-foreground font-mono">{question.id}</span>
                      <Badge variant={statusBadgeVariant(question.status)} className="text-[10px] h-4">
                        {question.status}
                      </Badge>
                      {question.priority && (
                        <Badge variant={priorityBadgeVariant(question.priority)} className="text-[10px] h-4">
                          {question.priority}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs font-medium">{question.question}</p>
                    {question.rationale && (
                      <p className="text-[10px] text-muted-foreground italic">{question.rationale}</p>
                    )}
                    {isEditing ? (
                      <div className="space-y-2">
                        <textarea
                          className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs min-h-[72px] focus:outline-none focus:ring-1 focus:ring-ring"
                          value={editingText}
                          onChange={(e) => onEditingTextChange(e.target.value)}
                          disabled={isEditingAnswer}
                          autoFocus
                        />
                        <div className="flex justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] px-2"
                            onClick={onCancelEdit}
                            disabled={isEditingAnswer}
                          >
                            Cancel
                          </Button>
                          <Button
                            size="sm"
                            className="h-6 text-[10px] px-2"
                            onClick={onSaveEdit}
                            disabled={isEditingAnswer}
                          >
                            {isEditingAnswer ? <LoadingText text="Saving" /> : 'Save'}
                          </Button>
                        </div>
                        {editError && (
                          <p role="alert" className="text-[11px] text-destructive">{editError}</p>
                        )}
                      </div>
                    ) : (
                      <>
                        {question.status === 'skipped'
                          ? (
                            <div className="space-y-1">
                              <p className="text-[11px] italic text-muted-foreground">Skipped</p>
                              {question.skipReason && (
                                <p className="text-[11px] whitespace-pre-wrap text-muted-foreground">
                                  <span className="font-medium">Why you skipped it:</span> {question.skipReason}
                                </p>
                              )}
                            </div>
                          )
                          : (
                            <div className="space-y-1">
                              {question.selectedOptionIds && question.selectedOptionIds.length > 0 && (
                                <div className="flex flex-wrap gap-1">
                                  {question.selectedOptionIds.map((id) => {
                                    const label = question.options?.find((opt) => opt.id === id)?.label ?? id
                                    return (
                                      <span key={id} className="inline-flex items-center px-2 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                                        {label}
                                      </span>
                                    )
                                  })}
                                </div>
                              )}
                              {question.answer && <p className="text-xs whitespace-pre-wrap text-foreground/90">{question.answer}</p>}
                            </div>
                          )}
                        <div className="flex justify-end">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-[10px] px-2 text-muted-foreground hover:text-foreground"
                            onClick={() => onStartEdit(question.id, question.answer ?? '')}
                            disabled={isEditingAnswer}
                          >
                            Edit
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
