import { stripAnsiSequences } from './ansi'

const DECORATION_ONLY_LINE = /^[\s\-_=~.*:|/\\()[\]{}<>+─-╿▀-▟■-◿➯⬀-⯿]+$/u

function stripControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    if (character === '\n' || character === '\t') return character
    const code = character.codePointAt(0) ?? 0
    return code < 32 || (code >= 127 && code <= 159) ? '' : character
  }).join('')
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
  const normalized = stripControlCharacters(
    stripAnsiSequences(value).replace(/\r\n?/g, '\n'),
  )
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
