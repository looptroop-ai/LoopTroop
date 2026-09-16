/**
 * Validates a ref before request or metadata input reaches a Git argv slot.
 *
 * This deliberately follows Git's ref rules instead of rejecting ordinary
 * syntax such as slashes or `@`: callers still use valid refs, while option
 * ambiguity and the names Git itself refuses are stopped at the boundary.
 */
const UNSAFE_REF_CHARS = new Set([' ', '~', '^', ':', '?', '*', '[', '\\'])

function hasUnsafeRefCharacter(ref: string): boolean {
  return [...ref].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f || UNSAFE_REF_CHARS.has(character)
  })
}

export function assertSafeRefName(ref: string, label = 'Git ref'): string {
  const components = typeof ref === 'string' ? ref.split('/') : []
  if (
    typeof ref !== 'string'
    || ref.length === 0
    || ref === '@'
    || ref.startsWith('-')
    || ref.startsWith('/')
    || ref.endsWith('/')
    || ref.includes('//')
    || ref.includes('..')
    || ref.includes('@{')
    || hasUnsafeRefCharacter(ref)
    || ref.startsWith('.')
    || ref.endsWith('.')
    || components.some((component) => component.startsWith('.')
      || component.endsWith('.')
      || component.toLowerCase().endsWith('.lock'))
  ) {
    throw new Error(`${label} is not a safe Git ref: ${JSON.stringify(ref)}`)
  }
  return ref
}
