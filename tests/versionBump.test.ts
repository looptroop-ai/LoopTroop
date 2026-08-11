import { describe, expect, it } from 'vitest'
import {
  assertForwardBump,
  bumpChangelog,
  bumpLockfile,
  bumpManifest,
  compareVersions,
  distTagFor,
  isForwardBump,
  isPrerelease,
  parseVersion,
} from '../scripts/version-bump'

const CHANGELOG = `# Changelog

All notable changes are documented here.

---

## Unreleased

> Changes merged since the last versioned release that have not yet shipped in a tagged version.

### Summary
- Added a thing.
- Fixed another thing.

### Changed
- Renamed something.

## 0.4.1 (2026-07-02)

### Summary
- The previous release.
`

describe('parseVersion', () => {
  it('accepts a stable release', () => {
    expect(parseVersion('0.5.0')).toEqual({ major: 0, minor: 5, patch: 0, prerelease: null })
  })

  it('accepts a release candidate', () => {
    expect(parseVersion('1.2.3-rc.4')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: 4 })
  })

  it('accepts multi-digit fields', () => {
    expect(parseVersion('10.20.30')).toEqual({ major: 10, minor: 20, patch: 30, prerelease: null })
  })

  // npm accepts the string but semver does not define it, so it sorts
  // unpredictably against rc.1 and rc.2 and the `next` dist-tag stops implying
  // the ordering users actually see.
  it('rejects a leading zero in the release-candidate number', () => {
    expect(() => parseVersion('0.5.0-rc.01')).toThrow(/leading zero/i)
  })

  it('rejects a leading zero in a numeric field', () => {
    expect(() => parseVersion('0.05.0')).toThrow(/leading zero/i)
  })

  it('rejects a release candidate numbered from zero', () => {
    expect(() => parseVersion('0.5.0-rc.0')).toThrow(/first candidate is -rc\.1/)
  })

  it.each([
    ['a leading v', 'v0.5.0'],
    ['two fields', '0.5'],
    ['four fields', '0.5.0.1'],
    ['a dist-tag', 'latest'],
    ['an unsupported prerelease name', '0.5.0-beta.1'],
    ['an unnumbered candidate', '0.5.0-rc'],
    ['build metadata', '0.5.0+build.1'],
    ['an empty string', ''],
    ['surrounding whitespace', ' 0.5.0 '],
  ])('rejects %s', (_label, value) => {
    expect(() => parseVersion(value)).toThrow()
  })
})

describe('compareVersions', () => {
  // Field-by-field on integers, not lexicographic: this is the case that makes
  // the difference visible.
  it('sorts 0.4.10 above 0.4.9', () => {
    expect(compareVersions('0.4.10', '0.4.9')).toBeGreaterThan(0)
  })

  it('orders release candidates before the stable release they lead to', () => {
    expect(compareVersions('0.5.0-rc.1', '0.5.0')).toBeLessThan(0)
    expect(compareVersions('0.5.0', '0.5.0-rc.1')).toBeGreaterThan(0)
  })

  it('orders release candidates among themselves', () => {
    expect(compareVersions('0.5.0-rc.1', '0.5.0-rc.2')).toBeLessThan(0)
    expect(compareVersions('0.5.0-rc.10', '0.5.0-rc.9')).toBeGreaterThan(0)
  })

  it('treats identical versions as equal', () => {
    expect(compareVersions('0.5.0', '0.5.0')).toBe(0)
  })

  it('sorts a full release sequence', () => {
    const sorted = ['0.5.0', '0.4.9', '0.5.0-rc.2', '0.4.10', '0.5.0-rc.1', '1.0.0']
      .sort(compareVersions)
    expect(sorted).toEqual(['0.4.9', '0.4.10', '0.5.0-rc.1', '0.5.0-rc.2', '0.5.0', '1.0.0'])
  })
})

describe('isForwardBump', () => {
  it.each([
    ['0.4.1', '0.5.0'],
    ['0.4.9', '0.4.10'],
    ['0.5.0-rc.1', '0.5.0-rc.2'],
    ['0.5.0-rc.2', '0.5.0'],
  ])('allows %s -> %s', (current, candidate) => {
    expect(isForwardBump(current, candidate)).toBe(true)
  })

  it.each([
    ['0.5.0', '0.4.1'],
    ['0.4.10', '0.4.9'],
    ['0.5.0', '0.5.0-rc.1'],
    ['0.5.0', '0.5.0'],
  ])('refuses %s -> %s', (current, candidate) => {
    expect(isForwardBump(current, candidate)).toBe(false)
  })

  it('names the current version when refusing to repeat it', () => {
    expect(() => assertForwardBump('0.4.1', '0.4.1')).toThrow(/already the current version/)
  })

  it('explains that a release cannot move backwards', () => {
    expect(() => assertForwardBump('0.5.0', '0.4.1')).toThrow(/may only move forwards/)
  })
})

describe('distTagFor', () => {
  // npm tags every publish `latest` unless told otherwise, so a candidate
  // without an explicit tag becomes what `npm i -g looptroop` installs.
  it('publishes a stable release under latest', () => {
    expect(distTagFor('0.5.0')).toBe('latest')
  })

  it('publishes a release candidate under next', () => {
    expect(distTagFor('0.5.0-rc.1')).toBe('next')
  })

  it('identifies prereleases', () => {
    expect(isPrerelease('0.5.0-rc.1')).toBe(true)
    expect(isPrerelease('0.5.0')).toBe(false)
  })
})

describe('bumpManifest', () => {
  it('replaces only the version field', () => {
    const before = '{\n  "name": "looptroop",\n  "version": "0.4.1",\n  "type": "module"\n}\n'
    expect(bumpManifest(before, '0.5.0'))
      .toBe('{\n  "name": "looptroop",\n  "version": "0.5.0",\n  "type": "module"\n}\n')
  })

  // Parse-and-stringify would reorder keys and reformat the file in the same
  // commit that changes the version, burying the one reviewable line.
  it('leaves key order and formatting untouched', () => {
    const before = '{\n  "version": "0.4.1",\n  "name": "looptroop",\n\n  "private": false\n}\n'
    const after = bumpManifest(before, '0.5.0')
    expect(after).toBe('{\n  "version": "0.5.0",\n  "name": "looptroop",\n\n  "private": false\n}\n')
  })

  it('does not touch a dependency that happens to share the version', () => {
    const before = '{\n  "version": "0.4.1",\n  "dependencies": {\n    "hono": "0.4.1"\n  }\n}\n'
    expect(bumpManifest(before, '0.5.0')).toContain('"hono": "0.4.1"')
  })

  it('fails when there is no version field', () => {
    expect(() => bumpManifest('{\n  "name": "looptroop"\n}\n', '0.5.0')).toThrow(/no "version" field/)
  })
})

describe('bumpLockfile', () => {
  // Both fields, because verify-version-single-source.mjs reads both and is a
  // required check on the release pull request. Writing one leaves the release
  // unmergeable.
  it('writes both version fields', () => {
    const before = JSON.stringify({
      name: 'looptroop',
      version: '0.4.1',
      lockfileVersion: 3,
      packages: { '': { name: 'looptroop', version: '0.4.1' }, 'node_modules/hono': { version: '4.0.0' } },
    }, null, 2)

    const parsed = JSON.parse(bumpLockfile(before, '0.5.0'))
    expect(parsed.version).toBe('0.5.0')
    expect(parsed.packages[''].version).toBe('0.5.0')
  })

  it('leaves dependency versions alone', () => {
    const before = JSON.stringify({
      version: '0.4.1',
      packages: { '': { version: '0.4.1' }, 'node_modules/hono': { version: '0.4.1' } },
    }, null, 2)

    const parsed = JSON.parse(bumpLockfile(before, '0.5.0'))
    expect(parsed.packages['node_modules/hono'].version).toBe('0.4.1')
  })

  it('writes npm\'s own formatting so a bump is not a whole-file diff', () => {
    const before = JSON.stringify({ version: '0.4.1', packages: { '': { version: '0.4.1' } } }, null, 2)
    const after = bumpLockfile(before, '0.5.0')
    expect(after.endsWith('\n')).toBe(true)
    expect(after).toContain('\n  "version": "0.5.0"')
  })

  it('fails when the root package entry is missing', () => {
    const before = JSON.stringify({ version: '0.4.1', packages: {} }, null, 2)
    expect(() => bumpLockfile(before, '0.5.0')).toThrow(/no root package entry/)
  })
})

describe('bumpChangelog', () => {
  it('turns Unreleased into the release and leaves a fresh Unreleased', () => {
    const { contents } = bumpChangelog(CHANGELOG, '0.5.0', '2026-08-11')

    expect(contents).toContain('## 0.5.0 (2026-08-11)')
    expect(contents).toContain('## Unreleased')
    expect(contents).toContain('## 0.4.1 (2026-07-02)')

    // The new empty section must come first, or the next change lands inside
    // the release that just shipped.
    expect(contents.indexOf('## Unreleased')).toBeLessThan(contents.indexOf('## 0.5.0'))
  })

  it('carries the entries into the released section', () => {
    const { releasedSection } = bumpChangelog(CHANGELOG, '0.5.0', '2026-08-11')
    expect(releasedSection).toContain('- Added a thing.')
    expect(releasedSection).toContain('- Renamed something.')
    expect(releasedSection).toContain('## 0.5.0 (2026-08-11)')
  })

  it('does not carry the placeholder note into the release', () => {
    const { releasedSection } = bumpChangelog(CHANGELOG, '0.5.0', '2026-08-11')
    expect(releasedSection).not.toContain('have not yet shipped')
  })

  it('keeps the placeholder note under the new Unreleased heading', () => {
    const { contents } = bumpChangelog(CHANGELOG, '0.5.0', '2026-08-11')
    const unreleased = contents.slice(contents.indexOf('## Unreleased'), contents.indexOf('## 0.5.0'))
    expect(unreleased).toContain('have not yet shipped')
  })

  it('leaves the previous release untouched', () => {
    const { contents } = bumpChangelog(CHANGELOG, '0.5.0', '2026-08-11')
    expect(contents).toContain('## 0.4.1 (2026-07-02)\n\n### Summary\n- The previous release.')
  })

  it('fails when there is no Unreleased section', () => {
    expect(() => bumpChangelog('# Changelog\n\n## 0.4.1 (2026-07-02)\n\n### Summary\n- Old.\n', '0.5.0', '2026-08-11'))
      .toThrow(/no "## Unreleased" heading/)
  })

  it('fails when there are two Unreleased sections', () => {
    const doubled = CHANGELOG.replace('## 0.4.1 (2026-07-02)', '## Unreleased\n\n### Summary\n- Stray.\n\n## 0.4.1 (2026-07-02)')
    expect(() => bumpChangelog(doubled, '0.5.0', '2026-08-11')).toThrow(/2 "## Unreleased" headings/)
  })

  // Both the GitHub Release body and the npm listing render this section, so an
  // empty one ships a release that describes nothing.
  it('fails when the Unreleased section has no entries', () => {
    const empty = '# Changelog\n\n## Unreleased\n\n### Summary\n\n## 0.4.1 (2026-07-02)\n\n### Summary\n- Old.\n'
    expect(() => bumpChangelog(empty, '0.5.0', '2026-08-11')).toThrow(/cannot be published as release notes/)
  })

  // The gate that matters is not "is the section blank" but "could the workflow
  // publish it". Entries under a per-category heading alone make the section
  // look populated while `renderReleaseNotes` still has nothing to render — and
  // that used to surface only at the draft step, after the bump commit and the
  // pull request already existed.
  it('fails when entries exist but none are under Release Highlights or Summary', () => {
    const categorised = '# Changelog\n\n## Unreleased\n\n### Fixed\n- A bug nobody announced.\n\n'
      + '## 0.4.1 (2026-07-02)\n\n### Summary\n- Old.\n'
    expect(() => bumpChangelog(categorised, '0.5.0', '2026-08-11'))
      .toThrow(/Release Highlights/)
  })

  it('accepts Release Highlights in place of Summary', () => {
    const highlights = '# Changelog\n\n## Unreleased\n\n### Release Highlights\n- Something users can see.\n\n'
      + '## 0.4.1 (2026-07-02)\n\n### Summary\n- Old.\n'
    const bumped = bumpChangelog(highlights, '0.5.0', '2026-08-11')
    expect(bumped.releasedSection).toContain('Something users can see.')
  })

  it('fails when the version has already been released', () => {
    expect(() => bumpChangelog(CHANGELOG, '0.4.1', '2026-08-11')).toThrow(/already has a "## 0\.4\.1" section/)
  })

  it('releases a candidate the same way', () => {
    const { contents } = bumpChangelog(CHANGELOG, '0.5.0-rc.1', '2026-08-11')
    expect(contents).toContain('## 0.5.0-rc.1 (2026-08-11)')
  })
})
