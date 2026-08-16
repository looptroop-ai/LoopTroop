import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUNDLE_ROOT,
  bundleFileName,
  CHANNEL_MARKER,
  DESCRIPTOR_PATH,
  parseDescriptor,
  parseWingetInstaller,
  renderAurPackage,
  renderWingetManifests,
  WINGET_IDENTIFIER,
  WINGET_MANIFEST_VERSION,
  wingetManifestDir,
  windowsBinaryZipName,
  renderChocolateyInstall,
  renderChocolateyUninstall,
  renderDescriptor,
  renderHomebrewFormula,
  renderNuspec,
  renderScoopManifest,
  renderVerification,
  SHORT_DESCRIPTION,
  AUR_PACKAGE_NAME,
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

  it('depends on a Node meeting the floor, on git, and on gh', () => {
    expect(manifest.depends).toEqual(['nodejs-lts', 'git', 'gh'])
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

describe('the Chocolatey install scripts', () => {
  const install = renderChocolateyInstall(INPUTS.version)
  const uninstall = renderChocolateyUninstall()

  it('extracts the archive that actually travels in the package', () => {
    expect(install).toContain(bundleFileName(INPUTS.version))
  })

  /** `Get-ChocolateyUnzip` unwraps the gzip first and the tar second. */
  it('unpacks a tar.gz in the two passes Chocolatey needs', () => {
    expect(install.match(/Get-ChocolateyUnzip/g)).toHaveLength(2)
  })

  it('fails loudly if the archive did not unpack where the script expects', () => {
    expect(install).toContain('throw')
    expect(install).toContain('package.json')
  })

  it('writes the channel marker at the package root', () => {
    expect(install).toContain(CHANNEL_MARKER)
    expect(install).toContain(BUNDLE_ROOT)
  })

  /** A `#!` script cannot be shimmed on Windows. */
  it('shims the cmd wrapper', () => {
    expect(install).toContain("Install-BinFile -Name 'looptroop'")
    expect(install).toContain('looptroop.cmd')
  })

  /**
   * The shim lives in Chocolatey's own bin directory and survives the package
   * directory being deleted, so removing it has to be asked for by name.
   */
  it('removes the shim on uninstall', () => {
    expect(uninstall).toContain("Uninstall-BinFile -Name 'looptroop'")
  })
})

describe('the Chocolatey verification file', () => {
  const verification = renderVerification(INPUTS)

  it('names the release the embedded archive came from and its checksum', () => {
    expect(verification).toContain(INPUTS.url)
    expect(verification).toContain(INPUTS.sha256)
    expect(verification).toContain(bundleFileName(INPUTS.version))
  })

  it('tells a moderator the command that checks it', () => {
    expect(verification).toContain('Get-FileHash')
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

/**
 * WinGet's manifests, which are a different shape from the other three: three
 * files rather than one, and submitted as a pull request into a repository
 * Microsoft owns rather than written into one of ours.
 *
 * The URL is the ZIP, not the tarball. `InstallerType: zip` means ZIP, and
 * pointing WinGet at a `.tar.gz` produces a package that validates and then
 * fails to unpack on a user's machine.
 */
describe('the WinGet manifests', () => {
  const WINGET_INPUTS = {
    version: '9.9.9',
    url: 'https://github.com/looptroop-ai/LoopTroop/releases/download/v9.9.9/looptroop-9.9.9-win-x64.zip',
    sha256: '3c5fe4640000000000000000000000000000000000000000000000000000abcd',
  }

  const rendered = () => renderWingetManifests(WINGET_INPUTS)

  it('renders exactly the three files WinGet requires', () => {
    expect(Object.keys(rendered()).sort()).toEqual([
      `${WINGET_IDENTIFIER}.installer.yaml`,
      `${WINGET_IDENTIFIER}.locale.en-US.yaml`,
      `${WINGET_IDENTIFIER}.yaml`,
    ])
  })

  it.each([
    `${WINGET_IDENTIFIER}.yaml`,
    `${WINGET_IDENTIFIER}.installer.yaml`,
    `${WINGET_IDENTIFIER}.locale.en-US.yaml`,
  ])('matches the golden file for %s', (file) => {
    const path = join(fixtures, 'winget', file)
    const text = rendered()[file]!

    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, text)

    expect(text).toBe(readFileSync(path, 'utf8'))
  })

  it('states the same schema version in every file, which validation requires', () => {
    for (const text of Object.values(rendered())) {
      expect(text).toContain(`ManifestVersion: ${WINGET_MANIFEST_VERSION}`)
    }
  })

  it('names the same package and version in every file', () => {
    for (const text of Object.values(rendered())) {
      expect(text).toContain(`PackageIdentifier: ${WINGET_IDENTIFIER}`)
      expect(text).toContain('PackageVersion: 9.9.9')
    }
  })

  /**
   * Only git. The binary carries its own Node runtime, so unlike the other
   * three channels there is nothing to install for it — but `doctor` treats
   * git as required and Windows does not ship one.
   */
  it('declares git, and does not ask for a Node it already contains', () => {
    const installer = rendered()[`${WINGET_IDENTIFIER}.installer.yaml`]!
    expect(installer).toContain('PackageIdentifier: Git.Git')
    expect(installer).not.toContain('OpenJS.NodeJS')
  })

  /**
   * An `.exe`, and nothing else. `winget validate` refuses a portable whose
   * `RelativeFilePath` is any other file type — it rejected the bundle's
   * `.cmd` shim outright, which is why this channel installs the standalone
   * binary rather than the bundle the other three take.
   */
  it('shims the standalone executable, which is the only type WinGet accepts', () => {
    const installer = rendered()[`${WINGET_IDENTIFIER}.installer.yaml`]!
    expect(installer).toMatch(/RelativeFilePath: .*\.exe$/m)
    expect(installer).not.toContain('.cmd')
    expect(installer).toContain('PortableCommandAlias: looptroop')
    expect(installer).toContain('NestedInstallerType: portable')
  })

  it('points at the Windows binary archive, not the bundle', () => {
    const installer = rendered()[`${WINGET_IDENTIFIER}.installer.yaml`]!
    expect(installer).toContain(windowsBinaryZipName('9.9.9'))
    // The bundle ZIP this once pointed at no longer exists in any form, so the
    // assertion is against the name rather than a helper: nothing should
    // reintroduce a second archive for WinGet to read.
    expect(installer).not.toContain('looptroop-9.9.9-bundle.zip')
    expect(installer).not.toContain(bundleFileName('9.9.9'))
    expect(installer).toContain('InstallerType: zip')
  })

  /** WinGet writes checksums upper-case; every other channel here uses lower. */
  it('writes the checksum the way WinGet does, and reads it back the way we do', () => {
    const installer = rendered()[`${WINGET_IDENTIFIER}.installer.yaml`]!
    expect(installer).toContain(`InstallerSha256: ${WINGET_INPUTS.sha256.toUpperCase()}`)
    expect(parseWingetInstaller(installer)).toEqual({
      version: WINGET_INPUTS.version,
      url: WINGET_INPUTS.url,
      sha256: WINGET_INPUTS.sha256,
    })
  })

  it('refuses inputs that are not a version and a sha256', () => {
    expect(() => renderWingetManifests({ ...WINGET_INPUTS, version: 'latest' })).toThrow()
    expect(() => renderWingetManifests({ ...WINGET_INPUTS, sha256: 'nope' })).toThrow()
  })

  /**
   * The field describes the installed binary, not the archive carrying it.
   * `neutral` claims the payload runs anywhere, which would offer this package
   * on Windows on ARM — a target `build-binary.mjs` does not build and
   * `binaryTarget` refuses by name.
   */
  it('declares the architecture of the executable inside, not of the zip', () => {
    const installer = rendered()[`${WINGET_IDENTIFIER}.installer.yaml`]!

    expect(installer).toContain('Architecture: x64')
    expect(installer).not.toContain('Architecture: neutral')
  })

  /** The validation pipeline rejects a manifest filed anywhere else. */
  it('puts the manifests where winget-pkgs expects them', () => {
    expect(wingetManifestDir('9.9.9')).toBe('manifests/l/LoopTroopAI/LoopTroop/9.9.9')
  })

  it('reads nothing out of a file that is not a WinGet manifest', () => {
    expect(parseWingetInstaller('not yaml at all')).toEqual({ version: null, url: null, sha256: null })
  })
})

/**
 * The AUR package, which cannot be published yet.
 *
 * Registration at the AUR is closed after a security incident, so these render
 * a package nobody can push. That is the reason to test them rather than a
 * reason not to: `scripts/smoke-aur.ts` proves the package builds and installs
 * in a real Arch container, and these pin the decisions that make it a
 * *correct* AUR submission rather than merely a working one.
 */
describe('the AUR package', () => {
  const AUR_INPUTS = {
    version: '9.9.9',
    url: 'https://github.com/looptroop-ai/LoopTroop/releases/download/v9.9.9/looptroop-9.9.9-bundle.tar.gz',
    sha256: '3c5fe4640000000000000000000000000000000000000000000000000000abcd',
  }

  const rendered = () => renderAurPackage(AUR_INPUTS)

  it('renders exactly the two files the AUR requires', () => {
    expect(Object.keys(rendered()).sort()).toEqual(['.SRCINFO', 'PKGBUILD'])
  })

  /**
   * Arch's convention: a bare name builds from source, a `-bin` suffix installs
   * prebuilt artefacts. This installs a bundle a release already built, so the
   * bare name would promise a from-source build that the PKGBUILD does not do.
   */
  it('is named for what it actually does', () => {
    expect(AUR_PACKAGE_NAME).toBe('looptroop-bin')
    expect(rendered().PKGBUILD).toContain('pkgname=looptroop-bin')
  })

  /**
   * The bundle contains no compiled code and no platform-specific packages —
   * `verify-no-native-addons.mjs` is what enforces that — so one package
   * genuinely serves x86_64 and aarch64. Splitting it would publish two
   * identical packages.
   */
  it('is architecture-independent, because the bundle is', () => {
    expect(rendered().PKGBUILD).toContain("arch=('any')")
    expect(rendered()['.SRCINFO']).toContain('\tarch = any')
  })

  /**
   * Arch ships a current `nodejs`, so depending on it costs an Arch user one
   * package and saves them the 160 MB second Node the standalone executable
   * would bring. A floor rather than a pin: a rolling distribution expects the
   * current runtime.
   */
  it('depends on the distribution\'s Node rather than carrying one', () => {
    expect(rendered().PKGBUILD).toContain("depends=('nodejs>=24' 'git' 'github-cli')")
  })

  /**
   * Delivering a pull request is the last step of every ticket, so a channel
   * that can install gh does. `doctor` still only warns about a missing gh,
   * because npm, bun, pnpm and the standalone executable cannot declare it.
   */
  it('installs gh rather than suggesting it', () => {
    expect(rendered().PKGBUILD).toContain("'github-cli'")
    expect(rendered().PKGBUILD).not.toContain('optdepends=(')
    expect(rendered()['.SRCINFO']).toContain('depends = github-cli')
    expect(rendered()['.SRCINFO']).not.toContain('optdepends')
  })

  /** Installing both would put two things at /usr/bin/looptroop. */
  it('declares itself as the thing a `looptroop` package would be', () => {
    expect(rendered().PKGBUILD).toContain("provides=('looptroop')")
    expect(rendered().PKGBUILD).toContain("conflicts=('looptroop')")
  })

  /**
   * Without the marker, detection falls through every path pattern and answers
   * `unknown` — which is what it did when this package was first built, and
   * what `smoke-aur.ts` caught.
   */
  it('writes the channel marker, so doctor names the right upgrade command', () => {
    expect(rendered().PKGBUILD).toContain(`printf 'aur' >`)
    expect(rendered().PKGBUILD).toContain(CHANNEL_MARKER)
  })

  /** They cannot run on Arch, and namcap asks for a pwsh dependency to satisfy them. */
  it('drops the Windows wrappers the shared bundle carries', () => {
    expect(rendered().PKGBUILD).toContain('looptroop.cmd')
    expect(rendered().PKGBUILD).toContain('looptroop.ps1')
    expect(rendered().PKGBUILD).toMatch(/rm -f[\s\S]*looptroop\.ps1/)
  })

  /**
   * The AUR rejects a push whose `.SRCINFO` disagrees with its `PKGBUILD`.
   * Ours is rendered rather than generated, so CI diffs it against `makepkg
   * --printsrcinfo` in an Arch container; these only check it is derived from
   * the same inputs.
   */
  it('renders a .SRCINFO agreeing with the PKGBUILD it accompanies', () => {
    const { PKGBUILD, '.SRCINFO': srcinfo } = rendered()

    expect(srcinfo).toContain(`pkgbase = ${AUR_PACKAGE_NAME}`)
    expect(srcinfo).toContain(`\tpkgver = ${AUR_INPUTS.version}`)
    expect(srcinfo).toContain(`\tsha256sums = ${AUR_INPUTS.sha256}`)
    expect(PKGBUILD).toContain(`pkgver=${AUR_INPUTS.version}`)
    expect(PKGBUILD).toContain(`sha256sums=('${AUR_INPUTS.sha256}')`)
    // Every dependency the PKGBUILD declares has to appear as its own line.
    expect(srcinfo).toContain('\tdepends = nodejs>=24')
    expect(srcinfo).toContain('\tdepends = git')
  })

  it('refuses inputs that are not a version and a sha256', () => {
    expect(() => renderAurPackage({ ...AUR_INPUTS, version: 'latest' })).toThrow()
    expect(() => renderAurPackage({ ...AUR_INPUTS, sha256: 'nope' })).toThrow()
  })
})
