export interface TextDiffSegment {
  text: string
  changed: boolean
}

const TEXT_DIFF_TOKEN_PATTERN = /(\s+|[A-Za-z0-9_]+|[^A-Za-z0-9_\s]+)/g
const MAX_TEXT_DIFF_LCS_TOKENS = 2_000
const MAX_TEXT_DIFF_LCS_CELLS = 250_000

function tokenizeTextDiff(text: string): string[] {
  return text.match(TEXT_DIFF_TOKEN_PATTERN) ?? []
}

function mergeTextDiffSegments(segments: TextDiffSegment[]): TextDiffSegment[] {
  const merged: TextDiffSegment[] = []

  for (const segment of segments) {
    if (!segment.text) continue
    const previous = merged[merged.length - 1]
    if (previous && previous.changed === segment.changed) {
      previous.text += segment.text
      continue
    }
    merged.push({ ...segment })
  }

  return merged
}

function buildReplacementSegments(before: string, after: string): {
  before: TextDiffSegment[]
  after: TextDiffSegment[]
} {
  return {
    before: before ? [{ text: before, changed: true }] : [],
    after: after ? [{ text: after, changed: true }] : [],
  }
}

export function buildTextDiffSegments(before: string | undefined, after: string | undefined): {
  before: TextDiffSegment[]
  after: TextDiffSegment[]
} {
  if (!before && !after) return { before: [], after: [] }
  if (!before) return { before: [], after: after ? [{ text: after, changed: true }] : [] }
  if (!after) return { before: before ? [{ text: before, changed: true }] : [], after: [] }
  if (before === after) {
    return {
      before: [{ text: before, changed: false }],
      after: [{ text: after, changed: false }],
    }
  }

  const beforeTokens = tokenizeTextDiff(before)
  const afterTokens = tokenizeTextDiff(after)
  // ponytail: cap the quadratic word matrix; line replacement keeps large/minified
  // artifacts responsive, with a line-aware diff available if this ceiling matters.
  if (
    beforeTokens.length > MAX_TEXT_DIFF_LCS_TOKENS
    || afterTokens.length > MAX_TEXT_DIFF_LCS_TOKENS
    || beforeTokens.length * afterTokens.length > MAX_TEXT_DIFF_LCS_CELLS
  ) {
    return buildReplacementSegments(before, after)
  }
  const lcs: number[][] = Array.from(
    { length: beforeTokens.length + 1 },
    () => Array<number>(afterTokens.length + 1).fill(0),
  )

  for (let beforeIndex = beforeTokens.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterTokens.length - 1; afterIndex >= 0; afterIndex -= 1) {
      lcs[beforeIndex]![afterIndex] = beforeTokens[beforeIndex] === afterTokens[afterIndex]
        ? (lcs[beforeIndex + 1]?.[afterIndex + 1] ?? 0) + 1
        : Math.max(lcs[beforeIndex + 1]?.[afterIndex] ?? 0, lcs[beforeIndex]![afterIndex + 1] ?? 0)
    }
  }

  const beforeSegments: TextDiffSegment[] = []
  const afterSegments: TextDiffSegment[] = []
  let beforeIndex = 0
  let afterIndex = 0

  while (beforeIndex < beforeTokens.length && afterIndex < afterTokens.length) {
    if (beforeTokens[beforeIndex] === afterTokens[afterIndex]) {
      const shared = beforeTokens[beforeIndex]!
      beforeSegments.push({ text: shared, changed: false })
      afterSegments.push({ text: shared, changed: false })
      beforeIndex += 1
      afterIndex += 1
      continue
    }

    if ((lcs[beforeIndex + 1]?.[afterIndex] ?? 0) >= (lcs[beforeIndex]?.[afterIndex + 1] ?? 0)) {
      beforeSegments.push({ text: beforeTokens[beforeIndex]!, changed: true })
      beforeIndex += 1
      continue
    }

    afterSegments.push({ text: afterTokens[afterIndex]!, changed: true })
    afterIndex += 1
  }

  while (beforeIndex < beforeTokens.length) {
    beforeSegments.push({ text: beforeTokens[beforeIndex]!, changed: true })
    beforeIndex += 1
  }

  while (afterIndex < afterTokens.length) {
    afterSegments.push({ text: afterTokens[afterIndex]!, changed: true })
    afterIndex += 1
  }

  return {
    before: mergeTextDiffSegments(beforeSegments),
    after: mergeTextDiffSegments(afterSegments),
  }
}
