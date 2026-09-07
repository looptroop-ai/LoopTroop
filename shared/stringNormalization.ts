/**
 * String coercion helpers that were written out by hand in five modules.
 *
 * The three array variants are deliberately separate functions rather than one
 * with a flag. The copies they replace did not agree — one kept empty strings,
 * one dropped blank entries but returned them with their surrounding whitespace
 * intact, and one trimmed every entry before dropping the blanks. Collapsing
 * them into a single helper would have changed what two of the five callers
 * produce, so the difference is in the name instead.
 *
 * `server/structuredOutput/yamlUtils.ts` has a sixth variant that coerces dates,
 * numbers and nested objects into strings. That one is a parser concern, not a
 * normaliser, and stays where it is.
 */

/** `value` when it is a string, otherwise the empty string. */
export function toStringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** The string entries of an array, empty strings included, untrimmed. */
export function toStringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

/** The string entries that are not blank, each still carrying its own whitespace. */
export function toNonBlankStringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : []
}

/** The string entries, trimmed, with the ones that trim to nothing dropped. */
export function toTrimmedStringEntries(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    : []
}

/** A lowercase, hyphen-separated form of `value`, safe to use in a DOM id. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
