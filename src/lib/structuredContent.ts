import * as jsYaml from 'js-yaml'

/**
 * Read an artifact's stored text as JSON, then as YAML, then give up.
 *
 * Lives in `lib` rather than beside the artifact parsers that use it most: it
 * is also what `beadsDocument` needs, and a `lib` module importing from
 * `components/workspace` inverts the dependency direction — no cycle today,
 * but it puts anything that only wants the beads focus event on a static path
 * through the workspace parser module.
 */
export function tryParseStructuredContent(content: string | null | undefined): unknown {
  if (!content?.trim()) return null

  try {
    return JSON.parse(content)
  } catch {
    try {
      return jsYaml.load(content)
    } catch {
      return null
    }
  }
}
