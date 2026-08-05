import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { extractReleaseNotes, findRelease, parseChangelog, renderReleaseNotes } from '../scripts/changelog-release-notes'

const SAMPLE_CHANGELOG = `# Changelog

All notable changes are documented here.

---

## Unreleased

### Summary
- Unreleased feature A
- Unreleased feature B

### Added
- Added feature X

---

## 7.1.4 (2026-01-02)

### Release Highlights
- 🎨 **Visual Prompts Editor:** Full customization.
- 📱 **Mobile Overhaul:** Responsive layouts.

### Summary
- Collapsed the changelog by default.
- Added a Prompts editor.

### Added
- Added feature Y

---

## 7.1.3 (2026-01-20)

### Summary
- First public release.
`

describe('changelog-release-notes', () => {
  describe('parseChangelog', () => {
    it('extracts all release sections', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      expect(releases).toHaveLength(3)
      expect(releases[0]?.version).toBe('Unreleased')
      expect(releases[1]?.version).toBe('7.1.4')
      expect(releases[2]?.version).toBe('7.1.3')
    })

    it('captures date when present', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      expect(releases[0]?.date).toBeNull()
      expect(releases[1]?.date).toBe('2026-01-02')
      expect(releases[2]?.date).toBe('2026-01-20')
    })

    it('groups entries under section headings', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      const unreleased = releases[0]!
      const summary = unreleased.sections.find((s) => s.heading === 'Summary')
      const added = unreleased.sections.find((s) => s.heading === 'Added')
      expect(summary?.entries).toEqual(['Unreleased feature A', 'Unreleased feature B'])
      expect(added?.entries).toEqual(['Added feature X'])
    })

    it('stops at horizontal rules', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      const v041 = releases[1]!
      expect(v041.sections).toHaveLength(3)
    })
  })

  describe('findRelease', () => {
    it('finds a release by exact version', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      const release = findRelease(releases, '7.1.4')
      expect(release.version).toBe('7.1.4')
    })

    it('strips leading v prefix', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      const release = findRelease(releases, 'v7.1.4')
      expect(release.version).toBe('7.1.4')
    })

    it('throws with available versions when not found', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      expect(() => findRelease(releases, '999.0.0')).toThrow(/No changelog section found/)
      expect(() => findRelease(releases, '999.0.0')).toThrow(/Unreleased, 7\.1\.4, 7\.1\.3/)
    })
  })

  describe('renderReleaseNotes', () => {
    it('prefers Release Highlights over Summary', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      const notes = renderReleaseNotes(findRelease(releases, '7.1.4'))
      expect(notes).toContain('🎨 **Visual Prompts Editor:**')
      expect(notes).toContain('📱 **Mobile Overhaul:**')
      expect(notes).not.toContain('Collapsed the changelog')
    })

    it('falls back to Summary when no Release Highlights', () => {
      const releases = parseChangelog(SAMPLE_CHANGELOG)
      const notes = renderReleaseNotes(findRelease(releases, '7.1.3'))
      expect(notes).toBe('- First public release.')
    })

    it('throws when both are missing or empty', () => {
      const emptyRelease = parseChangelog('## 1.0.0\n\n### Changed\n- Something\n')[0]!
      expect(() => renderReleaseNotes(emptyRelease)).toThrow(/has no "Release Highlights" or "Summary" entries/)
    })
  })

  describe('extractReleaseNotes', () => {
    it('extracts from the real changelog file', () => {
      // Derived, not hardcoded: the newest tagged release changes every release.
      const releases = parseChangelog(readFileSync('docs/changelog.md', 'utf8'))
      const latestTagged = releases.find((release) => release.version !== 'Unreleased')
      expect(latestTagged).toBeDefined()

      const notes = extractReleaseNotes('docs/changelog.md', latestTagged!.version)
      expect(notes.length).toBeGreaterThan(0)
      expect(notes.startsWith('- ')).toBe(true)
    })
  })
})
