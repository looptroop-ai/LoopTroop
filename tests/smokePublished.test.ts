import { describe, it, expect } from 'vitest'
import { planMatrix, CHANNELS, binaryPrefix } from '../scripts/smoke-published.mjs'

/**
 * The matrix is asserted by name rather than by count.
 *
 * Every hand-count of this matrix during planning was wrong — four times, in
 * four different directions — and a count alone would still let one leg be
 * swapped for another silently. Naming them means adding, moving or removing a
 * leg has to be an explicit edit here, where the reviewer sees it.
 *
 * These lists grow as each milestone lands. The final shape is 8 release legs
 * and 17 weekly ones; anything short of that is a milestone still in progress,
 * not a regression.
 */
const RELEASE_LEGS = [
  'npm (ubuntu-latest)',
  'npm (macos-latest)',
  'npm (windows-latest)',
  'installer-sh (ubuntu-latest)',
  'installer-sh (macos-latest)',
  'installer-ps1 (windows-latest)',
  'homebrew (macos-latest)',
  'scoop (windows-latest)',
]

describe('planMatrix', () => {
  it('emits exactly the release-tier legs, by name', () => {
    const names = planMatrix({ tier: 'release' }).map((leg) => leg.name)
    expect(names.sort()).toEqual([...RELEASE_LEGS].sort())
  })

  it('makes the weekly tier a superset of the release tier', () => {
    const release = planMatrix({ tier: 'release' }).map((leg) => leg.name)
    const weekly = planMatrix({ tier: 'weekly' }).map((leg) => leg.name)
    for (const name of release) expect(weekly).toContain(name)
    expect(weekly.length).toBeGreaterThanOrEqual(release.length)
  })

  it('gives every leg a unique name', () => {
    // The name is the job name, the artifact name and the report key. Two legs
    // sharing one would collide on artifact upload and silently overwrite a
    // result — a failure that reads as a missing leg rather than a clash.
    const names = planMatrix({ tier: 'weekly' }).map((leg) => leg.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('declares a known OpenCode mode on every leg', () => {
    const allowed = new Set(['installer', 'npm', 'adopt', 'mock', 'none'])
    for (const leg of planMatrix({ tier: 'weekly' })) {
      expect(allowed.has(leg.opencode), `${leg.name} has opencode=${leg.opencode}`).toBe(true)
    }
  })

  it('covers the OpenCode launch shape that has actually broken', () => {
    // A past release shipped a daemon that could not spawn an npm-installed
    // OpenCode on Windows, because it is `opencode.cmd` rather than an `.exe`.
    // Mock mode cannot see that class of defect, so at least one Windows leg
    // has to install OpenCode from npm and start a real daemon.
    const windowsNpmOpencode = planMatrix({ tier: 'weekly' })
      .filter((leg) => leg.os.startsWith('windows') && leg.opencode === 'npm')
    expect(windowsNpmOpencode.length).toBeGreaterThan(0)
  })

  it('never leaves a daemon leg on mock OpenCode', () => {
    // Mock would make every leg pass without proving the daemon can launch
    // anything, which is most of the point of testing a published release.
    for (const leg of planMatrix({ tier: 'weekly' })) {
      expect(leg.opencode, `${leg.name} is on mock`).not.toBe('mock')
    }
  })

  it('honours --only', () => {
    expect(planMatrix({ tier: 'weekly', only: ['npm'] }).every((leg) => leg.channel === 'npm')).toBe(true)
    expect(planMatrix({ tier: 'weekly', only: ['nothing-by-this-name'] })).toEqual([])
  })

  it('marks tap- and bucket-backed channels unpinnable', () => {
    // A tap carries one formula and a bucket one manifest, so an older version
    // is not installable at all. Claiming otherwise would make a --pin run
    // report a failure for a channel that is working exactly as designed.
    for (const key of ['homebrew', 'scoop']) expect(CHANNELS[key].pinnable).toBe(false)
    for (const key of ['npm', 'installer-sh', 'installer-ps1']) expect(CHANNELS[key].pinnable).toBe(true)
  })

  it('only claims a self-contained runtime where the channel provides one', () => {
    // Homebrew installs keg-only node@24 and wires it up in a wrapper, and the
    // standalone binary embeds Node — both must run with no Node on PATH.
    // Scoop *depends* on nodejs-lts rather than carrying it, so stripping Node
    // would break it correctly, and asserting otherwise would be wrong.
    expect(CHANNELS.homebrew.provesOwnRuntime).toBe(true)
    expect(CHANNELS.scoop.provesOwnRuntime).toBeUndefined()
    expect(CHANNELS.npm.provesOwnRuntime).toBeUndefined()
  })

  it('runs the documented command verbatim when it is not pinned', () => {
    // The website URL is the path a user takes, and exercising the redirect is
    // half the point of the leg.
    const sh = CHANNELS['installer-sh'].install({ version: '9.9.9', pin: false })
    expect(sh.display).toBe('curl -fsSL https://www.looptroop.ovh/install | sh')

    const ps1 = CHANNELS['installer-ps1'].install({ version: '9.9.9', pin: false })
    expect(ps1.display).toBe('irm https://www.looptroop.ovh/install.ps1 | iex')
  })

  it('fetches a pinned wrapper from the release, never from the website', () => {
    // The website always points at releases/latest, so pinning through it would
    // pair the newest wrapper with an older payload and prove nothing about the
    // release being reproduced.
    for (const key of ['installer-sh', 'installer-ps1']) {
      const spec = CHANNELS[key].install({ version: '9.9.9', pin: true })
      expect(spec.display).toContain('/releases/download/v9.9.9/')
      expect(spec.display).not.toContain('looptroop.ovh')
      expect(spec.display).toMatch(/-{1,2}[Vv]ersion 9\.9\.9/)
    }
  })

  it('drives PowerShell 5.1 with the progress bar silenced', () => {
    // `powershell.exe` is Windows PowerShell 5.1, the runtime that ships with
    // Windows and therefore the one the documented one-liner lands in. `pwsh`
    // is a different runtime. The progress bar makes `irm` take minutes.
    const spec = CHANNELS['installer-ps1'].install({ version: '9.9.9', pin: false })
    expect(spec.command).toBe('powershell.exe')
    expect(spec.args.join(' ')).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(spec.args).toContain('-NoProfile')
  })

  it('expects the npm channel from the installers default mode', () => {
    // The installer writes no marker file, so the channel is inferred from where
    // the module lands — and in default mode it hands the tarball to
    // `npm install -g`. Anyone "correcting" these to an installer-shaped channel
    // breaks the legs.
    for (const key of ['installer-sh', 'installer-ps1']) {
      expect(CHANNELS[key].expect.channel).toBe('npm')
      expect(CHANNELS[key].uninstall({}).args).toEqual(['uninstall', '--global', 'looptroop'])
    }
    for (const key of ['installer-sh-binary', 'installer-ps1-binary']) {
      expect(CHANNELS[key].expect.channel).toBe('binary')
    }
  })

  it('gives the binary channel a platform-specific upgrade command', () => {
    // A piped script cannot take a parameter, so Windows needs the scriptblock
    // form. One string here would fail on one of the two operating systems.
    const { upgradeCommand } = CHANNELS['installer-sh-binary'].expect
    expect(upgradeCommand('win32')).toContain('scriptblock')
    expect(upgradeCommand('linux')).toBe('curl -fsSL https://www.looptroop.ovh/install | sh -s -- --binary')
    expect(upgradeCommand('win32')).not.toBe(upgradeCommand('linux'))
  })

  it('never points the binary uninstall at the configuration directory', () => {
    // This path is handed to a recursive delete. The install prefix is
    // `~/.looptroop`; the configuration directory — which holds the database —
    // is `~/.config/looptroop`. Confusing them would delete a user's data, and
    // on a developer machine, this test's own.
    const prefix = binaryPrefix()
    for (const key of ['installer-sh-binary', 'installer-ps1-binary']) {
      expect(CHANNELS[key].uninstall({}).removePath).toBe(prefix)
    }
    expect(prefix).not.toContain('.config')
    expect(prefix.endsWith('.looptroop')).toBe(true)
  })

  it('gives every channel its own daemon and OpenCode port', () => {
    // Two channels sharing a port would collide only when both run on one
    // runner, which is rare enough to look like a flake rather than a clash.
    const daemonPorts = Object.values(CHANNELS).map((c) => c.port).filter(Boolean)
    const opencodePorts = Object.values(CHANNELS).map((c) => c.opencodePort).filter(Boolean)
    expect(new Set(daemonPorts).size).toBe(daemonPorts.length)
    expect(new Set(opencodePorts).size).toBe(opencodePorts.length)
    // 39117 is smoke-install.mjs's port; overlapping it would break a run that
    // happened to share a machine.
    expect(daemonPorts).not.toContain(39117)
    for (const port of [...daemonPorts, ...opencodePorts]) expect(port).toBeGreaterThan(39117)
  })
})
