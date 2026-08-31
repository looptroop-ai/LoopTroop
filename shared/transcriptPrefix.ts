/**
 * Removes transcript speaker prefixes from model output.
 *
 * Models sometimes echo their own transcript formatting into a structured
 * answer — `[assistant] summary: ...`, occasionally stacked as
 * `[assistant][tool] summary: ...`. Every consumer has to see past that to the
 * content underneath, and there were three implementations doing it: one that
 * stripped repeatedly until nothing was left, and two that stripped a single
 * prefix per line. The same echo therefore normalised differently in the
 * interview parser than in the structured-output parser and the prompt-echo
 * detector, which is a difference nobody chose.
 *
 * The repeated form is now the shared behaviour. Stopping after one prefix
 * leaves a line that still starts with a bracketed speaker tag, which the YAML
 * parser reads as a flow sequence and rejects.
 */
export const TRANSCRIPT_PREFIX_PATTERN = /^\s*\[(?:assistant|user|system|sys|tool|model|error)(?:\/[^\]]+)?\](?:\s*\[[^\]]+\])?\s*/i

/** Strips every stacked prefix from one line, not just the first. */
export function stripTranscriptLinePrefix(line: string): string {
  let current = line
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(TRANSCRIPT_PREFIX_PATTERN, '')
  }
  return current
}

/**
 * Strips prefixes from every line of a document.
 *
 * Deliberately does not trim the result: one caller relies on the surrounding
 * whitespace and the others trim for themselves.
 */
export function stripTranscriptPrefixes(content: string): string {
  return content
    .split('\n')
    .map(stripTranscriptLinePrefix)
    .join('\n')
}
