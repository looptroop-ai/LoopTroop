import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, HelpCircle, TimerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useAIQuestions } from '@/context/useAIQuestions'
import type { AiQuestionInfo, AiQuestionRequest } from '@/context/aiQuestionContextDef'
import { formatAiQuestionWindow } from '@shared/aiQuestions'
import { COUNTDOWN_TICK_MS } from '@/lib/constants'
import { SkipReasonField } from './SkipReasonField'

/** Ticks once a second only while something is counting down. */
function useCountdown(active: boolean): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const interval = setInterval(() => setTick((value) => value + 1), COUNTDOWN_TICK_MS)
    return () => clearInterval(interval)
  }, [active])
  return tick
}

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** `anthropic/claude-opus-4` reads as `claude-opus-4` in a tab three across. */
function shortModelName(modelId: string | undefined): string {
  if (!modelId) return 'OpenCode'
  const slash = modelId.lastIndexOf('/')
  return slash === -1 ? modelId : modelId.slice(slash + 1)
}

/**
 * A tab label that survives a council seating the same model twice.
 *
 * Two requests can also queue on one session, so neither the model nor the
 * session is unique on its own. The last four characters of the request id are.
 */
function tabLabel(request: AiQuestionRequest, duplicated: boolean): string {
  const base = shortModelName(request.modelId)
  return duplicated ? `${base} · ${request.requestId.slice(-4)}` : base
}

function isAnswered(answer: string[] | undefined): boolean {
  return Array.isArray(answer) && answer.length > 0
}

/**
 * Whether this browser had the panel collapsed for this ticket.
 *
 * Kept per browser rather than on the ticket's UI-state channel: collapsing is a
 * viewing preference, not a property of the ticket, and it should not follow the
 * operator onto a second screen or reach anyone else looking at the same ticket.
 * Every read and write is guarded — a private window or blocked site data throws
 * on access rather than returning empty.
 */
function collapseStorageKey(ticketId: string): string {
  return `ai-questions-collapsed-${ticketId}`
}

function readCollapsed(ticketId: string): boolean {
  try {
    return window.localStorage.getItem(collapseStorageKey(ticketId)) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(ticketId: string, collapsed: boolean): void {
  try {
    if (collapsed) window.localStorage.setItem(collapseStorageKey(ticketId), '1')
    else window.localStorage.removeItem(collapseStorageKey(ticketId))
  } catch {
    // A preference that cannot be remembered is not worth failing a render for.
  }
}

/**
 * The questions a model is waiting on, at the top of the ticket.
 *
 * A panel that pushes the workspace down rather than an overlay: the old
 * full-screen box covered the logs, the phase timeline and the very artifacts
 * you would want to read before answering. Nothing here covers anything.
 *
 * One countdown, in the header, shared by every model asking in this step —
 * repeating it per tab would invite three timers on screen for one clock.
 */
export function PendingQuestionsPanel({ ticketId }: { ticketId: string }) {
  const {
    getTicketRequests,
    getTimer,
    getRemainingMs,
    answerRequest,
    skipRequest,
    stopTimer,
    refreshTicket,
  } = useAIQuestions()

  const requests = getTicketRequests(ticketId)
  const timer = getTimer(ticketId)
  const [collapsed, setCollapsed] = useState(() => readCollapsed(ticketId))
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [questionIndex, setQuestionIndex] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [skipping, setSkipping] = useState(false)
  const [skipReason, setSkipReason] = useState('')
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  // Pull once on mount: a question raised while this tab was closed would
  // otherwise wait for the next aggregate poll to appear.
  useEffect(() => { refreshTicket(ticketId) }, [refreshTicket, ticketId])

  const active = useMemo(
    () => requests.find((request) => request.requestId === activeRequestId) ?? requests[0] ?? null,
    [activeRequestId, requests],
  )

  useEffect(() => {
    if (active && active.requestId !== activeRequestId) {
      setActiveRequestId(active.requestId)
      setQuestionIndex(0)
    }
  }, [active, activeRequestId])

  const remainingMs = getRemainingMs(ticketId)
  useCountdown(remainingMs !== null)

  /**
   * Every way of engaging is the same event.
   *
   * Switching tabs, moving between questions, focusing a field, typing in one —
   * all of them mean a person is dealing with this, so all of them stop the
   * clock. The provider posts once and remembers it did.
   */
  const engage = useCallback(() => { stopTimer(ticketId) }, [stopTimer, ticketId])

  if (requests.length === 0 || !active) return null

  const question: AiQuestionInfo | undefined = active.questions[questionIndex]
  const answeredAll = active.questions.every((_, index) => isAnswered(answers[`${active.requestId}:${index}`]))
  const modelCounts = new Map<string, number>()
  for (const request of requests) {
    const name = shortModelName(request.modelId)
    modelCounts.set(name, (modelCounts.get(name) ?? 0) + 1)
  }

  const selectRequest = (requestId: string) => {
    engage()
    setActiveRequestId(requestId)
    setQuestionIndex(0)
    setSkipping(false)
    // A reason written for one model's question must not follow you to another
    // model's tab and end up filed against a question it was never about.
    setSkipReason('')
  }

  const moveQuestion = (delta: number) => {
    engage()
    setQuestionIndex((index) => Math.min(active.questions.length - 1, Math.max(0, index + delta)))
  }

  const setAnswer = (value: string[]) => {
    engage()
    setAnswers((current) => ({ ...current, [`${active.requestId}:${questionIndex}`]: value }))
  }

  const submit = () => {
    answerRequest(
      ticketId,
      active.requestId,
      active.questions.map((_, index) => answers[`${active.requestId}:${index}`] ?? []),
    )
  }

  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = requests.length - 1
    const target = event.key === 'ArrowRight'
      ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft'
        ? (index === 0 ? last : index - 1)
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : null
    if (target === null) return
    event.preventDefault()
    const next = requests[target]
    if (next) {
      selectRequest(next.requestId)
      tabRefs.current[target]?.focus()
    }
  }

  return (
    <section
      className={cn(
        'shrink-0 border-b border-sky-200 bg-sky-50/70 dark:border-sky-900/60 dark:bg-sky-950/30',
        !collapsed && 'max-h-[35vh] overflow-y-auto',
      )}
      aria-label="AI questions"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex items-center gap-1.5 text-sm font-medium text-sky-900 dark:text-sky-100"
          onClick={() => setCollapsed((value) => {
            writeCollapsed(ticketId, !value)
            return !value
          })}
          aria-expanded={!collapsed}
          aria-controls="pending-questions-body"
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          <HelpCircle className="h-4 w-4" aria-hidden />
          {requests.length === 1 ? shortModelName(active.modelId) : 'AI questions'}
        </button>

        <Badge variant="outline" className="text-[11px]">
          {requests.reduce((total, request) => total + request.questions.length, 0)} waiting
        </Badge>

        {/* Not a live region. A countdown inside one is read out every second —
            "four fifty-nine, four fifty-eight" — which buries the thing a
            screen-reader user actually needs to hear. The announcements live in
            the status line below, which changes only when the state does. */}
        <div className="ml-auto flex items-center gap-2">
          {remainingMs === null ? (
            <span className="text-xs text-sky-900/80 dark:text-sky-200/80">
              {timer ? 'Waiting for you' : 'No time limit running'}
            </span>
          ) : (
            <>
              <span
                className="tabular-nums text-sm font-medium text-sky-900 dark:text-sky-100"
                aria-label={`${formatRemaining(remainingMs)} left to answer`}
              >
                {formatRemaining(remainingMs)}
              </span>
              <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={engage}>
                <TimerOff className="h-3.5 w-3.5" />
                Stop timer
              </Button>
            </>
          )}
        </div>
      </div>

      {!collapsed && (
        <div id="pending-questions-body" className="px-3 pb-3">
          {requests.length > 1 && (
            <div role="tablist" aria-label="Models asking" className="mb-3 flex flex-wrap gap-1">
              {requests.map((request, index) => {
                const selected = request.requestId === active.requestId
                return (
                  <button
                    key={`${request.sessionId}:${request.requestId}`}
                    ref={(node) => { tabRefs.current[index] = node }}
                    type="button"
                    role="tab"
                    id={`question-tab-${request.requestId}`}
                    aria-selected={selected}
                    aria-controls={`question-panel-${request.requestId}`}
                    tabIndex={selected ? 0 : -1}
                    onKeyDown={(event) => onTabKeyDown(event, index)}
                    onClick={() => selectRequest(request.requestId)}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs transition-colors',
                      selected
                        ? 'border-sky-400 bg-sky-100 text-sky-900 dark:border-sky-700 dark:bg-sky-900/50 dark:text-sky-100'
                        : 'border-border text-muted-foreground hover:bg-muted/60',
                    )}
                  >
                    {tabLabel(request, (modelCounts.get(shortModelName(request.modelId)) ?? 0) > 1)}
                    {' · '}
                    {request.questions.length}
                  </button>
                )
              })}
            </div>
          )}

          <div
            role={requests.length > 1 ? 'tabpanel' : undefined}
            id={`question-panel-${active.requestId}`}
            aria-labelledby={requests.length > 1 ? `question-tab-${active.requestId}` : undefined}
          >
            {active.questions.length > 1 && (
              <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Button type="button" size="sm" variant="ghost" disabled={questionIndex === 0} onClick={() => moveQuestion(-1)}>
                  Previous
                </Button>
                <span>{questionIndex + 1} of {active.questions.length}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={questionIndex === active.questions.length - 1}
                  onClick={() => moveQuestion(1)}
                >
                  Next
                </Button>
              </div>
            )}

            {question && (
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-foreground">{question.header}</h3>
                  {/* Plain text, never markdown and never innerHTML: the model wrote this string. */}
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-foreground">{question.question}</p>
                </div>

                <QuestionAnswerInput
                  key={`${active.requestId}:${questionIndex}`}
                  question={question}
                  value={answers[`${active.requestId}:${questionIndex}`] ?? []}
                  disabled={active.submitting}
                  onChange={setAnswer}
                  onEngage={engage}
                />
              </div>
            )}

            {active.error && (
              <p className="mt-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {active.error}
              </p>
            )}

            {skipping && (
              <div className="mt-3 space-y-2">
                <SkipReasonField
                  value={skipReason}
                  onChange={(value) => { engage(); setSkipReason(value) }}
                  disabled={active.submitting}
                  label="Skip reason"
                  help={active.questions.length > 1
                    ? `Skipping refuses all ${active.questions.length} questions in this request — OpenCode takes one verdict for the batch. Kept in the ticket's skip trail; the model is not told.`
                    : "Kept in the ticket's skip trail. The model is not told."}
                  autoFocus
                />
              </div>
            )}

            <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
              {skipping ? (
                <>
                  <Button type="button" size="sm" variant="ghost" disabled={active.submitting} onClick={() => setSkipping(false)}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={active.submitting}
                    onClick={() => skipRequest(ticketId, active.requestId, skipReason.trim() || null)}
                  >
                    {active.questions.length > 1 ? 'Skip all questions' : 'Skip this question'}
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={active.submitting}
                    onClick={() => { engage(); setSkipping(true) }}
                  >
                    Skip
                  </Button>
                  <Button type="button" size="sm" disabled={active.submitting || !answeredAll} onClick={submit}>
                    {active.questions.length > 1 ? 'Send all answers' : 'Send answer'}
                  </Button>
                </>
              )}
            </div>

            {timer && (
              // The one live region on the panel. It says what the clock is
              // doing, not what it currently reads, so it fires on arrival and
              // on stop rather than once a second.
              <p className="mt-2 text-[11px] text-muted-foreground" role="status" aria-live="polite">
                {timer.stoppedAt
                  ? 'The countdown is stopped. This step waits until you answer or skip.'
                  : `Unanswered after ${formatAiQuestionWindow(timer.windowMs)}, the question is refused and the run carries on.`}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

/**
 * Radio buttons, checkboxes and free text, per what the model asked for.
 *
 * Options are keyed by index rather than by label because a model can repeat a
 * label across a batch, and the submitted answer is the selected labels *plus*
 * the free text — not free text replacing the selection.
 *
 * The free text is held here rather than derived back out of `value`. Deriving
 * it meant round-tripping every keystroke through a trim, which deleted the
 * space the moment you typed one and made multi-word answers impossible to
 * enter; it also misread free text that happened to match an option label as a
 * selection. Local state keeps what was typed exactly as it was typed, and the
 * trim happens once, on the way out.
 */
function QuestionAnswerInput({
  question,
  value,
  disabled,
  onChange,
  onEngage,
}: {
  question: AiQuestionInfo
  value: string[]
  disabled: boolean
  onChange: (value: string[]) => void
  onEngage: () => void
}) {
  const fieldId = useId()
  const multiple = question.multiple === true
  const allowsCustom = question.custom !== false
  const optionLabels = useMemo(
    () => new Set(question.options.map((option) => option.label)),
    [question.options],
  )
  const selected = value.filter((entry) => optionLabels.has(entry))
  // Seeded once. The component is remounted per question by its `key`, so a
  // draft restored from `value` is picked up on mount and never fought over.
  const [custom, setCustom] = useState(
    () => value.find((entry) => !optionLabels.has(entry)) ?? '',
  )

  const emit = (nextSelected: string[], nextCustom: string) => {
    onChange([...nextSelected, nextCustom.trim()].filter(Boolean))
  }

  const toggle = (label: string) => {
    const next = multiple
      ? (selected.includes(label) ? selected.filter((entry) => entry !== label) : [...selected, label])
      : (selected.includes(label) ? [] : [label])
    emit(next, custom)
  }

  return (
    <div className="space-y-2">
      {question.options.length > 0 && (
        <div role={multiple ? 'group' : 'radiogroup'} aria-label="Answer options" className="space-y-1.5">
          {question.options.map((option, index) => {
            const checked = selected.includes(option.label)
            // Keyed by index, not by label: a model can repeat a label in one batch.
            const inputId = `${fieldId}-option-${index}`
            const describedBy = option.description ? `${inputId}-description` : undefined
            return (
              <div
                key={`${index}:${option.label}`}
                className={cn(
                  'flex items-start gap-2.5 rounded-md border p-2.5 text-sm transition-colors',
                  checked ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50',
                  disabled && 'opacity-50',
                )}
              >
                <input
                  id={inputId}
                  type={multiple ? 'checkbox' : 'radio'}
                  name={`${fieldId}-options`}
                  className="mt-1 accent-primary"
                  checked={checked}
                  disabled={disabled}
                  onFocus={onEngage}
                  onChange={() => toggle(option.label)}
                  {...(describedBy ? { 'aria-describedby': describedBy } : {})}
                />
                <span className="min-w-0">
                  {/* The option's own words are its name; the model's gloss on it
                      is a description, so a screen reader announces the choice
                      before the rationale rather than as one run-on phrase. */}
                  <label htmlFor={inputId} className="block cursor-pointer font-medium text-foreground">
                    {option.label}
                  </label>
                  {option.description && (
                    <span
                      id={describedBy}
                      className="block whitespace-pre-wrap text-xs leading-5 text-muted-foreground"
                    >
                      {option.description}
                    </span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {allowsCustom && (
        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">
            {question.options.length > 0 ? 'Anything to add (optional)' : 'Your answer'}
          </span>
          <textarea
            value={custom}
            disabled={disabled}
            onFocus={onEngage}
            onChange={(event) => {
              setCustom(event.target.value)
              emit(selected, event.target.value)
            }}
            rows={2}
            className="w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </label>
      )}
    </div>
  )
}
