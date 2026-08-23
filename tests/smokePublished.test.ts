import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { planMatrix, CHANNELS, binaryPrefix } from '../scripts/smoke-published.mjs'

/**
 * The matrix is asserted by name rather than by count.
 *
 * Every hand-count of this matrix during planning was wrong — four times, in
 * four different directions — and a count alone would still let one leg be
 * swapped for another silently. Naming them means adding, moving or removing a
 * leg has to be an explicit edit here, where the reviewer sees it.
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

/** Everything the release tier runs, plus the rot-detection legs. */
const WEEKLY_ONLY_LEGS = [
  'installer-sh-binary (ubuntu-latest)',
  'installer-ps1-binary (windows-latest)',
  'homebrew (ubuntu-latest)',
  'bun (ubuntu-latest)',
  'pnpm (ubuntu-latest)',
  'yarn (ubuntu-latest)',
  'binary-linux-x64 (ubuntu-latest)',
  'binary-win-x64 (windows-latest)',
  'container (ubuntu-latest)',
]

describe('planMatrix', () => {
  it('emits exactly the release-tier legs, by name', () => {
    const names = planMatrix({ tier: 'release' }).map((leg) => leg.name)
    expect(names.sort()).toEqual([...RELEASE_LEGS].sort())
  })

  it('emits exactly the weekly-tier legs, by name', () => {
    const names = planMatrix({ tier: 'weekly' }).map((leg) => leg.name)
    expect(names.sort()).toEqual([...RELEASE_LEGS, ...WEEKLY_ONLY_LEGS].sort())
  })

  it('makes the weekly tier a superset of the release tier', () => {
    const release = planMatrix({ tier: 'release' }).map((leg) => leg.name)
    const weekly = planMatrix({ tier: 'weekly' }).map((leg) => leg.name)
    for (const name of release) expect(weekly).toContain(name)
  })

  it('leaves a channel unscheduled when --skip names it', () => {
    // How a failed publish is handled: the leg is never scheduled, rather than
    // run and failed on the version the feed still serves, which would report a
    // second time on an incident the release report already names.
    const names = planMatrix({ tier: 'release', skip: ['homebrew', 'scoop'] }).map((leg) => leg.name)
    expect(names).not.toContain('homebrew (macos-latest)')
    expect(names).not.toContain('scoop (windows-latest)')
    expect(names).toContain('npm (ubuntu-latest)')
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
    // anything, which is most of the point of testing a published release. The
    // container is the one exemption: the image ships no OpenCode by design and
    // its own smoke script is mock-only for that reason.
    for (const leg of planMatrix({ tier: 'weekly' })) {
      if (CHANNELS[leg.channel].delegate) continue
      expect(leg.opencode, `${leg.name} is on mock`).not.toBe('mock')
    }
  })

  it('gives every node manager its own upgrade command, never npm\'s', () => {
    // bun and pnpm both once reported channel `npm` and offered
    // `npm install -g`, which installs a *second* copy under npm's prefix and
    // leaves the first in place — so which one answers depends on PATH order.
    // Asserting only that some channel was reported passes on exactly that.
    for (const key of ['bun', 'pnpm', 'yarn']) {
      expect(CHANNELS[key].expect.channel).toBe(key)
      expect(CHANNELS[key].expect.upgradeCommand('linux')).toContain(key)
      expect(CHANNELS[key].expect.upgradeCommand('linux')).not.toContain('npm install')
    }
  })

  it('never schedules a stub, but always names it', () => {
    // Chocolatey, WinGet and the AUR are written down as explicitly uncovered
    // rather than omitted. A channel nobody mentions is indistinguishable from
    // a channel nobody covers, and these are the ones most likely to be assumed
    // done because CI builds their packages on every change.
    const scheduled = planMatrix({ tier: 'weekly' }).map((leg) => leg.channel)
    for (const key of ['chocolatey', 'winget', 'aur']) {
      expect(CHANNELS[key].stub, `${key} has no stated reason`).toBeTruthy()
      expect(scheduled).not.toContain(key)
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

describe('workflow dispatch wiring', () => {
  const workflow = readFileSync('.github/workflows/published-smoke.yml', 'utf8')

  /** The `workflow_dispatch` inputs the smoke workflow actually declares. */
  function declaredInputs(): Set<string> {
    const block = workflow.slice(workflow.indexOf('workflow_dispatch:'), workflow.indexOf('schedule:'))
    return new Set([...block.matchAll(/^ {6}([a-z_]+):$/gm)].map((m) => m[1]))
  }

  /** Every `-f name=` a workflow passes when dispatching the smoke. */
  function dispatchedInputs(file: string): Array<{ file: string, name: string }> {
    const text = readFileSync(file, 'utf8')
    return text
      .split('gh workflow run published-smoke.yml')
      .slice(1)
      .flatMap((block) => [...block.split(/\n\s*\n/)[0].matchAll(/-f ([a-z_]+)=/g)]
        .map((m) => ({ file, name: m[1] })))
  }

  it('passes only inputs the smoke workflow declares', () => {
    // A name that does not exist is a 422 from `gh workflow run`, and the only
    // place that surfaces is a real release — after the tag, when the thing it
    // was meant to verify has already shipped. Both dispatchers are checked:
    // the one in the release, and the one that verifies a repaired channel.
    const declared = declaredInputs()
    expect(declared.size).toBeGreaterThan(0)

    const dispatched = [
      ...dispatchedInputs('.github/workflows/release.yml'),
      ...dispatchedInputs('.github/workflows/channel-republish.yml'),
    ]
    expect(dispatched.length).toBeGreaterThan(0)

    for (const { file, name } of dispatched) {
      expect(declared.has(name), `${file} passes -f ${name}, which is not declared`).toBe(true)
    }
  })

  it('keeps the release dispatch on stable releases only', () => {
    // A release candidate publishes to npm under a different dist-tag and never
    // touches the tap, the bucket or `releases/latest`, so every non-npm leg
    // would assert against the previous stable release.
    const release = readFileSync('.github/workflows/release.yml', 'utf8')
    const job = release.slice(release.indexOf('published-smoke-dispatch:'))
    expect(job.slice(0, job.indexOf('steps:'))).toContain("dist_tag == 'latest'")
  })

  it('gives every gh step a token as well as a permission', () => {
    // `permissions:` scopes a token; it does not put one in the environment.
    // Without GH_TOKEN a `gh` call fails with an auth error rather than a
    // permissions one, which is a confusing way to learn this.
    for (const file of ['.github/workflows/release.yml', '.github/workflows/channel-republish.yml']) {
      const text = readFileSync(file, 'utf8')
      for (const block of text.split('gh workflow run published-smoke.yml').slice(1)) {
        // The env block sits above the run block within the same step.
        const step = text.slice(0, text.indexOf(block)).lastIndexOf('- name:')
        expect(text.slice(step, text.indexOf(block)), `${file} dispatch step`).toContain('GH_TOKEN')
      }
    }
  })
})
