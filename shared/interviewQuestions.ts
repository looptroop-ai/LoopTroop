import * as jsYaml from 'js-yaml'
import { repairYamlIndentation, repairYamlInlineKeys, repairYamlInlineSequenceParents, repairYamlListDashSpace, repairYamlSequenceEntryIndent } from './yamlRepair'
import { getErrorMessage, isRecord } from './typeGuards'
import { stripTranscriptLinePrefix, stripTranscriptPrefixes } from './transcriptPrefix'

export interface InterviewQuestionPreview {
  id?: string
  phase?: string
  question: string
}

export interface ParsedInterviewQuestion {
  id: string
  phase: string
  question: string
}

export type InterviewQuestionChangeType = 'modified' | 'replaced' | 'added' | 'removed'
export type InterviewQuestionChangeAttributionStatus =
  | 'inspired'
  | 'model_unattributed'
  | 'synthesized_unattributed'
  | 'invalid_unattributed'

export interface InspirationSource {
  draftIndex: number
  memberId: string
  question: InterviewQuestionPreview
}

export interface InterviewQuestionChange {
  type: InterviewQuestionChangeType
  before?: ParsedInterviewQuestion | null
  after?: ParsedInterviewQuestion | null
  inspiration?: InspirationSource | null
  attributionStatus?: InterviewQuestionChangeAttributionStatus
}

export interface ParseInterviewQuestionsOptions {
  allowTopLevelArray?: boolean
  /**
   * Called when the candidate only parsed after `repairInterviewCandidate` ran.
   * Callers report a repair to the operator; without this they had to guess by
   * running the same repairs themselves and comparing strings, which reported a
   * repair whether or not the parser needed it.
   */
  onCandidateRepairApplied?: () => void
}

interface StructuredQuestionExtractionOptions extends ParseInterviewQuestionsOptions {
  strictStructuredCollection?: boolean
}

class MalformedStructuredQuestionCollectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedStructuredQuestionCollectionError'
  }
}

const QUESTION_COLLECTION_KEYS = new Set([
  'questions',
  'questionlist',
  'questionitems',
  'interviewquestions',
  'interviewquestionlist',
  'items',
])

const ID_FIELD_KEYS = ['id', 'questionid', 'qid', 'key']
const PHASE_FIELD_KEYS = ['phase', 'category', 'section', 'stage']
const QUESTION_FIELD_KEYS = ['question', 'prompt', 'text', 'content']
const PHASE_HEADING_PATTERN = /^(?:#{1,6}\s*|\*{1,2})\s*(foundation|structure|assembly)\s*(?:\*{1,2})?\s*:?\s*$/i
const INLINE_PHASE_PATTERN = /^\[([^\]]+)\]\s*/
const INLINE_ID_PATTERN = /^(?:question\s*)?(q?\d+)\s*[:.)-]\s*/i

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z]/g, '')
}

function normalizePhaseValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined

  const normalized = normalizeKey(trimmed)
  if (normalized === 'foundation') return 'Foundation'
  if (normalized === 'structure') return 'Structure'
  if (normalized === 'assembly') return 'Assembly'
  return trimmed
}

function addCandidate(candidates: string[], seen: Set<string>, candidate: string | null | undefined) {
  const normalized = candidate?.trim()
  if (!normalized || seen.has(normalized)) return
  seen.add(normalized)
  candidates.push(normalized)
}

function getInterviewContentCandidates(content: string): string[] {
  const trimmed = content.trim()
  if (!trimmed) return []

  const candidates: string[] = []
  const seen = new Set<string>()
  const stripped = stripTranscriptPrefixes(trimmed).trim()

  addCandidate(candidates, seen, stripped)
  addCandidate(candidates, seen, trimmed)

  for (const source of [stripped, trimmed]) {
    const fencedMatches = source.matchAll(/```(?:yaml|yml)?\s*([\s\S]*?)\s*```/gi)
    for (const match of fencedMatches) {
      addCandidate(candidates, seen, stripTranscriptPrefixes(match[1] ?? ''))
      addCandidate(candidates, seen, match[1] ?? '')
    }

    const lines = source.split('\n').map(stripTranscriptLinePrefix)
    const collectionIndex = lines.findIndex(line =>
      /^(questions|interview[_\s-]*questions|question[_\s-]*list|question[_\s-]*items|items)\s*:/i.test(line.trim()),
    )
    if (collectionIndex >= 0) {
      addCandidate(candidates, seen, lines.slice(collectionIndex).join('\n'))
    }

    const arrayIndex = lines.findIndex(line =>
      /^\s*-\s*(?:id|question|prompt|text|content)\s*:/i.test(line),
    )
    if (arrayIndex >= 0) {
      addCandidate(candidates, seen, lines.slice(arrayIndex).join('\n'))
    }
  }

  return candidates
}

function getRecordString(
  value: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!keys.includes(normalizeKey(key))) continue
    const recordValue = value[key]
    if (typeof recordValue === 'string' && recordValue.trim()) return recordValue.trim()
  }
  return undefined
}

function looksLikeQuestionMapEntry(key: string, value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (!isRecord(value)) return false
  return Boolean(
    getRecordString(value, QUESTION_FIELD_KEYS)
    || getRecordString(value, PHASE_FIELD_KEYS)
    || /^[qQ]\d+$/.test(key.trim()),
  )
}

function buildMalformedStructuredQuestionCollectionError(targets: Array<string | number>): Error {
  const formattedTargets = targets
    .map((target) => typeof target === 'number' ? String(target + 1) : target)
    .join(', ')
  return new MalformedStructuredQuestionCollectionError(
    `Invalid interview questions: structured questions collection contains malformed entries at ${formattedTargets}.`,
  )
}

function convertQuestionMap(
  value: Record<string, unknown>,
  options: { strictStructuredCollection?: boolean } = {},
): unknown[] {
  const entries = Object.entries(value)
  const malformedKeys = entries
    .filter(([key, entry]) => !looksLikeQuestionMapEntry(key, entry))
    .map(([key]) => key)

  if (entries.length === 0) {
    return []
  }

  if (malformedKeys.length > 0) {
    if (options.strictStructuredCollection) {
      throw buildMalformedStructuredQuestionCollectionError(malformedKeys)
    }
    return []
  }

  return entries.map(([key, entry]) => {
    if (typeof entry === 'string') {
      return { id: key, question: entry }
    }
    if (isRecord(entry)) {
      return { id: getRecordString(entry, ID_FIELD_KEYS) ?? key, ...entry }
    }
    return entry
  })
}

function findQuestionCollection(
  value: unknown,
  options: StructuredQuestionExtractionOptions,
  depth: number = 0,
): unknown[] | null {
  if (depth > 4) return null

  if (Array.isArray(value)) {
    return options.allowTopLevelArray ? value : null
  }

  if (!isRecord(value)) return null

  for (const [key, entry] of Object.entries(value)) {
    if (!QUESTION_COLLECTION_KEYS.has(normalizeKey(key))) continue
    if (Array.isArray(entry)) return entry
    if (isRecord(entry)) {
      const mapped = convertQuestionMap(entry, {
        strictStructuredCollection: options.strictStructuredCollection,
      })
      if (mapped.length > 0) return mapped
    }
  }

  const directMap = convertQuestionMap(value, {
    strictStructuredCollection: options.strictStructuredCollection,
  })
  if (directMap.length > 0) return directMap

  for (const entry of Object.values(value)) {
    const nested = findQuestionCollection(entry, options, depth + 1)
    if (nested) return nested
  }

  return null
}

function normalizeQuestionId(rawId: string | undefined, index: number): string {
  const trimmed = rawId?.trim()
  if (!trimmed) return `Q${String(index + 1).padStart(2, '0')}`

  const inlineMatch = trimmed.match(/q?(\d+)/i)
  if (inlineMatch?.[1]) return `Q${inlineMatch[1].padStart(2, '0')}`
  return trimmed
}

function extractInlineMetadata(text: string): { id?: string; phase?: string; question: string } {
  let question = text.trim()
  let phase: string | undefined
  let id: string | undefined

  const phaseMatch = question.match(INLINE_PHASE_PATTERN)
  if (phaseMatch?.[1]) {
    phase = normalizePhaseValue(phaseMatch[1])
    question = question.slice(phaseMatch[0].length).trim()
  }

  const idMatch = question.match(INLINE_ID_PATTERN)
  if (idMatch?.[1]) {
    id = normalizeQuestionId(idMatch[1], 0)
    question = question.slice(idMatch[0].length).trim()
  }

  return { id, phase, question }
}

function normalizeQuestionPreview(
  value: unknown,
  index: number,
  inheritedPhase?: string,
): InterviewQuestionPreview | null {
  if (typeof value === 'string') {
    const { id, phase, question } = extractInlineMetadata(value)
    const recovered = cleanRecoveredQuestion(question)
    if (!recovered.question.trim()) return null
    return {
      id,
      phase: phase ?? inheritedPhase,
      question: recovered.question.trim(),
    }
  }

  if (!isRecord(value)) return null

  let id = normalizeQuestionId(getRecordString(value, ID_FIELD_KEYS), index)
  let phase = normalizePhaseValue(getRecordString(value, PHASE_FIELD_KEYS) ?? inheritedPhase)
  const rawQuestion = getRecordString(value, QUESTION_FIELD_KEYS)
  if (!rawQuestion) return null

  const inline = extractInlineMetadata(rawQuestion)
  const recovered = cleanRecoveredQuestion(inline.question)
  if (!getRecordString(value, ID_FIELD_KEYS) && inline.id) {
    id = normalizeQuestionId(inline.id, index)
  }
  if (!phase && inline.phase) {
    phase = inline.phase
  }

  if (!recovered.question.trim()) return null

  return {
    id,
    phase,
    question: recovered.question.trim(),
  }
}

function normalizeQuestionCollection(
  collection: unknown[],
  options: { strictStructuredCollection?: boolean } = {},
): InterviewQuestionPreview[] {
  const normalized: InterviewQuestionPreview[] = []
  const malformedIndexes: number[] = []

  collection.forEach((entry, index) => {
    const question = normalizeQuestionPreview(entry, index)
    if (question) {
      normalized.push(question)
    } else if (options.strictStructuredCollection) {
      malformedIndexes.push(index)
    }
  })

  if (malformedIndexes.length > 0) {
    throw buildMalformedStructuredQuestionCollectionError(malformedIndexes)
  }

  return normalized
}

function extractStructuredQuestionPreviews(
  content: string,
  options: StructuredQuestionExtractionOptions,
): InterviewQuestionPreview[] {
  const candidates = getInterviewContentCandidates(content)
  let lastYamlError: string | null = null
  let lastMalformedCollectionError: Error | null = null

  for (const candidate of candidates) {
    for (const parseCandidate of [repairInterviewCandidate(candidate), candidate]) {
      const repairFedTheParser = parseCandidate !== candidate
      let parsedYaml: unknown

      try {
        parsedYaml = jsYaml.load(parseCandidate)
      } catch (err) {
        lastYamlError = getErrorMessage(err)
        continue
      }

      let collection: unknown[] | null
      try {
        collection = findQuestionCollection(parsedYaml, options)
      } catch (err) {
        if (err instanceof MalformedStructuredQuestionCollectionError) {
          lastMalformedCollectionError = err
          continue
        }
        throw err
      }
      if (!collection) continue

      let normalized: InterviewQuestionPreview[]
      try {
        normalized = normalizeQuestionCollection(collection, options)
      } catch (err) {
        if (err instanceof MalformedStructuredQuestionCollectionError) {
          lastMalformedCollectionError = err
          continue
        }
        throw err
      }

      if (normalized.length > 0) {
        if (repairFedTheParser) options.onCandidateRepairApplied?.()
        return normalized
      }
    }
  }

  if (lastMalformedCollectionError) {
    throw lastMalformedCollectionError
  }

  if (lastYamlError) {
    throw new Error(`Invalid YAML: ${lastYamlError}`)
  }

  return []
}

function trimWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

function countUnescapedQuotes(value: string, quote: '"' | '\''): number {
  let count = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== quote) continue
    let backslashes = 0
    for (let offset = index - 1; offset >= 0 && value[offset] === '\\'; offset -= 1) {
      backslashes += 1
    }
    if (backslashes % 2 === 0) count += 1
  }
  return count
}

function hasUnclosedQuote(value: string): boolean {
  return countUnescapedQuotes(value, '"') % 2 === 1 || countUnescapedQuotes(value, '\'') % 2 === 1
}

function looksLikeYamlBoundary(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('```')) return true
  if (/^questions\s*:/i.test(trimmed)) return true
  if (/^-\s*(foundation|structure|assembly)\s*$/i.test(trimmed)) return true
  return /^(?:-\s*)?(?:id|phase|category|section|stage|question|prompt|text|content)\s*:/i.test(trimmed)
}

function cleanRecoveredQuestion(rawQuestion: string): { question: string; carryId?: string } {
  const normalized = trimWrappingQuotes(rawQuestion)
    .replace(/\s+/g, ' ')
    .trim()

  const embeddedMetadataMatch = normalized.match(/\s+id:\s*(Q\d+)\s+phase:\s*([^"]+)$/i)
  if (embeddedMetadataMatch) {
    const prefix = normalized.slice(0, embeddedMetadataMatch.index).trim()
    const suffix = embeddedMetadataMatch[2]?.trim() ?? ''
    const recoveredQuestion = [prefix, suffix].filter(Boolean).join(' ').trim()
    return {
      question: recoveredQuestion,
      carryId: normalizeQuestionId(embeddedMetadataMatch[1], 0),
    }
  }

  return { question: normalized }
}

function repairInterviewCandidate(candidate: string): string {
  const repairedLines: string[] = []
  const inlineSequenceRepaired = repairYamlInlineSequenceParents(candidate)
  const inlineKeyRepaired = repairYamlInlineKeys(inlineSequenceRepaired)
  const dashRepaired = repairYamlListDashSpace(inlineKeyRepaired)
  const sequenceIndentRepaired = repairYamlSequenceEntryIndent(dashRepaired)
  const indentationRepaired = repairYamlIndentation(sequenceIndentRepaired)
  const rawLines = stripTranscriptPrefixes(indentationRepaired).split('\n')
  let carryIdForNextItem: string | undefined

  for (let index = 0; index < rawLines.length; index += 1) {
    let line = rawLines[index] ?? ''
    const trimmed = line.trim()

    const explicitIdMatch = trimmed.match(/^-\s*id\s*:\s*(.+)$/i)
      ?? trimmed.match(/^id\s*:\s*(.+)$/i)
    if (explicitIdMatch?.[1]) {
      carryIdForNextItem = undefined
    }

    const barePhaseMatch = line.match(/^(\s*)-\s*(foundation|structure|assembly)\s*$/i)
    if (barePhaseMatch?.[2]) {
      const nextLine = rawLines[index + 1]?.trim() ?? ''
      if (/^(question|prompt|text|content)\s*:/i.test(nextLine)) {
        if (carryIdForNextItem) {
          repairedLines.push(`${barePhaseMatch[1]}- id: ${carryIdForNextItem}`)
          line = `${barePhaseMatch[1]}  phase: ${barePhaseMatch[2].toLowerCase()}`
          carryIdForNextItem = undefined
        } else {
          line = `${barePhaseMatch[1]}- phase: ${barePhaseMatch[2].toLowerCase()}`
        }
      }
    }

    if (/^(question|prompt|text|content)\s*:/i.test(trimmed) && hasUnclosedQuote(trimmed)) {
      let merged = trimmed
      while (hasUnclosedQuote(merged) && index + 1 < rawLines.length) {
        const nextLine = rawLines[index + 1]?.trim() ?? ''
        if (!nextLine) {
          index += 1
          continue
        }
        if (/^-\s*id\s*:/i.test(nextLine) || /^-\s*(foundation|structure|assembly)\s*$/i.test(nextLine) || nextLine.startsWith('```')) {
          break
        }

        merged = `${merged} ${nextLine}`.trim()
        index += 1
      }

      // Close the unclosed quote if we broke at a structural boundary
      if (hasUnclosedQuote(merged)) {
        merged = merged + '"'
      }

      const mergedQuestion = merged.replace(/^(question|prompt|text|content)\s*:\s*/i, '')
      const recovered = cleanRecoveredQuestion(mergedQuestion)
      if (recovered.carryId) {
        carryIdForNextItem = recovered.carryId
      }
      line = `${line.match(/^\s*/)?.[0] ?? ''}${merged}`
    }

    repairedLines.push(line)
  }

  return repairedLines.join('\n')
}

function parseLooseQuestionLines(content: string): InterviewQuestionPreview[] {
  const stripped = stripTranscriptPrefixes(content)
  const lines = stripped.split('\n')
  const questions: InterviewQuestionPreview[] = []
  let contextPhase: string | undefined
  let currentId: string | undefined
  let currentPhase: string | undefined
  let currentQuestion = ''
  let carryIdForNext: string | undefined

  const finalizeCurrent = () => {
    const normalizedQuestion = trimWrappingQuotes(currentQuestion).trim()
    if (!normalizedQuestion) {
      currentId = undefined
      currentPhase = undefined
      currentQuestion = ''
      return
    }

    questions.push({
      id: currentId,
      phase: currentPhase,
      question: normalizedQuestion,
    })
    currentId = undefined
    currentPhase = undefined
    currentQuestion = ''
  }

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? ''
    const trimmed = lines[index]?.trim() ?? ''
    if (!trimmed || trimmed.startsWith('```') || /^questions\s*:/i.test(trimmed)) continue

    const headingMatch = trimmed.match(PHASE_HEADING_PATTERN)
    if (headingMatch?.[1]) {
      finalizeCurrent()
      contextPhase = normalizePhaseValue(headingMatch[1])
      continue
    }

    const barePhaseMatch = trimmed.match(/^-\s*(foundation|structure|assembly)\s*$/i)
    if (barePhaseMatch?.[1]) {
      finalizeCurrent()
      currentId = carryIdForNext
      currentPhase = normalizePhaseValue(barePhaseMatch[1])
      carryIdForNext = undefined
      continue
    }

    const idMatch = trimmed.match(/^-\s*id\s*:\s*(.+)$/i)
      ?? trimmed.match(/^id\s*:\s*(.+)$/i)
    if (idMatch?.[1]) {
      finalizeCurrent()
      currentId = normalizeQuestionId(idMatch[1], questions.length)
      carryIdForNext = undefined
      continue
    }

    const phaseMatch = trimmed.match(/^(?:-\s*)?(phase|category|section|stage)\s*:\s*(.+)$/i)
    if (phaseMatch?.[2]) {
      currentId ??= carryIdForNext
      currentPhase = normalizePhaseValue(trimWrappingQuotes(phaseMatch[2]))
      carryIdForNext = undefined
      continue
    }

    const questionMatch = trimmed.match(/^(?:-\s*)?(question|prompt|text|content)\s*:\s*(.*)$/i)
    if (questionMatch) {
      currentId ??= carryIdForNext
      currentPhase ??= contextPhase
      let rawQuestion = questionMatch[2] ?? ''
      while (hasUnclosedQuote(rawQuestion) && index + 1 < lines.length) {
        const nextLine = lines[index + 1]?.trim() ?? ''
        if (!nextLine) {
          index += 1
          continue
        }
        // Stop at structural boundaries — do not swallow subsequent questions
        if (
          /^-\s*id\s*:/i.test(nextLine)
          || /^-\s*(foundation|structure|assembly)\s*$/i.test(nextLine)
          || /^(?:-\s*)?(?:id|phase|category|section|stage)\s*:/i.test(nextLine)
          || nextLine.startsWith('```')
        ) {
          break
        }

        rawQuestion = `${rawQuestion} ${nextLine}`.trim()
        index += 1
        if (!hasUnclosedQuote(rawQuestion)) break
      }
      // Close the unclosed quote if we broke at a boundary
      if (hasUnclosedQuote(rawQuestion)) {
        rawQuestion = rawQuestion + '"'
      }

      const recovered = cleanRecoveredQuestion(rawQuestion)
      currentQuestion = recovered.question
      if (recovered.carryId) {
        carryIdForNext = recovered.carryId
      }
      continue
    }

    const listQuestionMatch = trimmed.match(/^[-*]\s+(.*)$/)
      ?? trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (listQuestionMatch) {
      const inline = extractInlineMetadata(listQuestionMatch[1] ?? '')
      if (inline.question && !/^id\s*:/i.test(inline.question) && !/^phase\s*:/i.test(inline.question)) {
        finalizeCurrent()
        questions.push({
          id: inline.id,
          phase: inline.phase ?? contextPhase,
          question: inline.question,
        })
        continue
      }
    }

    if (currentQuestion && /^\s+/.test(rawLine) && !looksLikeYamlBoundary(trimmed)) {
      currentQuestion = [currentQuestion, trimWrappingQuotes(trimmed)].filter(Boolean).join(' ').trim()
      continue
    }

    const inline = extractInlineMetadata(trimmed)
    if (
      inline.question
      && inline.question.endsWith('?')
      && !/^id\s*:/i.test(inline.question)
      && !/^phase\s*:/i.test(inline.question)
    ) {
      finalizeCurrent()
      questions.push({
        id: inline.id,
        phase: inline.phase ?? contextPhase,
        question: inline.question,
      })
    }
  }

  finalizeCurrent()

  return questions.map((question, index) => ({
    ...question,
    id: question.id ?? `Q${String(index + 1).padStart(2, '0')}`,
  }))
}

export function extractInterviewQuestionPreviews(
  content: string,
  options: ParseInterviewQuestionsOptions = {},
): InterviewQuestionPreview[] {
  try {
    const structured = extractStructuredQuestionPreviews(content, options)
    if (structured.length > 0) return structured
  } catch {
    // Fall through to recovery parsers for malformed wrappers or partial YAML.
  }

  return parseLooseQuestionLines(content)
}

export function unwrapInterviewYamlFence(content: string): string {
  return getInterviewContentCandidates(content)[0] ?? content.trim()
}

export function parseInterviewQuestions(
  content: string,
  options: ParseInterviewQuestionsOptions = {},
): ParsedInterviewQuestion[] {
  let questions: InterviewQuestionPreview[] = []
  try {
    questions = extractStructuredQuestionPreviews(content, {
      ...options,
      strictStructuredCollection: true,
    })
  } catch (err) {
    if (err instanceof MalformedStructuredQuestionCollectionError) {
      throw err
    }
  }

  if (questions.length === 0) {
    questions = parseLooseQuestionLines(content)
  }

  if (questions.length === 0) {
    throw new Error('Invalid YAML: could not parse interview questions')
  }

  return questions.map((question, index) => {
    const normalizedQuestion = question.question.trim()
    if (!normalizedQuestion) {
      throw new Error('Each question must include `question`, `prompt`, `text`, or `content`.')
    }

    const normalizedPhase = normalizePhaseValue(question.phase)
    if (!normalizedPhase) {
      throw new Error('Each question must include `phase`, `category`, `section`, or `stage`.')
    }

    return {
      id: normalizeQuestionId(question.id, index),
      phase: normalizedPhase,
      question: normalizedQuestion,
    }
  })
}

export function formatInterviewQuestionPreview(
  label: string,
  questions: ParsedInterviewQuestion[],
  maxPreviewQuestions: number = questions.length,
): string {
  const previewCount = Math.max(0, Math.trunc(maxPreviewQuestions))
  const visibleQuestions = questions.slice(0, previewCount)
  const previewLines = visibleQuestions.map(question =>
    `- [${question.phase.trim().toLowerCase()}] ${question.question.trim()}`,
  )
  const remainingCount = questions.length - visibleQuestions.length

  return [
    `${label} (${questions.length} total):`,
    ...previewLines,
    ...(remainingCount > 0 ? [`... ${remainingCount} more ${remainingCount === 1 ? 'question' : 'questions'}`] : []),
  ].join('\n')
}
