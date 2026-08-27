import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ChoiceAnswerInput } from './ChoiceAnswerInput'
import { CollapsibleSection } from './ArtifactContentViewer'
import type { InterviewDocument } from '@shared/interviewArtifact'
import type { InterviewAnswerUpdate } from '@shared/interviewArtifact'
import { groupInterviewDocumentQuestions } from '@/lib/interviewDocument'
import { SkipReasonField } from './SkipReasonField'

interface InterviewApprovalAnswerEditorProps {
  document: InterviewDocument
  drafts: Record<string, InterviewAnswerUpdate['answer']>
  disabled?: boolean
  hideSummary?: boolean
  onAnswerChange: (questionId: string, answer: InterviewAnswerUpdate['answer']) => void
}

function isChoiceQuestion(answerType: string): boolean {
  return answerType === 'single_choice' || answerType === 'multiple_choice'
}

function ReadOnlySummary({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-border/70 bg-background/70 p-3">
      <div className="section-label">{title}</div>
      {items.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {items.map((item) => (
            <span key={item} className="rounded-full border border-border bg-muted/30 px-2 py-1 text-[11px] text-foreground">
              {item}
            </span>
          ))}
        </div>
      ) : (
        <div className="mt-2 text-xs text-muted-foreground">No items recorded.</div>
      )}
    </div>
  )
}

export function InterviewApprovalAnswerEditor({
  document,
  drafts,
  disabled = false,
  hideSummary = false,
  onAnswerChange,
}: InterviewApprovalAnswerEditorProps) {
  const groups = groupInterviewDocumentQuestions(document)

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4 text-sm text-blue-950 dark:border-blue-900/60 dark:bg-blue-950/20 dark:text-blue-100">
        <div className="font-semibold">Answer-only editor</div>
        <p className="mt-1 text-xs leading-5 text-blue-900/80 dark:text-blue-200/90">
          This mode only changes recorded answers. Summary lists, metadata, follow-up structure, and approval fields stay protected here.
          Use the YAML tab only if you need a full-power edit.
        </p>
      </div>

      {!hideSummary && (
        <div className="grid gap-3 md:grid-cols-3">
          <ReadOnlySummary title="Goals" items={document.summary.goals} />
          <ReadOnlySummary title="Constraints" items={document.summary.constraints} />
          <ReadOnlySummary title="Non-goals" items={document.summary.non_goals} />
        </div>
      )}

      {groups.map((group) => (
        <CollapsibleSection
          key={group.id}
          title={
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-foreground">{group.label}</span>
              <Badge variant="outline" className="text-[10px]">
                {group.questions.length} question{group.questions.length === 1 ? '' : 's'}
              </Badge>
              <span className="text-xs text-muted-foreground">{group.description}</span>
            </div>
          }
          defaultOpen={false}
        >
          <div className="space-y-3">
            {group.questions.map((question) => {
              const draft = drafts[question.id] ?? {
                skipped: question.answer.skipped,
                selected_option_ids: question.answer.selected_option_ids,
                free_text: question.answer.free_text,
                // Without this the reason box renders empty for a stored reason,
                // and editing the answer writes that emptiness back.
                skip_reason: question.answer.skip_reason,
              }
              const choiceQuestion = isChoiceQuestion(question.answer_type)

              return (
                <div key={question.id} className="rounded-xl border border-border bg-background/85 p-4 shadow-sm">
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="font-mono text-[10px]">{question.id}</Badge>
                      <Badge variant="outline" className="text-[10px] capitalize">{question.answer_type.replace(/_/g, ' ')}</Badge>
                      {draft.skipped ? (
                        <Badge variant="secondary" className="text-[10px]">Skipped</Badge>
                      ) : (
                        <Badge variant="default" className="text-[10px]">Answered</Badge>
                      )}
                    </div>

                    <div className="text-sm font-medium leading-6 text-foreground">{question.prompt}</div>

                    {draft.skipped ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-3 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-100">
                        <div>This answer is currently marked as skipped.</div>
                        <div className="mt-3">
                          <SkipReasonField
                            label="Why skip this"
                            value={draft.skip_reason ?? ''}
                            onChange={(value) => { onAnswerChange(question.id, {
                              skipped: true,
                              selected_option_ids: [],
                              free_text: '',
                              skip_reason: value,
                            }) }}
                            disabled={disabled}
                            placeholder="Optional. The model answering this question gets to read it."
                            help="Saved with the interview, and given to the model that fills this answer in."
                          />
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          disabled={disabled}
                          onClick={() => onAnswerChange(question.id, {
                            skipped: false,
                            selected_option_ids: draft.selected_option_ids,
                            free_text: draft.free_text,
                            // Answering it means the reason no longer describes anything.
                            skip_reason: null,
                          })}
                        >
                          Answer This Question
                        </Button>
                      </div>
                    ) : choiceQuestion ? (
                      <div className="space-y-3">
                        <ChoiceAnswerInput
                          questionId={question.id}
                          answerType={question.answer_type}
                          options={question.options}
                          selectedIds={draft.selected_option_ids}
                          freeText={draft.free_text}
                          isBusy={disabled}
                          onToggle={(optionId) => {
                            const isSingleChoice = question.answer_type === 'single_choice'
                            const selectedOptionIds = isSingleChoice
                              ? [optionId]
                              : draft.selected_option_ids.includes(optionId)
                                ? draft.selected_option_ids.filter((selectedId) => selectedId !== optionId)
                                : [...draft.selected_option_ids, optionId]

                            onAnswerChange(question.id, {
                              skipped: false,
                              selected_option_ids: selectedOptionIds,
                              free_text: draft.free_text,
                              skip_reason: null,
                            })
                          }}
                          onTextChange={(value) => onAnswerChange(question.id, {
                            skipped: false,
                            selected_option_ids: draft.selected_option_ids,
                            free_text: value,
                            skip_reason: null,
                          })}
                        />
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={disabled}
                            onClick={() => onAnswerChange(question.id, {
                              skipped: true,
                              selected_option_ids: [],
                              free_text: '',
                              skip_reason: draft.skip_reason ?? null,
                            })}
                          >
                            Mark As Skipped
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <textarea
                          value={draft.free_text}
                          disabled={disabled}
                          onChange={(event) => onAnswerChange(question.id, {
                            skipped: false,
                            selected_option_ids: [],
                            free_text: event.target.value,
                            skip_reason: null,
                          })}
                          rows={4}
                          className="min-h-[120px] w-full rounded-lg border border-input bg-background px-3 py-2 text-sm leading-6 focus:outline-none focus:ring-1 focus:ring-ring"
                          placeholder="Update the recorded answer."
                        />
                        <div className="flex justify-end">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={disabled}
                            onClick={() => onAnswerChange(question.id, {
                              skipped: true,
                              selected_option_ids: [],
                              free_text: '',
                              skip_reason: draft.skip_reason ?? null,
                            })}
                          >
                            Mark As Skipped
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </CollapsibleSection>
      ))}
    </div>
  )
}
