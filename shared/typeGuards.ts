/**
 * Type guard that validates if an unknown value is a plain object/record.
 * Excludes arrays, dates, maps, sets, regexps, and null values.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Map)
    && !(value instanceof Set)
    && !(value instanceof RegExp)
}

/** Returns error.message for Error instances, String(value) for everything else. */
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Returns the trimmed string if non-empty, undefined otherwise. */
export function normalizeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * Reads the first alias present on a record, matching keys **exactly**.
 *
 * The counterpart is `getValueByAliases` in `server/structuredOutput/yamlUtils`,
 * which normalises keys so `generated_at` and `generatedAt` are the same key.
 * That one is for model output, where the spelling is whatever the model wrote.
 * This one is for our own persisted JSON, where the spellings are known and
 * listed, and normalising would make two deliberately distinct fields collide.
 *
 * Both used to be called `getValueByAliases`, in three separate declarations, so
 * a search for the name could not tell you which semantics a call site wanted.
 *
 * Uses `Object.hasOwn` rather than `in`: `in` walks the prototype, so a record
 * with no `constructor` key of its own still answers to one.
 */
export function getValueByExactAlias(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (Object.hasOwn(record, alias)) return record[alias]
  }
  return undefined
}
