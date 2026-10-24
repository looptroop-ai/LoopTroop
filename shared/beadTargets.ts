export function isBeadTargetFile(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

/** Classify path spellings without depending on the machine displaying them. */
export function isExternalTargetFile(filePath: string): boolean {
  const normalized = filePath.trim().replaceAll('\\', '/')
  if (/^(?:\/|[A-Za-z]:|~(?:\/|$))/.test(normalized)) return true

  let depth = 0
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (depth === 0) return true
      depth -= 1
    } else {
      depth += 1
    }
  }
  return false
}
