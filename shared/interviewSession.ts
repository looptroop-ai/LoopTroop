export type InterviewBatchSource = 'prom4' | 'coverage'

export type InterviewQuestionSource =
  | 'compiled'
  | 'prompt_follow_up'
  | 'coverage_follow_up'
  | 'final_free_form'

export type InterviewQuestionAnswerType = 'free_text' | 'single_choice' | 'multiple_choice'

export interface InterviewQuestionOption {
  id: string
  label: string
}

export interface InterviewSessionQuestion {
  id: string
  question: string
  phase: string
  priority?: string
  rationale?: string
  source: InterviewQuestionSource
  roundNumber?: number
  answerType?: InterviewQuestionAnswerType
  options?: InterviewQuestionOption[]
}

export interface InterviewSessionAnswer {
  answer: string
  skipped: boolean
  answeredAt: string | null
  batchNumber: number | null
  selectedOptionIds?: string[]
  /**
   * Why the person skipped this question, captured at the moment the batch was
   * committed. Carried into `interview.yaml` when the canonical document is
   * built; the append-only receipt keeps the history separately.
   */
  skipReason?: string | null
  /**
   * When the skip was committed. Separate from `answeredAt`, which stays null
   * for a skip, so that "skipped at 10:14" and "answered at 10:14" cannot be
   * confused for one another.
   */
  skippedAt?: string | null
}

export interface PersistedInterviewBatch {
  questions: InterviewSessionQuestion[]
  progress: { current: number; total: number }
  isComplete: boolean
  isFinalFreeForm: boolean
  aiCommentary: string
  finalYaml?: string
  batchNumber: number
  source: InterviewBatchSource
  roundNumber?: number
}

export interface InterviewBatchHistoryEntry {
  batchNumber: number
  source: InterviewBatchSource
  roundNumber?: number
  questionIds: string[]
  isFinalFreeForm: boolean
  submittedAt: string
}

export interface InterviewFollowUpRound {
  roundNumber: number
  source: InterviewBatchSource
  questionIds: string[]
}

export interface InterviewSessionSnapshot {
  schemaVersion: 1
  winnerId: string
  maxInitialQuestions: number
  maxFollowUps: number
  questions: InterviewSessionQuestion[]
  answers: Record<string, InterviewSessionAnswer>
  currentBatch: PersistedInterviewBatch | null
  batchHistory: InterviewBatchHistoryEntry[]
  followUpRounds: InterviewFollowUpRound[]
  rawFinalYaml: string | null
  completedAt: string | null
  updatedAt: string
}

export type InterviewQuestionStatus = 'answered' | 'skipped' | 'current' | 'pending'

export interface InterviewQuestionView extends InterviewSessionQuestion {
  status: InterviewQuestionStatus
  answer: string | null
  selectedOptionIds?: string[]
}

export interface InterviewSessionView {
  winnerId: string | null
  raw: string | null
  contentSha256?: string | null
  document?: import('./interviewArtifact').InterviewDocument | null
  session: InterviewSessionSnapshot | null
  questions: InterviewQuestionView[]
}
