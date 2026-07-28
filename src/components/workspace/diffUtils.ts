import { buildTextDiffSegments, type TextDiffSegment } from './textDiffSegments'

export interface DiffStats {
  files: number
  additions: number
  deletions: number
}

export function parseDiffStats(diff: string): DiffStats {
  let files = 0
  let additions = 0
  let deletions = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) files++
    else if (line.startsWith('+') && !line.startsWith('+++')) additions++
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++
  }
  return { files, additions, deletions }
}

export interface DiffLineInfo {
  text: string
  oldNum: number | null
  newNum: number | null
}

export interface HighlightedDiffLineInfo extends DiffLineInfo {
  wordDiffSegments?: TextDiffSegment[]
}

export interface FileDiff {
  filename: string
  additions: number
  deletions: number
  lines: string[]
}

export interface BeadCommitDiffEntry {
  beadId: string
  label?: string
  diff: string
  createdAt?: string
  updatedAt?: string
}

export interface BeadCommitsDiffContent {
  isStructured: boolean
  netDiff?: string
  beads: BeadCommitDiffEntry[]
  fallbackDiff: string
}

export interface FileDiffOccurrence extends FileDiff {
  beadId?: string
  beadLabel?: string
  beadIndex: number
}

export interface FileDiffGroup {
  filename: string
  additions: number
  deletions: number
  occurrences: FileDiffOccurrence[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDiffContent(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeBeadDiffEntry(value: unknown, index: number): BeadCommitDiffEntry | null {
  if (!isRecord(value)) return null

  const diff = normalizeDiffContent(value.diff)
    ?? normalizeDiffContent(value.content)
    ?? normalizeDiffContent(value.patch)
  if (!diff) return null

  const beadId = normalizeOptionalString(value.beadId)
    ?? normalizeOptionalString(value.id)
    ?? normalizeOptionalString(value.bead_id)
    ?? `bead-${index + 1}`
  const label = normalizeOptionalString(value.label)
    ?? normalizeOptionalString(value.title)
  const createdAt = normalizeOptionalString(value.createdAt)
    ?? normalizeOptionalString(value.created_at)
  const updatedAt = normalizeOptionalString(value.updatedAt)
    ?? normalizeOptionalString(value.updated_at)

  return {
    beadId,
    ...(label ? { label } : {}),
    diff,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  }
}

function readBeadEntries(value: unknown): BeadCommitDiffEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry, index) => normalizeBeadDiffEntry(entry, index))
    .filter((entry): entry is BeadCommitDiffEntry => entry !== null)
}

function joinDiffs(diffs: string[]): string {
  return diffs
    .map((diff) => diff.trim())
    .filter(Boolean)
    .join('\n\n')
}

function parseDiffHeaderFilename(line: string): string {
  const pairMatch = line.match(/^diff --git a\/(.+) b\/(.+)$/)
  if (pairMatch?.[2]) return pairMatch[2]
  const fallbackMatch = line.match(/b\/(.+)$/)
  return fallbackMatch?.[1] ?? 'unknown'
}

export function serializeBeadCommitsDiffContent(input: {
  netDiff?: string | null
  beads: BeadCommitDiffEntry[]
}): string {
  const netDiff = normalizeDiffContent(input.netDiff)
  const beads = input.beads
    .map((bead, index) => normalizeBeadDiffEntry(bead, index))
    .filter((bead): bead is BeadCommitDiffEntry => bead !== null)

  return JSON.stringify({
    artifact: 'bead_commits_diff',
    version: 1,
    ...(netDiff ? { netDiff } : {}),
    beads,
  }, null, 2)
}

export function parseBeadCommitsDiffContent(content: string): BeadCommitsDiffContent {
  const trimmed = content.trim()
  if (!trimmed) {
    return { isStructured: false, beads: [], fallbackDiff: '' }
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (isRecord(parsed)) {
      const netDiff = normalizeDiffContent(parsed.netDiff)
        ?? normalizeDiffContent(parsed.candidateDiff)
        ?? normalizeDiffContent(parsed.patch)
      const beads = readBeadEntries(parsed.beads)
        .concat(readBeadEntries(parsed.beadDiffs))
        .concat(readBeadEntries(parsed.diffs))
      const fallbackDiff = netDiff ?? joinDiffs(beads.map((bead) => bead.diff))

      if (netDiff || beads.length > 0) {
        return {
          isStructured: true,
          ...(netDiff ? { netDiff } : {}),
          beads,
          fallbackDiff,
        }
      }
    }
  } catch {
    // Plain unified diffs are still supported for older content and direct tests.
  }

  return {
    isStructured: false,
    netDiff: trimmed,
    beads: [],
    fallbackDiff: trimmed,
  }
}

export function getBeadCommitsDiffStats(content: string): DiffStats {
  const parsed = parseBeadCommitsDiffContent(content)
  return parseDiffStats(parsed.netDiff ?? parsed.fallbackDiff)
}

export function buildCombinedDiffFromBeads(beads: BeadCommitDiffEntry[]): string {
  return joinDiffs(beads.map((bead) => bead.diff))
}

function isAdditionLine(line: string): boolean {
  return line.startsWith('+') && !line.startsWith('+++')
}

function isRemovalLine(line: string): boolean {
  return line.startsWith('-') && !line.startsWith('---')
}

function hasChangedSegments(segments: TextDiffSegment[]): boolean {
  return segments.some((segment) => segment.changed)
}

function applyWordDiffPair(lines: HighlightedDiffLineInfo[], removedIndex: number, addedIndex: number) {
  const diff = buildTextDiffSegments(lines[removedIndex]?.text.slice(1), lines[addedIndex]?.text.slice(1))

  if (hasChangedSegments(diff.before)) {
    lines[removedIndex]!.wordDiffSegments = diff.before
  }
  if (hasChangedSegments(diff.after)) {
    lines[addedIndex]!.wordDiffSegments = diff.after
  }
}

/** Parse hunk header like "@@ -10,5 +12,7 @@" into starting line numbers */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
  if (!m) return null
  return { oldStart: parseInt(m[1]!, 10), newStart: parseInt(m[2]!, 10) }
}

/** Compute per-line old/new line numbers from a list of raw diff lines */
export function computeLineNumbers(lines: string[]): DiffLineInfo[] {
  let oldNum = 0
  let newNum = 0
  return lines.map((line) => {
    if (line.startsWith('diff --git') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('index ')) {
      return { text: line, oldNum: null, newNum: null }
    }
    if (line.startsWith('@@')) {
      const hunk = parseHunkHeader(line)
      if (hunk) {
        oldNum = hunk.oldStart
        newNum = hunk.newStart
      }
      return { text: line, oldNum: null, newNum: null }
    }
    if (line.startsWith('+')) {
      const info: DiffLineInfo = { text: line, oldNum: null, newNum: newNum }
      newNum++
      return info
    }
    if (line.startsWith('-')) {
      const info: DiffLineInfo = { text: line, oldNum: oldNum, newNum: null }
      oldNum++
      return info
    }
    // context line
    const info: DiffLineInfo = { text: line, oldNum: oldNum, newNum: newNum }
    oldNum++
    newNum++
    return info
  })
}

export function computeLineNumbersWithWordDiff(lines: string[]): HighlightedDiffLineInfo[] {
  const numbered = computeLineNumbers(lines).map((line) => ({ ...line }))
  let index = 0

  while (index < numbered.length) {
    if (!numbered[index]?.text.startsWith('@@')) {
      index += 1
      continue
    }

    index += 1

    while (index < numbered.length) {
      const currentLine = numbered[index]?.text ?? ''
      if (currentLine.startsWith('@@') || currentLine.startsWith('diff --git')) break

      if (!isRemovalLine(currentLine) && !isAdditionLine(currentLine)) {
        index += 1
        continue
      }

      const removedIndices: number[] = []
      const addedIndices: number[] = []

      while (index < numbered.length) {
        const line = numbered[index]?.text ?? ''
        if (isRemovalLine(line)) {
          removedIndices.push(index)
          index += 1
          continue
        }
        if (isAdditionLine(line)) {
          addedIndices.push(index)
          index += 1
          continue
        }
        break
      }

      const pairCount = Math.min(removedIndices.length, addedIndices.length)
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        applyWordDiffPair(numbered, removedIndices[pairIndex]!, addedIndices[pairIndex]!)
      }
    }
  }

  return numbered
}

export function parseFileDiffs(diff: string): FileDiff[] {
  const result: FileDiff[] = []
  let current: FileDiff | null = null

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      current = { filename: parseDiffHeaderFilename(line), additions: 0, deletions: 0, lines: [line] }
      result.push(current)
    } else if (current) {
      current.lines.push(line)
      if (line.startsWith('+') && !line.startsWith('+++')) current.additions++
      else if (line.startsWith('-') && !line.startsWith('---')) current.deletions++
    }
  }

  return result
}

export function groupFileDiffsByPath(beads: BeadCommitDiffEntry[]): FileDiffGroup[] {
  const groups = new Map<string, FileDiffGroup>()

  beads.forEach((bead, beadIndex) => {
    for (const file of parseFileDiffs(bead.diff)) {
      const existing = groups.get(file.filename) ?? {
        filename: file.filename,
        additions: 0,
        deletions: 0,
        occurrences: [],
      }

      existing.additions += file.additions
      existing.deletions += file.deletions
      existing.occurrences.push({
        ...file,
        beadId: bead.beadId,
        beadLabel: bead.label,
        beadIndex,
      })
      groups.set(file.filename, existing)
    }
  })

  return Array.from(groups.values()).sort((a, b) => a.filename.localeCompare(b.filename))
}
