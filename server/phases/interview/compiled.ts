import { extractInterviewQuestionPreviews } from '@shared/interviewQuestions'
import { isRecord } from '@shared/typeGuards'
import type { ParsedInterviewQuestion } from './questions'
import { normalizeInterviewRefinementOutput, type StructuredOutputMetadata } from '../../structuredOutput'
import { normalizeStructuredOutputMetadata } from '../../structuredOutput/metadata'

export interface CompiledInterviewArtifact {
  winnerId: string
  refinedContent: string
  questions: ParsedInterviewQuestion[]
  questionCount: number
  structuredOutput?: StructuredOutputMetadata
}

function formatArtifactPhase(phase: string): string {
  const normalized = phase.trim().toLowerCase()
  if (normalized === 'foundation') return 'Foundation'
  if (normalized === 'structure') return 'Structure'
  if (normalized === 'assembly') return 'Assembly'
  return phase.trim()
}

function normalizeArtifactQuestion(value: unknown, index: number): ParsedInterviewQuestion {
  if (!isRecord(value)) {
    throw new Error(`Compiled interview question at index ${index} is not an object`)
  }

  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const phase = typeof value.phase === 'string' ? formatArtifactPhase(value.phase) : ''
  const question = typeof value.question === 'string' ? value.question.trim() : ''

  if (!id) throw new Error(`Compiled interview question at index ${index} is missing id`)
  if (!phase) throw new Error(`Compiled interview question at index ${index} is missing phase`)
  if (!question) throw new Error(`Compiled interview question at index ${index} is missing question text`)

  return { id, phase, question }
}


export function buildCompiledInterviewArtifact(
  winnerId: string,
  refinementOutput: string,
  winnerDraftContent: string,
  maxInitialQuestions: number,
  losingDraftMeta?: Array<{ memberId: string; content: string }>,
): CompiledInterviewArtifact {
  const normalizedWinnerId = winnerId.trim()
  if (!normalizedWinnerId) {
    throw new Error('Compiled interview artifact is missing a winner model id')
  }

  const refinement = normalizeInterviewRefinementOutput(
    refinementOutput,
    winnerDraftContent,
    maxInitialQuestions,
    losingDraftMeta,
    // The refinement was already validated and its changes recorded before this
    // runs; what arrives here is the canonical questions-only YAML.
    { missingChangesPolicy: 'accounted_elsewhere' },
  )
  if (!refinement.ok) {
    throw new Error(refinement.error)
  }

  if (refinement.value.questionCount <= 0) {
    throw new Error('PROM3 refinement produced zero questions')
  }

  return {
    winnerId: normalizedWinnerId,
    refinedContent: refinement.value.questionsYaml.trim(),
    questions: refinement.value.questions.map((question) => ({
      id: question.id,
      phase: formatArtifactPhase(question.phase),
      question: question.question,
    })),
    questionCount: refinement.value.questionCount,
  }
}

export function parseCompiledInterviewArtifact(content: string): CompiledInterviewArtifact {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('Compiled interview artifact is not valid JSON')
  }

  if (!isRecord(parsed)) {
    throw new Error('Compiled interview artifact payload is invalid')
  }

  const winnerId = typeof parsed.winnerId === 'string' ? parsed.winnerId.trim() : ''
  const refinedContent = typeof parsed.refinedContent === 'string' ? parsed.refinedContent : ''
  const rawQuestions = parsed.questions
  const rawQuestionCount = parsed.questionCount
  const structuredOutput = normalizeStructuredOutputMetadata(parsed.structuredOutput)
  if (!refinedContent.trim()) {
    throw new Error('Compiled interview artifact is missing refinedContent')
  }

  const questions = Array.isArray(rawQuestions)
    ? rawQuestions.map((question, index) => normalizeArtifactQuestion(question, index))
    : extractInterviewQuestionPreviews(refinedContent).map((question, index) => ({
        id: question.id || `Q${String(index + 1).padStart(2, '0')}`,
        phase: formatArtifactPhase(question.phase || 'Foundation'),
        question: question.question,
      }))
  const questionCount = typeof rawQuestionCount === 'number' ? rawQuestionCount : questions.length

  if (!Number.isInteger(questionCount) || questionCount <= 0) {
    throw new Error('Compiled interview artifact has an invalid questionCount')
  }
  if (questions.length === 0) {
    throw new Error('Compiled interview artifact contains zero questions')
  }
  if (questionCount !== questions.length) {
    throw new Error('Compiled interview artifact questionCount does not match questions length')
  }

  return {
    winnerId,
    refinedContent,
    questions,
    questionCount,
    structuredOutput,
  }
}

export function requireCompiledInterviewArtifact(content: string | null | undefined): CompiledInterviewArtifact {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('No validated compiled interview found')
  }

  return parseCompiledInterviewArtifact(content)
}
