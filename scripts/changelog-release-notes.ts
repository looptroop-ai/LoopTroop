import { readFileSync } from 'node:fs'

/**
 * Extracts release notes from the root CHANGELOG.md.
 *
 * The release workflow publishes whatever this returns, so the heading
 * contract below is load-bearing: a silent parse failure ships an empty
 * GitHub Release. Every failure mode therefore throws with the reason.
 *
 * Contract:
 * - Each release is a level-2 heading: `## <version> (<date>)`.
 * - Unreleased work sits under `## Unreleased`.
 * - A release section runs until the next level-2 heading or a `---` rule.
 * - Level-3 headings (`### Summary`, `### Added`, ...) group entries.
 */

export interface ChangelogSection {
  heading: string
  entries: string[]
}

export interface ChangelogRelease {
  version: string
  date: string | null
  sections: ChangelogSection[]
}

const RELEASE_HEADING = /^##\s+(?<version>Unreleased|\d+\.\d+\.\d+(?:-[\w.]+)?)\s*(?:\((?<date>[^)]+)\))?\s*$/
const SECTION_HEADING = /^###\s+(?<heading>.+?)\s*$/
const HORIZONTAL_RULE = /^-{3,}\s*$/
const LIST_ENTRY = /^[-*]\s+(?<entry>.+?)\s*$/

/** VitePress `::: details` wrappers are presentation, not content. */
const CONTAINER_DIRECTIVE = /^:::/

export function parseChangelog(markdown: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = []
  let currentRelease: ChangelogRelease | null = null
  let currentSection: ChangelogSection | null = null

  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trimEnd()

    const releaseMatch = RELEASE_HEADING.exec(line)
    if (releaseMatch?.groups) {
      currentRelease = {
        version: releaseMatch.groups.version!,
        date: releaseMatch.groups.date?.trim() ?? null,
        sections: [],
      }
      currentSection = null
      releases.push(currentRelease)
      continue
    }

    if (!currentRelease) continue

    if (HORIZONTAL_RULE.test(line)) {
      currentSection = null
      continue
    }

    const sectionMatch = SECTION_HEADING.exec(line)
    if (sectionMatch?.groups) {
      currentSection = { heading: sectionMatch.groups.heading!, entries: [] }
      currentRelease.sections.push(currentSection)
      continue
    }

    if (CONTAINER_DIRECTIVE.test(line)) continue

    const entryMatch = LIST_ENTRY.exec(line)
    if (entryMatch?.groups && currentSection) {
      currentSection.entries.push(entryMatch.groups.entry!)
    }
  }

  return releases
}

export function findRelease(releases: ChangelogRelease[], version: string): ChangelogRelease {
  const normalized = version.replace(/^v/, '')
  const release = releases.find((candidate) => candidate.version === normalized)
  if (!release) {
    const known = releases.map((candidate) => candidate.version).join(', ')
    throw new Error(
      `No changelog section found for version "${normalized}". `
      + `Expected a heading like "## ${normalized} (YYYY-MM-DD)" in CHANGELOG.md. `
      + `Found: ${known || '(none)'}`,
    )
  }
  return release
}

/**
 * Renders GitHub Release body text.
 *
 * Prefers `Release Highlights`, falling back to `Summary`, because the
 * per-category sections are written for contributors rather than users.
 */
export function renderReleaseNotes(release: ChangelogRelease): string {
  const preferred = release.sections.find((section) => section.heading === 'Release Highlights')
    ?? release.sections.find((section) => section.heading === 'Summary')

  if (!preferred || preferred.entries.length === 0) {
    throw new Error(
      `Changelog section for "${release.version}" has no "Release Highlights" or "Summary" entries. `
      + 'Release notes would be empty.',
    )
  }

  return preferred.entries.map((entry) => `- ${entry}`).join('\n')
}

export function extractReleaseNotes(changelogPath: string, version: string): string {
  const releases = parseChangelog(readFileSync(changelogPath, 'utf8'))
  return renderReleaseNotes(findRelease(releases, version))
}
