export function isBeadTargetFile(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex -- Target paths must not add prompt lines or control characters.
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)
}

/** Classify path spellings without depending on the machine displaying them. */
export function isExternalTargetFile(filePath: unknown): boolean {
  if (!isBeadTargetFile(filePath)) return false
  const normalized = filePath.trim().replaceAll('\\', '/')
  if (/^(?:\/|[A-Za-z]:|~(?:[^/]*\/|$))/.test(normalized)) return true

  if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|\$|%[^%]+%)/.test(normalized)) return true

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
