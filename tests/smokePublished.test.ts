import { describe, it, expect } from 'vitest'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'
import {
  planMatrix,
  CHANNELS,
  binaryPrefix,
  chocolateySearchOutcome,
  chocolateySearchVersion,
  chocolateySubmission,
  createOpenCodeAdoptCredentials,
  isOpenCodeInfoReady,
  moderationSkipReason,
  openCodeAnswers,
  validatePublishedVersion,
  whichLooptroop,
  wingetSubmission,
} from '../scripts/smoke-published.mjs'
import { WINGET_IDENTIFIER } from '../scripts/package-manifests'
import type { ChannelRecipe, InstalledChannel } from '../scripts/smoke-published.mjs'

/**
 * A channel by name.
 *
 * Every lookup below names a channel this file also asserts the existence of,
 * so a name that is not there is a broken test rather than a case to handle —
 * and saying so here fails with the name instead of with a property read on
 * `undefined` several lines later.
 */
function channel(key: string): ChannelRecipe {
  const recipe = CHANNELS[key]
  if (!recipe) throw new Error(`no channel named "${key}"`)
  return recipe
}

/**
 * A channel this driver installs itself — not a stub, not delegated.
 *
 * The narrowing is the point: `install`, `uninstall`, `expect` and the ports
 * exist only on this shape, and the assertions that reach for them are
 * meaningless against a channel that has none.
 */
function installedChannel(key: string): InstalledChannel {
  const recipe = channel(key)
  // `!== undefined` rather than truthiness: a stub's reason is a string, and an
  // empty one would still make it a stub.
  if (recipe.stub !== undefined) throw new Error(`"${key}" is a stub, not an installed channel`)
  if (recipe.delegate !== undefined) throw new Error(`"${key}" delegates, so it has no install of its own`)
  return recipe
}

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
  // Weekly rather than release-tier because both publish into a queue: at
  // release time the feed is still serving the previous version, by design.
  'chocolatey (windows-latest)',
  'winget (windows-latest)',
]

describe('planMatrix', () => {
  it('allows SemVer release names but rejects shell syntax', () => {
    expect(validatePublishedVersion('9.9.9')).toBe('9.9.9')
    expect(validatePublishedVersion('9.9.9-rc.1')).toBe('9.9.9-rc.1')

    for (const value of [
      '9.9.9; touch owned',
      '9.9.9 && whoami',
      '9.9.9|whoami',
      '9.9.9%PATH%',
      '9.9.9$(whoami)',
      '../9.9.9',
      '9.9.9-rc.01',
    ]) {
      expect(() => validatePublishedVersion(value), value).toThrow('invalid release version')
    }
  })

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

  it('exercises the adopt path on exactly one leg', () => {
    // `startDaemon` has two OpenCode paths — spawn one, or adopt a server that
    // is already listening. Without a leg set to adopt, that branch is never
    // executed against a published release and the driver's support for it is
    // dead code. More than one would be duplicate coverage of the rarer path
    // at the cost of the commoner one.
    const adopt = planMatrix({ tier: 'weekly' }).filter((leg) => leg.opencode === 'adopt')
    expect(adopt.map((leg) => leg.name)).toEqual(['bun (ubuntu-latest)'])
  })

  it('declares a known OpenCode mode on every leg', () => {
    // No `installer`: nothing in the workflow provisions it, so a leg set to it
    // would run with no OpenCode at all and fail for a reason that looks like
    // the release's fault.
    const allowed = new Set(['npm', 'npm-v1', 'adopt', 'mock', 'none'])
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
      .filter((leg) => leg.os.startsWith('windows') && ['npm', 'npm-v1'].includes(leg.opencode))
    expect(windowsNpmOpencode.length).toBeGreaterThan(0)
  })

  it('keeps the published npm channel name while using v2 on supported platforms and v1 on Windows', () => {
    const npmLegs = planMatrix({ tier: 'weekly', only: ['npm'] })
    expect(npmLegs.map(({ name, channel, os, opencode }) => ({ name, channel, os, opencode }))).toEqual([
      { name: 'npm (ubuntu-latest)', channel: 'npm', os: 'ubuntu-latest', opencode: 'npm' },
      { name: 'npm (macos-latest)', channel: 'npm', os: 'macos-latest', opencode: 'npm' },
      { name: 'npm (windows-latest)', channel: 'npm', os: 'windows-latest', opencode: 'npm-v1' },
    ])

    for (const leg of planMatrix({ tier: 'weekly' })) {
      if (leg.os.startsWith('windows')) expect(leg.opencode, leg.name).toBe('npm-v1')
      if (leg.opencode === 'npm-v1') expect(leg.os.startsWith('windows'), leg.name).toBe(true)
      if (leg.opencode === 'npm' || leg.opencode === 'adopt') {
        expect(['ubuntu-latest', 'macos-latest']).toContain(leg.os)
      }
    }
  })

  it('never leaves a daemon leg on mock OpenCode', () => {
    // Mock would make every leg pass without proving the daemon can launch
    // anything, which is most of the point of testing a published release. The
    // container is the one exemption: the image ships no OpenCode by design and
    // its own smoke script is mock-only for that reason.
    for (const leg of planMatrix({ tier: 'weekly' })) {
      if (channel(leg.channel).delegate) continue
      expect(leg.opencode, `${leg.name} is on mock`).not.toBe('mock')
    }
  })

  it('gives every node manager its own upgrade command, never npm\'s', () => {
    // bun and pnpm both once reported channel `npm` and offered
    // `npm install -g`, which installs a *second* copy under npm's prefix and
    // leaves the first in place — so which one answers depends on PATH order.
    // Asserting only that some channel was reported passes on exactly that.
    for (const key of ['bun', 'pnpm', 'yarn']) {
      const expected = installedChannel(key).expect
      expect(expected.channel).toBe(key)
      expect(expected.upgradeCommand('linux')).toContain(key)
      expect(expected.upgradeCommand('linux')).not.toContain('npm install')
    }
  })

  it('never schedules a stub, but always names it', () => {
    // The AUR is written down as explicitly uncovered rather than omitted. A
    // channel nobody mentions is indistinguishable from a channel nobody
    // covers, and this is the one most likely to be assumed done because CI
    // builds its package on every change.
    const scheduled = planMatrix({ tier: 'weekly' }).map((leg) => leg.channel)
    for (const key of ['aur']) {
      expect(channel(key).stub, `${key} has no stated reason`).toBeTruthy()
      expect(scheduled).not.toContain(key)
    }
  })

  it('schedules a moderated channel weekly, and says which queue it waits in', () => {
    // A release-tier leg would run minutes after the tag, when the feed is
    // still serving the previous version because nobody has reviewed this one
    // yet — a red that means nothing. The weekly run is the first moment the
    // question "did this release reach the feed" can have a useful answer, and
    // `moderated` is what keeps an unanswered one from reading as a failure.
    for (const key of ['chocolatey', 'winget']) {
      const recipe = installedChannel(key)
      expect(recipe.moderated?.queue, `${key} names no queue`).toBeTruthy()
      expect(recipe.moderated?.graceDays, `${key} has no grace period`).toBeGreaterThan(0)
      expect(recipe.legs.map((leg) => leg.tier)).toEqual(['weekly'])
      // Both keep every published version, so a pinned run is meaningful.
      expect(recipe.pinnable).toBe(true)
    }
  })

  it('reads the served version out of a choco search listing', () => {
    // `choco search --limit-output` prints `id|version`, and only for versions
    // moderation has approved — which is why the feed is asked through the CLI
    // rather than over OData: the entity endpoint answers 200 for a version
    // that has only been submitted, and an earlier probe read that as published.
    expect(chocolateySearchVersion('looptroop|0.5.1\n')).toBe('0.5.1')
    expect(chocolateySearchVersion('')).toBeNull()
    // Chocolatey's `--exact` has matched by prefix, so the id is compared.
    expect(chocolateySearchVersion('looptroop-beta|9.9.9\n')).toBeNull()
    expect(chocolateySearchVersion('looptroop-beta|9.9.9\nlooptroop|0.5.1\n')).toBe('0.5.1')
    // A header line from a Chocolatey that ignored --limit-output is not a hit.
    expect(chocolateySearchVersion('Chocolatey v2.6.0\n0 packages found.\n')).toBeNull()
  })

  it('tells a Chocolatey search that found nothing from one that failed', () => {
    // Chocolatey's own source decides this: `ChocolateySearchCommand` exits 0
    // for a successful search including one with no results, and sets 2 only
    // when the `useEnhancedExitCodes` feature is on, which it is not by
    // default. So a non-zero exit is an error — an unreachable source, a proxy
    // failure, a broken client — and reading it as "the feed does not serve
    // this version" is how an outage becomes a fortnight of "waiting on
    // moderation", under the queue's name.
    expect(chocolateySearchOutcome({ code: 0, stdout: 'looptroop|0.5.1\n', combined: '' })).toBe('0.5.1')
    expect(chocolateySearchOutcome({ code: 0, stdout: '', combined: '' })).toBeNull()
    // "No results" under enhanced exit codes, read as the same answer.
    expect(chocolateySearchOutcome({ code: 2, stdout: '', combined: '' })).toBeNull()

    expect(() => chocolateySearchOutcome({ code: 1, stdout: '', combined: 'Unable to connect to the remote server' }))
      .toThrow('exited 1')
    expect(() => chocolateySearchOutcome({ code: -1, stdout: '', combined: 'boom' })).toThrow('exited -1')
    expect(() => chocolateySearchOutcome({ code: null, stdout: '', combined: 'choco: not found' }))
      .toThrow('could not be started')
  })

  it('reads a Chocolatey queue state, and when the submission was made', () => {
    // The shapes the live feed returned for an approved version and for one
    // pushed minutes earlier: `Published` stays at 1900-01-01 until approval,
    // so `Created` is the only date that can time a queue. Attributes appear on
    // some elements and not others, which the parser has to tolerate.
    const entry = (version: string, status: string, created: string) => `<entry>
      <m:properties>
        <d:Version>${version}</d:Version>
        <d:VersionDownloadCount m:type="Edm.Int32">6</d:VersionDownloadCount>
        <d:Created m:type="Edm.DateTime">${created}</d:Created>
        <d:Published m:type="Edm.DateTime">1900-01-01T00:00:00</d:Published>
        <d:PackageStatus>${status}</d:PackageStatus>
      </m:properties>
    </entry>`

    const queued = chocolateySubmission(entry('9.9.9', 'Submitted', '2026-09-21T08:15:27.443'))
    expect(queued.state).toBe('queued')
    expect(queued.at).toBe(Date.parse('2026-09-21T08:15:27.443Z'))

    expect(chocolateySubmission(entry('9.9.9', 'Rejected', '2026-09-21T08:15:27.443')).state).toBe('rejected')
    expect(chocolateySubmission(entry('0.5.1', 'Approved', '2026-08-13T10:17:38.163')).state).toBe('served')
    // Approved without automated verification; the feed serves those too.
    expect(chocolateySubmission(entry('0.5.1', 'Exempted', '2026-08-13T10:17:38.163')).state).toBe('served')
    expect(chocolateySubmission('<entry/>').state).toBe('absent')
  })

  it('reads what became of a WinGet submission', () => {
    // Only these three shapes change the decision: open and merged are a queue
    // doing its job — a merge still waits for the index pipeline — while closed
    // without a merge was a refusal, and nothing at all means this release
    // never submitted, which is not somebody else's queue.
    const open = wingetSubmission([{ number: 438396, state: 'open', created_at: '2026-09-21T09:06:46Z' }])
    expect(open.state).toBe('queued')
    expect(open.at).toBe(Date.parse('2026-09-21T09:06:46Z'))
    expect(open.detail).toContain('438396')

    // A merge restarts the clock. These are the real dates of the first
    // submission: open for five weeks, then merged, after which the index
    // pipeline runs. Timing the index refresh from the day the pull request
    // was opened would fail a merge that is hours old.
    const merged = wingetSubmission([{
      number: 417273,
      state: 'closed',
      created_at: '2026-08-14T07:42:43Z',
      merged_at: '2026-09-19T00:15:08Z',
    }])
    expect(merged.state).toBe('queued')
    expect(merged.at).toBe(Date.parse('2026-09-19T00:15:08Z'))

    expect(wingetSubmission([{ number: 2, state: 'closed', created_at: '2026-09-01T00:00:00Z', merged_at: null }]).state).toBe('rejected')
    expect(wingetSubmission([]).state).toBe('absent')
    expect(wingetSubmission(null).state).toBe('absent')
  })

  it('skips a moderated channel only while the wait is known, short and queued', () => {
    const moderated = { queue: 'Chocolatey community moderation', graceDays: 14 }
    const queued = { version: '9.9.9', ageHours: 48, serves: '9.9.8', state: 'queued' as const }

    // Inside the window, and saying what the feed does serve — a presence probe
    // answers only about the version it was asked about, so the served version
    // has to come from the channel's own latest probe or not be claimed at all.
    expect(moderationSkipReason(moderated, queued))
      .toBe('9.9.9 is waiting on Chocolatey community moderation; the feed serves 9.9.8')
    expect(moderationSkipReason(moderated, { ...queued, serves: null }))
      .toBe('9.9.9 is waiting on Chocolatey community moderation')

    // Past the window a stalled submission has to be reported, not waited on.
    expect(moderationSkipReason(moderated, { ...queued, ageHours: 14 * 24 })).toBeNull()

    // An unknown age is not a reason to skip. `releaseAgeHours` returns null for
    // every GitHub API failure, so counting it as inside the window lets
    // repeated failures keep a rejected submission green forever.
    expect(moderationSkipReason(moderated, { ...queued, ageHours: null })).toBeNull()

    // Neither is a queue that has already answered. A rejection and a version
    // nobody submitted both look like a wait from the feed alone, and both mean
    // waiting longer changes nothing.
    expect(moderationSkipReason(moderated, { ...queued, state: 'rejected' })).toBeNull()
    expect(moderationSkipReason(moderated, { ...queued, state: 'absent' })).toBeNull()
    // `served` contradicts the feed — an approval the search index has not
    // caught up with — so it belongs on the path that polls, not on a skip.
    expect(moderationSkipReason(moderated, { ...queued, state: 'served' })).toBeNull()

    // A queue that could not be reached is not evidence either way, and the
    // age still bounds it: this keeps one flaky lookup from turning a release
    // that is plainly still in review into a weekly failure.
    expect(moderationSkipReason(moderated, { ...queued, state: 'unknown' }))
      .toBe('9.9.9 is waiting on Chocolatey community moderation; the feed serves 9.9.8')
    expect(moderationSkipReason(moderated, { ...queued, state: 'unknown', ageHours: 14 * 24 })).toBeNull()
  })

  it('names WinGet by its published identifier everywhere it appears', () => {
    // `winget-pkgs` derives the manifest directory from this string, so it is
    // the same in the submission, in the documented command and in what doctor
    // prints. A second copy is the one that drifts, and the drift is invisible
    // until a user's `winget install` finds nothing.
    const recipe = installedChannel('winget')
    expect(recipe.documented).toBe(`winget install ${WINGET_IDENTIFIER}`)
    expect(recipe.expect.upgradeCommand('win32')).toBe(`winget upgrade ${WINGET_IDENTIFIER}`)
    expect(recipe.install({ version: '9.9.9', pin: false }).args).toContain(WINGET_IDENTIFIER)
    expect(recipe.uninstall({}).args).toContain(WINGET_IDENTIFIER)
  })

  it('checks the latest pointer on every channel whose command resolves one', () => {
    // The documented command for these names a moving target — `@latest`,
    // a tap's single formula, `:latest` — so the pointer having moved is part
    // of what "this release published correctly" means. A channel that only
    // ever pulled the exact version could stay green with a stale pointer
    // forever, which is the silent failure this whole workflow exists to find.
    for (const key of ['npm', 'homebrew', 'scoop', 'container', 'chocolatey']) {
      expect(typeof channel(key).latest, `${key} has no latest probe`).toBe('function')
    }
    // WinGet deliberately has none. Asking the client which version it would
    // install is the install command itself, so the pointer is asserted from
    // the other side — step 4 checks what actually arrived.
    expect(channel('winget').latest).toBeUndefined()
  })

  it('keeps every recipe shape the driver assumes', () => {
    // A delegated channel has no install/uninstall of its own, and a stub has
    // neither plus no legs. The driver calls these unconditionally in places,
    // and doing so crashed the container leg before it ran a single assertion.
    for (const [key, recipe] of Object.entries(CHANNELS)) {
      if (recipe.stub) {
        expect(typeof recipe.documented, `${key}`).toBe('string')
        continue
      }
      expect(Array.isArray(recipe.legs), `${key} has no legs`).toBe(true)
      if (recipe.delegate) {
        expect(typeof recipe.delegate, `${key}`).toBe('function')
        continue
      }
      for (const field of ['install', 'uninstall', 'published'] as const) {
        expect(typeof recipe[field], `${key}.${field}`).toBe('function')
      }
      expect(typeof recipe.port, `${key}.port`).toBe('number')
    }
  })

  it('reads the OpenCode field the daemon actually persists', () => {
    // The supervisor's in-memory `OpenCodeStatus` is discriminated by `kind`;
    // `describeOpenCode()` maps it to `DaemonState['opencode']`, which uses
    // `status`. Reading the wrong one is invisible locally — the assertion just
    // sees `undefined` and fails — and it failed every leg of a real release
    // against a package that was working perfectly.
    //
    // Pinned against the code that renders the persisted shape, so renaming the
    // discriminant breaks here rather than in a post-release smoke.
    const renderer = readFileSync('server/cli/commands.ts', 'utf8')
    const fn = renderer.slice(renderer.indexOf('export function describeOpenCodeForStatus'))
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('opencode.status')

    const driver = readFileSync('scripts/smoke-published.mjs', 'utf8')
    expect(driver).toContain("oc?.status === 'managed'")
    expect(driver).toContain("oc?.status === 'adopted'")
    expect(driver).not.toContain("oc?.kind")
  })

  it('honours --only', () => {
    expect(planMatrix({ tier: 'weekly', only: ['npm'] }).every((leg) => leg.channel === 'npm')).toBe(true)
    expect(planMatrix({ tier: 'weekly', only: ['nothing-by-this-name'] })).toEqual([])
  })

  it('marks tap- and bucket-backed channels unpinnable', () => {
    // A tap carries one formula and a bucket one manifest, so an older version
    // is not installable at all. Claiming otherwise would make a --pin run
    // report a failure for a channel that is working exactly as designed.
    for (const key of ['homebrew', 'scoop']) expect(channel(key).pinnable).toBe(false)
    for (const key of ['npm', 'installer-sh', 'installer-ps1']) expect(channel(key).pinnable).toBe(true)
  })

  it('only claims a self-contained runtime where the channel provides one', () => {
    // Homebrew installs keg-only node@24 and wires it up in a wrapper, and the
    // standalone binary embeds Node — both must run with no Node on PATH.
    // Scoop *depends* on nodejs-lts rather than carrying it, so stripping Node
    // would break it correctly, and asserting otherwise would be wrong.
    expect(installedChannel('homebrew').provesOwnRuntime).toBe(true)
    expect(installedChannel('scoop').provesOwnRuntime).toBeUndefined()
    expect(installedChannel('npm').provesOwnRuntime).toBeUndefined()
    // The two Windows package managers sit on opposite sides of this, and the
    // recipes look alike enough to be copied from one another. WinGet installs
    // the standalone executable, which must run with no Node on PATH;
    // Chocolatey installs the bundle and declares `nodejs-lts`, so stripping
    // Node would break it correctly.
    expect(installedChannel('winget').provesOwnRuntime).toBe(true)
    expect(installedChannel('chocolatey').provesOwnRuntime).toBeUndefined()
  })

  it('runs the documented command verbatim when it is not pinned', () => {
    // The website URL is the path a user takes, and exercising the redirect is
    // half the point of the leg.
    const sh = installedChannel('installer-sh').install({ version: '9.9.9', pin: false })
    expect(sh.display).toBe('curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install | sh')

    const ps1 = installedChannel('installer-ps1').install({ version: '9.9.9', pin: false })
    expect(ps1.display).toBe('$script = curl.exe --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install.ps1; if ($LASTEXITCODE -ne 0 -or !$script) { throw "Installer download failed" }; & ([scriptblock]::Create(($script -join "`n")))')
  })

  it.runIf(process.platform === 'win32' || spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { timeout: 10_000 }).status === 0).each([[0, false], [22, false], [0, true]] as const)('executes PowerShell downloads only after curl succeeds (exit %i, empty %s)', (exitCode, empty) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh'
    const command = installedChannel('installer-ps1-binary').install({ version: '9.9.9', pin: true }).display
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', `
function Invoke-MockCurl {
  $global:LASTEXITCODE = ${exitCode}
  if (${empty ? '$true' : '$false'}) { return }
  'param([switch]$Binary, [string]$Version)'
  '$message = @"'
  'complete script'
  '"@'
  'Write-Output "$message $Binary $Version"'
}
Set-Alias -Name curl.exe -Value Invoke-MockCurl
${command}
`], { encoding: 'utf8', timeout: 30_000 })
    expect(result.error).toBeUndefined()
    if (exitCode === 0 && !empty) {
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe('complete script True 9.9.9')
    } else {
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Installer download failed')
      expect(result.stdout).not.toContain('complete script')
    }
  }, 45_000)

  it('fetches a pinned wrapper from the release, never from the website', () => {
    // The website always points at releases/latest, so pinning through it would
    // pair the newest wrapper with an older payload and prove nothing about the
    // release being reproduced.
    for (const key of ['installer-sh', 'installer-ps1']) {
      const spec = installedChannel(key).install({ version: '9.9.9', pin: true })
      expect(spec.display).toContain('/releases/download/v9.9.9/')
      expect(spec.display).not.toContain('looptroop.ovh')
      expect(spec.display).toMatch(/-{1,2}[Vv]ersion 9\.9\.9/)
    }
  })

  it('drives PowerShell 5.1 with the progress bar silenced', () => {
    // `powershell.exe` is Windows PowerShell 5.1, the runtime that ships with
    // Windows and therefore the one the documented one-liner lands in. `pwsh`
    // is a different runtime.
    const spec = installedChannel('installer-ps1').install({ version: '9.9.9', pin: false })
    expect(spec.command).toBe('powershell.exe')
    expect(spec.args?.join(' ')).toContain("$ProgressPreference = 'SilentlyContinue'")
    expect(spec.args).toContain('-NoProfile')
  })

  it('expects the npm channel from the installers default mode', () => {
    // The installer writes no marker file, so the channel is inferred from where
    // the module lands — and in default mode it hands the tarball to
    // `npm install -g`. Anyone "correcting" these to an installer-shaped channel
    // breaks the legs.
    for (const key of ['installer-sh', 'installer-ps1']) {
      expect(installedChannel(key).expect.channel).toBe('npm')
      expect(installedChannel(key).uninstall({}).args).toEqual(['uninstall', '--global', 'looptroop'])
    }
    for (const key of ['installer-sh-binary', 'installer-ps1-binary']) {
      expect(installedChannel(key).expect.channel).toBe('binary')
    }
  })

  it('gives the binary channel a platform-specific upgrade command', () => {
    // A piped script cannot take a parameter, so Windows needs the scriptblock
    // form. One string here would fail on one of the two operating systems.
    const { upgradeCommand } = installedChannel('installer-sh-binary').expect
    expect(upgradeCommand('win32')).toContain('scriptblock')
    expect(upgradeCommand('linux')).toBe('curl --proto "=https" --proto-redir "=https" --tlsv1.2 -fsSL https://www.looptroop.ovh/install | sh -s -- --binary')
    expect(upgradeCommand('win32')).not.toBe(upgradeCommand('linux'))
  })

  it('never points the binary uninstall at the configuration directory', () => {
    // This path is handed to a recursive delete. The install prefix is
    // `~/.looptroop`; the configuration directory — which holds the database —
    // is `~/.config/looptroop`. Confusing them would delete a user's data, and
    // on a developer machine, this test's own.
    const prefix = binaryPrefix()
    for (const key of ['installer-sh-binary', 'installer-ps1-binary']) {
      expect(installedChannel(key).uninstall({}).removePath).toBe(prefix)
    }
    expect(prefix).not.toContain('.config')
    expect(prefix.endsWith('.looptroop')).toBe(true)
  })

  it('gives every channel its own daemon and OpenCode port', () => {
    // Two channels sharing a port would collide only when both run on one
    // runner, which is rare enough to look like a flake rather than a clash.
    const assigned = (port: number | undefined): port is number => typeof port === 'number'
    const daemonPorts = Object.values(CHANNELS).map((c) => c.port).filter(assigned)
    const opencodePorts = Object.values(CHANNELS).map((c) => c.opencodePort).filter(assigned)
    expect(new Set(daemonPorts).size).toBe(daemonPorts.length)
    expect(new Set(opencodePorts).size).toBe(opencodePorts.length)
    // 39117 is smoke-install.mjs's port; overlapping it would break a run that
    // happened to share a machine.
    expect(daemonPorts).not.toContain(39117)
    for (const port of [...daemonPorts, ...opencodePorts]) expect(port).toBeGreaterThan(39117)
  })
})

describe('adopted OpenCode readiness', () => {
  it('shares credentials and requires authenticated v2 info readiness', async () => {
    const password = 'fixture-password'
    const credentials = createOpenCodeAdoptCredentials(password)
    expect(credentials.env).toEqual({
      OPENCODE_PASSWORD: password,
      OPENCODE_SERVER_PASSWORD: password,
    })
    expect(credentials.headers.Authorization).toBe(
      `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`,
    )

    const requests: Array<{ url: string; authorization: string | null }> = []
    const fetchImpl: typeof fetch = async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
      return new Response(JSON.stringify({ version: '2.0.16', pid: 321 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    expect(await openCodeAnswers(4096, credentials.headers, fetchImpl)).toBe(true)
    expect(requests).toEqual([{
      url: 'http://127.0.0.1:4096/api/info',
      authorization: credentials.headers.Authorization,
    }])
  })

  it.each([204, 401, 404, 500])('rejects HTTP %i from the adopted server', async (status) => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status })
    expect(await openCodeAnswers(4096, {}, fetchImpl)).toBe(false)
  })

  it.each([
    ['v1 info', { version: '1.18.32', pid: 321 }],
    ['config response', { config: {} }],
    ['missing pid', { version: '2.0.16' }],
    ['invalid pid', { version: '2.0.16', pid: 0 }],
  ])('rejects %s as unverified v2 readiness', async (_label, payload) => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(payload), { status: 200 })
    expect(await openCodeAnswers(4096, {}, fetchImpl)).toBe(false)
    expect(isOpenCodeInfoReady(200, payload)).toBe(false)
  })
})

describe('workflow dispatch wiring', () => {
  const workflow = readFileSync('.github/workflows/published-smoke.yml', 'utf8')

  /** The `workflow_dispatch` inputs the smoke workflow actually declares. */
  function declaredInputs(): Set<string> {
    const block = workflow.slice(workflow.indexOf('workflow_dispatch:'), workflow.indexOf('schedule:'))
    // `flatMap` rather than `map`: the capture group is mandatory, so a match
    // always carries it, but that is not something the types can know and a
    // `Set<string | undefined>` is not what the caller compares against.
    return new Set([...block.matchAll(/^ {6}([a-z_]+):$/gm)].flatMap((m) => m[1] ?? []))
  }

  /** Every `-f name=` a workflow passes when dispatching the smoke. */
  function dispatchedInputs(file: string): Array<{ file: string, name: string }> {
    const text = readFileSync(file, 'utf8')
    return text
      .split('gh workflow run published-smoke.yml')
      .slice(1)
      .flatMap((block) => [...(block.split(/\n\s*\n/)[0] ?? '').matchAll(/-f ([a-z_]+)=/g)]
        .flatMap((m) => (m[1] === undefined ? [] : [{ file, name: m[1] }])))
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

  it('resolves the Windows launcher with PATHEXT-aware code', () => {
    const driver = readFileSync('scripts/smoke-published.mjs', 'utf8')
    // The Windows gate runs the resolver fixture with an extensionless shim
    // before npm.cmd. Keep this driver on that same path rather than accepting
    // the first line printed by `where`, which is not CreateProcess semantics.
    expect(driver).toContain("import { findToolPath, launchTool, planToolLaunch } from './tool-path.ts'")
    expect(driver).not.toContain("run('where', ['looptroop']")
  })

  it('uses the parent PATH when no launcher hint is supplied', () => {
    const root = makeTempDir('looptroop-smoke-path-')
    const previousPath = process.env.PATH
    const previousPathExt = process.env.PATHEXT
    const name = process.platform === 'win32' ? 'looptroop.CMD' : 'looptroop'
    const launcher = join(root, name)
    mkdirSync(root, { recursive: true })
    writeFileSync(launcher, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\nexit 0\n')
    chmodSync(launcher, 0o755)
    process.env.PATH = root
    if (process.platform === 'win32') process.env.PATHEXT = '.CMD'
    try {
      expect(whichLooptroop()).toBe(launcher)
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      if (previousPathExt === undefined) delete process.env.PATHEXT
      else process.env.PATHEXT = previousPathExt
      removeTempDir(root)
    }
  })

  it('keeps the resolved launch target and errno when a child cannot start', async () => {
    // This is the production run helper, imported from the driver itself. A
    // real executable plus a missing cwd makes spawnSync return ENOENT after
    // resolution, which is the case a PATH-only message misdiagnoses.
    const driver = await import('../scripts/smoke-published.mjs') as unknown as {
      run: (command: string, args: string[], options?: { cwd?: string }) => {
        code: number | null
        combined: string
      }
    }
    const missingCwd = join(tmpdir(), `looptroop-published-missing-cwd-${process.pid}`)
    rmSync(missingCwd, { recursive: true, force: true })

    const result = driver.run(process.execPath, ['--version'], { cwd: missingCwd })

    expect(result.code).toBeNull()
    expect(result.combined).toContain(`${process.execPath}: ENOENT:`)
    expect(result.combined).not.toContain('process.execPath is not on PATH')
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
