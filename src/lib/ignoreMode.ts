export type IgnoreMode = 'repo' | 'local' | 'skip'

export const DEFAULT_IGNORE_MODE: IgnoreMode = 'local'

export function normalizeIgnoreMode(value: unknown): IgnoreMode | null {
  return value === 'repo' || value === 'local' || value === 'skip' ? value : null
}
