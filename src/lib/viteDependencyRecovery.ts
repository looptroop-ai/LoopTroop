const VITE_DEPENDENCY_URL_PATTERN = /node_modules\/\.vite\/deps\/([^?\s:)]+\.js)\?v=([a-z0-9]+)/gi
const RECOVERABLE_VITE_DEPENDENCIES = new Set([
  'react.js',
  'react-dom.js',
  'react-dom_client.js',
  '@tanstack_react-query.js',
])

export function isMixedViteReactDependencyError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false
  if (!/Cannot read properties of null \(reading ['"]use[A-Z][A-Za-z0-9]*['"]\)/.test(error.message)) {
    return false
  }

  const generations = new Set<string>()
  for (const match of error.stack?.matchAll(VITE_DEPENDENCY_URL_PATTERN) ?? []) {
    const dependency = match[1]
    const version = match[2]
    if (!dependency || !version || !RECOVERABLE_VITE_DEPENDENCIES.has(dependency)) continue

    generations.add(version)
  }

  return generations.size > 1
}

export function shouldRecoverMixedViteReactDependencyError(
  error: unknown,
  isDevelopment: boolean,
): boolean {
  return isDevelopment && isMixedViteReactDependencyError(error)
}
