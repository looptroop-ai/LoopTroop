import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ROOT,
  CHANNEL_MARKER,
  DESCRIPTOR_PATH,
  parseDescriptor,
  renderDescriptor,
  renderHomebrewFormula,
  renderNuspec,
  renderScoopManifest,
  SHORT_DESCRIPTION,
  type Channel,
} from '../scripts/package-manifests.ts'

const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'channels')

const INPUTS = {
  version: '9.9.9',
  url: 'https://github.com/looptroop-ai/LoopTroop/releases/download/v9.9.9/looptroop-9.9.9-bundle.tar.gz',
  sha256: '3c5fe4640000000000000000000000000000000000000000000000000000abcd',
}

const GOLDEN: Record<Channel, string> = {
  homebrew: 'looptroop.rb',
  scoop: 'looptroop.json',
  chocolatey: 'looptroop.nuspec',
}

/**
 * Golden files rather than assertions on fragments. A formula is read by
 * `brew audit` and by humans, and the thing worth reviewing is the whole file:
 * a change to any line of it should show up in a diff somebody looks at, not
 * only in the two or three lines a test happened to name.
 *
 * `UPDATE_GOLDEN=1 npx vitest run tests/packageManifests.test.ts` rewrites them.
 */
describe.each(Object.entries(GOLDEN) as [Channel, string][])('the %s descriptor', (channel, file) => {
  it('matches the golden file', () => {
    const rendered = renderDescriptor(channel, INPUTS)
    const path = join(fixtures, file)

    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, rendered)

    expect(rendered).toBe(readFileSync(path, 'utf8'))
  })

  it('carries the version, the URL and the hash where a reader can find them', () => {
    expect(parseDescriptor(channel, renderDescriptor(channel, INPUTS))).toMatchObject({ version: INPUTS.version })
  })

  it('refuses inputs that are not a version and a sha256', () => {
    expect(() => renderDescriptor(channel, { ...INPUTS, version: 'latest' })).toThrow()
    expect(() => renderDescriptor(channel, { ...INPUTS, sha256: 'nope' })).toThrow()
  })

  it('renders a prerelease', () => {
    expect(() => renderDescriptor(channel, { ...INPUTS, version: '9.9.9-rc.1' })).not.toThrow()
  })
})

describe('the Homebrew formula', () => {
  const formula = renderHomebrewFormula(INPUTS)

  /**
   * `brew audit --strict` rejects a `version` that the URL already carries, and
   * the bundle URL carries one. Reading it back therefore has to scan the URL
   * the way Homebrew does — a parser that only looked for the field would call
   * every formula this renders unreadable, and every release a conflict.
   */
  it('states no version, because the URL carries one', () => {
    expect(formula).not.toMatch(/^\s*version\s/m)
    expect(parseDescriptor('homebrew', formula).version).toBe(INPUTS.version)
  })

  it('still reads a version field back when a formula has one', () => {
    const handWritten = formula.replace('  sha256 ', `  version "1.2.3"\n  sha256 `)

    expect(parseDescriptor('homebrew', handWritten).version).toBe('1.2.3')
  })

  it('scans a prerelease out of the URL too', () => {
    const prerelease = { ...INPUTS, version: '9.9.9-rc.1', url: INPUTS.url.replace(/9\.9\.9-bundle/, '9.9.9-rc.1-bundle') }

    expect(parseDescriptor('homebrew', renderHomebrewFormula(prerelease)).version).toBe('9.9.9-rc.1')
  })

  it('reads back the three fields that decide what a user installs', () => {
    expect(parseDescriptor('homebrew', formula)).toEqual({
      version: INPUTS.version,
      url: INPUTS.url,
      sha256: INPUTS.sha256,
    })
  })

  /**
   * `node@24` is keg-only, so its `node` is on nobody's PATH, and the launcher
   * starts `#!/usr/bin/env node`. A plain symlink installs green and then fails
   * with `env: node: No such file`.
   */
  it('wraps the launcher with node@24 on PATH rather than symlinking it', () => {
    expect(formula).toContain('write_env_script')
    // `formula_opt_bin` rather than `Formula[...].opt_bin`: `brew style`
    // rejects the latter, and the tap has no CI to catch that after a push.
    expect(formula).toContain('formula_opt_bin("node@24")')
    expect(formula).not.toMatch(/bin\.install_symlink/)
  })

  /** macOS provides git and `brew audit` rejects depending on it; Linuxbrew does not. */
  it('takes git from macOS and from the formula elsewhere', () => {
    expect(formula).toContain('uses_from_macos "git"')
    expect(formula).not.toContain('depends_on "git"')
  })

  it('writes the channel marker at the package root', () => {
    expect(formula).toContain(`(libexec/"${CHANNEL_MARKER}").write "homebrew"`)
  })

  it('keeps the description inside what brew audit --strict accepts', () => {
    expect(SHORT_DESCRIPTION.length).toBeLessThanOrEqual(80)
    expect(SHORT_DESCRIPTION).not.toMatch(/^(An?|The|LoopTroop)\b/)
  })
})

describe('the Scoop manifest', () => {
  const manifest = JSON.parse(renderScoopManifest(INPUTS))

  it('is valid JSON carrying the version, URL and hash', () => {
    expect(manifest).toMatchObject({ version: INPUTS.version, url: INPUTS.url, hash: INPUTS.sha256 })
  })

  /** A `#!` script cannot be shimmed on Windows, so the `.cmd` is the target. */
  it('shims the cmd wrapper, not the POSIX one', () => {
    expect(manifest.bin).toEqual([['bin\\looptroop.cmd', 'looptroop']])
  })

  it('unpacks the directory the archive actually contains', () => {
    expect(manifest.extract_dir).toBe(BUNDLE_ROOT)
  })

  it('depends on a Node meeting the floor and on git', () => {
    expect(manifest.depends).toEqual(['nodejs-lts', 'git'])
  })

  it('writes the channel marker after extracting', () => {
    expect(manifest.post_install.join('\n')).toContain(CHANNEL_MARKER)
  })

  /**
   * Autoupdate would make Excavator a second writer, computing its own hash
   * from whatever it found — and the release is meant to be the only thing that
   * says what a version's bytes are.
   */
  it('checks for versions without autoupdating them', () => {
    expect(manifest.checkver).toBeDefined()
    expect(manifest.autoupdate).toBeUndefined()
  })
})

describe('the Chocolatey nuspec', () => {
  const nuspec = renderNuspec(INPUTS)

  it('carries the version where the parser looks for it', () => {
    expect(parseDescriptor('chocolatey', nuspec).version).toBe(INPUTS.version)
  })

  it('declares the dependencies doctor treats as required', () => {
    expect(nuspec).toContain('id="nodejs-lts"')
    expect(nuspec).toContain('id="git"')
  })
})

describe('reading a descriptor somebody else wrote', () => {
  it('reports nothing rather than throwing on a file it cannot parse', () => {
    expect(parseDescriptor('scoop', 'not json at all')).toEqual({ version: null, url: null, sha256: null })
    expect(parseDescriptor('homebrew', '# an empty formula')).toEqual({ version: null, url: null, sha256: null })
  })

  it('accepts a Scoop hash written with the algorithm prefix', () => {
    const text = JSON.stringify({ version: '9.9.9', url: 'u', hash: `sha256:${INPUTS.sha256}` })

    expect(parseDescriptor('scoop', text).sha256).toBe(INPUTS.sha256)
  })

  it('reads the Chocolatey url and checksum out of the install script beside the nuspec', () => {
    const installScript = `$url = 'https://example.invalid/x.tar.gz'\n$checksum = '${INPUTS.sha256.toUpperCase()}'\n`

    expect(parseDescriptor('chocolatey', `${nuspecFixture()}\n${installScript}`)).toEqual({
      version: INPUTS.version,
      url: 'https://example.invalid/x.tar.gz',
      sha256: INPUTS.sha256,
    })
  })

  function nuspecFixture(): string {
    return renderNuspec(INPUTS)
  }
})

describe('where each descriptor lives', () => {
  it('names a path per channel', () => {
    expect(DESCRIPTOR_PATH).toEqual({
      homebrew: 'Formula/looptroop.rb',
      scoop: 'bucket/looptroop.json',
      chocolatey: 'looptroop.nuspec',
    })
  })
})
