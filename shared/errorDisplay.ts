import { stripAnsiSequences } from './ansi'

const DECORATION_ONLY_LINE = /^[\s\-_=~.*:|/\\()[\]{}<>+─-╿▀-▟■-◿➯⬀-⯿]+$/u

// Every C0 control except tab and newline, plus DEL and the C1 controls. Matched per
// UTF-16 unit: surrogate halves are outside these ranges, so astral text is kept whole.
// eslint-disable-next-line no-control-regex -- removing control characters is the point.
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g

function stripControlCharacters(value: string): string {
  // One regex pass: building an array of every character made multi-megabyte log
  // payloads cost hundreds of milliseconds on the server's only thread.
  return value.replace(CONTROL_CHARACTERS, '')
}

/** Removes terminal formatting while preserving structured text and repeated lines. */
export function stripTerminalFormatting(value: string): string {
  return stripControlCharacters(stripAnsiSequences(value).replace(/\r\n?/g, '\n'))
}

function isDecorationOnly(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.length >= 4 && DECORATION_ONLY_LINE.test(trimmed)
}

function dedupeConsecutiveSentences(line: string): string {
  const segments = line.split(/(?<=[.!?])\s+/)
  if (segments.length < 2) return line
  return segments.filter((segment, index) => {
    if (index === 0) return true
    const comparable = segment.trim().replace(/\s+/g, ' ').toLowerCase()
    const previous = segments[index - 1]?.trim().replace(/\s+/g, ' ').toLowerCase()
    return comparable.length === 0 || comparable !== previous
  }).join(' ')
}

function dedupeConsecutiveLineBlocks(lines: string[]): string[] {
  const deduped: string[] = []

  for (let index = 0; index < lines.length;) {
    let repeatedBlockSize = 0
    const largestCandidate = Math.floor((lines.length - index) / 2)

    for (let size = 1; size <= largestCandidate; size += 1) {
      const first = lines.slice(index, index + size)
      const second = lines.slice(index + size, index + (size * 2))
      if (first.every((line, offset) => line === second[offset])) {
        repeatedBlockSize = size
        break
      }
    }

    if (repeatedBlockSize === 0) {
      deduped.push(lines[index] ?? '')
      index += 1
      continue
    }

    const block = lines.slice(index, index + repeatedBlockSize)
    deduped.push(...block)
    index += repeatedBlockSize
    while (block.every((line, offset) => line === lines[index + offset])) {
      index += repeatedBlockSize
    }
  }

  return deduped
}

/** Builds a readable view while leaving persisted errors and raw logs unchanged. */
export function sanitizeErrorForDisplay(value: string): string {
  const normalized = stripTerminalFormatting(value)
  const lines: string[] = []
  let previousComparable: string | null = null

  for (const rawLine of normalized.split('\n')) {
    const line = dedupeConsecutiveSentences(rawLine.trimEnd())
    if (isDecorationOnly(line)) continue
    const comparable = line.trim().replace(/\s+/g, ' ').toLowerCase()
    if (comparable && comparable === previousComparable) continue
    if (comparable) previousComparable = comparable
    lines.push(line)
  }

  return dedupeConsecutiveLineBlocks(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
