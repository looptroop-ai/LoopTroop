import { looksLikePromptEcho } from '../lib/promptEcho'
import type { VoteScorecard, StructuredOutputResult } from './types'
import {
  isRecord,
  normalizeKey,
  collectStructuredCandidates,
  unwrapExplicitWrapperRecord,
  appendStructuredCandidateRecoveryWarning,
  parseYamlOrJsonCandidate,
  getValueByAliases,
  buildYamlDocument,
  collectAliasConflictWarnings,
} from './yamlUtils'
import { buildStructuredOutputFailure } from './failure'
import { getErrorMessage } from '@shared/typeGuards'
import { MAX_VOTE_CATEGORY_SCORE } from '../council/types'

function normalizeVoteDraftLabel(label: string): string | null {
  const match = label.trim().match(/draft\s*(\d+)/i)
  if (!match?.[1]) return null
  return `Draft ${Number(match[1])}`
}

function repairVoteScorecardIndentation(
  content: string,
  draftLabels: string[],
  rubricCategories: string[],
): { content: string; repairApplied: boolean; repairWarnings: string[] } {
  const lines = content.split('\n')
  const wrapperKeyAliases = new Set(['draftscores', 'draft_scores', 'scores', 'scorecard'])
  const wrapperIndex = lines.findIndex((line) => {
    const match = line.trim().match(/^([^:]+)\s*:\s*$/)
    return match?.[1] ? wrapperKeyAliases.has(normalizeKey(match[1])) : false
  })

  if (wrapperIndex < 0) {
    return { content, repairApplied: false, repairWarnings: [] }
  }

  const wrapperIndent = lines[wrapperIndex]?.match(/^(\s*)/)?.[1]?.length ?? 0
  const rubricKeys = new Set([
    ...rubricCategories.map((category) => normalizeKey(category)),
    'totalscore',
    'total_score',
  ].map((key) => normalizeKey(key)))

  let repairApplied = false
  let insideDraft = false

  for (let index = wrapperIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const actualIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0
    const keyMatch = trimmed.match(/^([^:]+)\s*:(.*)$/)
    if (!keyMatch?.[1]) {
      if (actualIndent <= wrapperIndent) break
      continue
    }

    const key = keyMatch[1].trim()
    const normalizedDraftLabel = normalizeVoteDraftLabel(key)
    if (normalizedDraftLabel && draftLabels.includes(normalizedDraftLabel)) {
      insideDraft = true
      const repaired = `  ${trimmed}`
      if (line !== repaired) {
        lines[index] = repaired
        repairApplied = true
      }
      continue
    }

    const normalizedKey = normalizeKey(key)
    if (insideDraft && rubricKeys.has(normalizedKey)) {
      const repaired = `    ${trimmed}`
      if (line !== repaired) {
        lines[index] = repaired
        repairApplied = true
      }
      continue
    }

    if (actualIndent <= wrapperIndent) {
      break
    }
  }

  return {
    content: lines.join('\n'),
    repairApplied,
    repairWarnings: repairApplied
      ? ['Normalized vote scorecard indentation under the wrapper key.']
      : [],
  }
}

export function normalizeVoteScorecardOutput(
  rawContent: string,
  draftLabels: string[],
  rubricCategories: string[],
): StructuredOutputResult<VoteScorecard> {
  const repairWarnings: string[] = []
  const candidates = collectStructuredCandidates(rawContent, {
    topLevelHints: ['draft_scores'],
  })
  let lastError = 'No vote scorecard content found'
  let lastErrorCause: unknown = null

  for (const candidate of candidates) {
    const repairedCandidate = repairVoteScorecardIndentation(candidate, draftLabels, rubricCategories)
    const candidateVariants = repairedCandidate.repairApplied
      ? [
          {
            content: candidate,
            repairApplied: false,
            repairWarnings: [] as string[],
          },
          repairedCandidate,
        ]
      : [repairedCandidate]

    for (const variant of candidateVariants) {
      const variantWarnings = [...variant.repairWarnings]
      const releaseAliasConflicts = collectAliasConflictWarnings(variantWarnings)
      try {
        const parsed = unwrapExplicitWrapperRecord(parseYamlOrJsonCandidate(variant.content, {
          allowTrailingTerminalNoise: true,
          repairWarnings: variantWarnings,
        }), [
          'draftscores',
          'draft_scores',
          'scores',
          'scorecard',
        ])

        const root = isRecord(parsed) ? parsed : null
        const nestedDraftScores = root ? getValueByAliases(root, ['draftscores', 'draft_scores']) : undefined
        const draftScoresRecord = root
          ? isRecord(nestedDraftScores) ? nestedDraftScores : root
          : null

        if (!draftScoresRecord) throw new Error('Vote scorecard is not a YAML/JSON mapping')
        const expectedDraftLabels = new Set(draftLabels)
        const normalizedDraftEntries = new Map<string, Record<string, unknown>>()

        for (const [key, value] of Object.entries(draftScoresRecord)) {
          const normalizedLabel = normalizeVoteDraftLabel(key)
          if (!normalizedLabel || !expectedDraftLabels.has(normalizedLabel)) {
            throw new Error(`Unknown scorecard for ${key}`)
          }
          if (!isRecord(value)) {
            throw new Error(`Scorecard for ${normalizedLabel} is not a YAML/JSON mapping`)
          }
          if (normalizedDraftEntries.has(normalizedLabel)) {
            throw new Error(`Duplicate scorecard for ${normalizedLabel}`)
          }
          normalizedDraftEntries.set(normalizedLabel, value)
        }

        const normalized: VoteScorecard['draftScores'] = {}

        for (const draftLabel of draftLabels) {
          const draftRecord = normalizedDraftEntries.get(draftLabel)
          if (!draftRecord) {
            throw new Error(`Missing scorecard for ${draftLabel}`)
          }
          const scores: Record<string, number> = {}
          let total = 0

          for (const category of rubricCategories) {
            const rawValue = getValueByAliases(draftRecord, [normalizeKey(category)])
            if (typeof rawValue !== 'number' || !Number.isInteger(rawValue) || rawValue < 0 || rawValue > MAX_VOTE_CATEGORY_SCORE) {
              throw new Error(`Invalid score for ${draftLabel} / ${category}`)
            }
            scores[category] = rawValue
            total += rawValue
          }

          const totalScore = getValueByAliases(draftRecord, ['totalscore', 'total_score'])
          if (totalScore === undefined) {
            variantWarnings.push(`Filled missing total_score for ${draftLabel} from rubric category totals.`)
          } else if (typeof totalScore !== 'number' || !Number.isInteger(totalScore)) {
            throw new Error(`Invalid total_score for ${draftLabel}`)
          } else if (totalScore !== total) {
            variantWarnings.push(`Recomputed total_score for ${draftLabel}: expected ${total}, received ${totalScore}.`)
          }
          scores.total_score = total
          normalized[draftLabel] = scores
        }
        appendStructuredCandidateRecoveryWarning(variantWarnings, rawContent, candidate)

        return {
          ok: true,
          value: { draftScores: normalized },
          normalizedContent: buildYamlDocument({ draft_scores: normalized }),
          repairApplied: candidate !== rawContent.trim() || variant.repairApplied || variantWarnings.length > 0,
          repairWarnings: variantWarnings,
        }
      } catch (error) {
        lastError = getErrorMessage(error)
        lastErrorCause = error
        repairWarnings.splice(0, repairWarnings.length, ...variantWarnings)
      } finally {
        releaseAliasConflicts()
      }
    }
  }

  return buildStructuredOutputFailure(
    rawContent,
    looksLikePromptEcho(rawContent)
      ? 'Vote scorecard output echoed the prompt instead of returning a structured scorecard'
      : lastError,
    {
      repairWarnings,
      cause: lastErrorCause,
    },
  )
}
