import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  binaryAssetName, binaryTarget, defaultPrefix, detectLibc, INSTALL_OPTIONS, onPath, quoteForCmd,
  findTrustedExecutablePath, runTool, stallGuard, streamBody,
} from '../scripts/installer-core.mjs'
import { removeTempDir } from '../server/test/tempDir'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(repoRoot, 'scripts', 'installer-core.mjs')

const TARBALL_BODY = Buffer.from('not really a tarball, but it hashes like one')
const TARBALL_SHA = createHash('sha256').update(TARBALL_BODY).digest('hex')

/**
 * The target this machine would install a standalone executable for, and
 * whether it can be exercised end to end here.
 *
 * The archive these tests build carries a shell script standing in for the
 * executable, which Windows cannot run as `looptroop.exe` — so the transaction
 * itself is proved on POSIX here and on all four targets by
 * `scripts/smoke-binary-install.mjs`, which drives the real one.
 */
const TARGET = (binaryTarget(process.platform, process.arch, detectLibc()) as { target?: string }).target
const canInstallBinary = TARGET !== undefined && process.platform !== 'win32'

interface FixtureRelease {
  tag_name: string
  draft?: boolean
  prerelease?: boolean
  assets: { name: string }[]
}

/**
 * The shapes a real release index actually contains, including the two that
 * broke naive resolution: a newer stable release carrying no assets (one early
 * release is exactly this), and a prerelease that must not be picked by default.
 */
const RELEASES: FixtureRelease[] = [
  { tag_name: 'v9.9.9', draft: true, assets: [{ name: 'release-manifest.json' }, { name: 'looptroop-9.9.9.tgz' }] },
  { tag_name: 'v0.6.1', assets: [] },
  { tag_name: 'v0.6.0-rc.1', prerelease: true, assets: [{ name: 'release-manifest.json' }, { name: 'looptroop-0.6.0-rc.1.tgz' }] },
  {
    tag_name: 'v0.5.9',
    assets: [
      { name: 'release-manifest.json' },
      { name: 'looptroop-0.5.9.tgz' },
      // Only this release carries a standalone archive, which is the shape of
      // the real thing: `--binary` has to walk past newer releases that predate
      // the executables rather than resolve to one it cannot install from.
      ...(TARGET === undefined ? [] : [{ name: binaryAssetName('0.5.9', TARGET) }]),
    ],
  },
  { tag_name: 'v0.5.8', assets: [{ name: 'looptroop-0.5.8.tgz' }] },
]

interface InstallerRun {
  status: number | null
  /** Non-null when the installer was killed rather than allowed to exit. */
  signal?: NodeJS.Signals | string | null
  stdout?: string
  stderr?: string
  /**
   * The wrapper harness accumulates both streams into one.
   *
   * Named apart from `stdout`/`stderr` because a `spawnSync` result also has an
   * `output` — an array of the streams — and the two must not be confused.
   */
  outputText?: () => string
}

/**
 * Asserts an exit status, and says what happened when it is not the one asked
 * for.
 *
 * A killed process reports `status: null`, and `expected null to be 1` names
 * neither the signal nor a line of the output — which is all a CI log had to
 * offer when `rolls back a version that runs but whose daemon will not start`
 * failed this way on PR #148, three times, each time passing in the sibling run
 * on the same commit. The next occurrence has to arrive diagnosable.
 *
 * One helper for both harnesses: the wrapper's had drifted to its own copy that
 * did not normalise the signal, and the two together were one of SonarCloud's
 * duplicated blocks.
 */
function expectExit(run: InstallerRun, status: number) {
  // `spawnSync` reports no signal as `undefined`; a spawned child's `close`
  // reports it as `null`. Both mean "exited normally", and these cases run the
  // installer each way.
  const signal = run.signal ?? null
  const output = run.outputText ? run.outputText() : `${run.stdout ?? ''}${run.stderr ?? ''}`
  // Attached whenever anything is wrong, the signal included: a run killed
  // *after* producing the expected status is exactly the case where the trailing
  // output says why.
  const mismatch = run.status !== status || signal !== null
  expect({
    status: run.status,
    signal,
    ...(mismatch ? { output: output.slice(-2000) } : {}),
  }).toEqual({ status, signal: null })
}

describe('installer core', () => {
  const tempDirs: string[] = []
  let server: Server
  let origin: string
  let stubBin: string
  /** Set per-test to make the served tarball disagree with the manifest. */
  let corruptDownload: false | 'substituted' | 'truncated' = false
  /** `null` reproduces a manifest written before the floor was recorded. */
  let engines: { node?: string, npm?: string } | null = null
  /** The standalone archive this release carries, if the test wants one. */
  let archive: { name: string, body: Buffer, sha256: string } | null = null
  /** Set to drop the archive's digest from the manifest while still serving it. */
  let omitArchiveDigest = false

  function manifestFor(version: string) {
    return {
      name: 'looptroop',
      version,
      tarball: `looptroop-${version}.tgz`,
      bytes: TARBALL_BODY.length,
      sha256: TARBALL_SHA,
      ...(engines === null ? {} : { engines }),
      assets: {
        [`looptroop-${version}.tgz`]: { bytes: TARBALL_BODY.length, sha256: TARBALL_SHA },
        ...(archive === null || omitArchiveDigest
          ? {}
          : { [archive.name]: { bytes: archive.body.length, sha256: archive.sha256 } }),
      },
    }
  }

  function withAssetUrls(release: FixtureRelease) {
    return {
      ...release,
      assets: release.assets.map((asset) => ({
        ...asset,
        browser_download_url: `${origin}/download/${release.tag_name}/${asset.name}`,
      })),
    }
  }

  /** Overridden by the rate-limit test; reset after every test. */
  let releaseListStatus = 200

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const tagMatch = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(url.pathname)
      const downloadMatch = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname)

      if (url.pathname.endsWith('/releases')) {
        // Lets one test make the release list answer 403, the way GitHub does
        // to an unauthenticated caller that has run out of anonymous requests.
        if (releaseListStatus !== 200) {
          response.writeHead(releaseListStatus, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ message: 'API rate limit exceeded' }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(RELEASES.map(withAssetUrls)))
        return
      }

      if (tagMatch) {
        const release = RELEASES.find((candidate) => candidate.tag_name === tagMatch[1])
        if (!release) {
          response.writeHead(404).end('{}')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(withAssetUrls(release)))
        return
      }

      if (downloadMatch) {
        const [, tag, name] = downloadMatch as unknown as [string, string, string]
        if (name === 'release-manifest.json') {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(manifestFor(tag.replace(/^v/, ''))))
          return
        }
        if (archive !== null && name === archive.name) {
          response.writeHead(200, { 'content-type': 'application/octet-stream' })
          response.end(corruptDownload === 'substituted' ? Buffer.alloc(archive.body.length, 0x78) : archive.body)
          return
        }
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        // Same length, different bytes: a substitution that a size check alone
        // would wave through, which is the case the hash is there for.
        response.end(corruptDownload === 'substituted' ? Buffer.alloc(TARBALL_BODY.length, 0x78)
          : corruptDownload === 'truncated' ? TARBALL_BODY.subarray(0, 10)
          : TARBALL_BODY)
        return
      }

      response.writeHead(404).end('{}')
    })

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    // Stands in for npm and for the installed binary, so a test can prove what
    // the installer would run without any of it reaching the real machine.
    stubBin = mkdtempSync(join(tmpdir(), 'looptroop-stub-bin-'))
    tempDirs.push(stubBin)
    // Echoes its arguments, which the installer inherits onto its own stdout,
    // so a test can assert on the command without a side channel.
    writeFileSync(
      join(stubBin, 'npm'),
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 99.9.9; exit 0; fi\necho "stub npm $@"\nexit 0\n',
    )
    chmodSync(join(stubBin, 'npm'), 0o755)
    // The installer probes `looptroop --version` at the end. Without a stub that
    // runs whatever is globally installed on the machine running the tests.
    writeFileSync(join(stubBin, 'looptroop'), '#!/bin/sh\necho 9.9.9\n')
    chmodSync(join(stubBin, 'looptroop'), 0o755)
    writeFileSync(join(stubBin, 'looptroop.cmd'), '@echo off\r\necho 9.9.9\r\n')
    writeFileSync(
      join(stubBin, 'npm.cmd'),
      '@echo off\r\nif "%1"=="--version" (echo 99.9.9) else (echo stub npm %*)\r\nexit /b 0\r\n',
    )
  })

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()))
    for (const dir of tempDirs.splice(0)) removeTempDir(dir)
  })

  /**
   * Asynchronous on purpose. `spawnSync` would block this process's event loop,
   * and the fixture server the installer talks to is in this process — so the
   * request could never be answered and both sides would wait forever.
   */
  function runInstaller(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return new Promise<InstallerRun>((done, reject) => {
      const child = spawn(process.execPath, [CORE, ...args], {
        env: {
          ...process.env,
          // A real token in the ambient environment would otherwise be sent to
          // a fixture server on localhost.
          GITHUB_TOKEN: '',
          GH_TOKEN: '',
          LOOPTROOP_INSTALL_API: origin,
          PATH: `${stubBin}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
          ...extraEnv,
        },
      })

      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('error', reject)
      child.on('close', (status, signal) => done({ status, signal, stdout, stderr }))
    })
  }

  /**
   * The unauthenticated path, which is the one real users take.
   *
   * `installer-core.mjs` sends a token when one happens to be present, so on a
   * developer machine or in CI it usually has one — and the anonymous branch,
   * including the message shown when GitHub refuses, only runs for people who
   * do not. That message was previously exercised only by accident, when a
   * published-install smoke leg happened to exhaust the shared-address rate
   * limit on a hosted runner: real coverage, but arriving at random and
   * indistinguishable from a broken release.
   */
  it('explains an anonymous rate limit rather than just failing', async () => {
    releaseListStatus = 403
    try {
      const result = await runInstaller(['--dry-run'])
      expect(result.status).not.toBe(0)
      const output = `${result.stdout}${result.stderr}`
      expect(output).toContain('GitHub answered 403 for the release list')
      // The part that makes it actionable: without it a user reads a bare 403
      // and has no idea whether to retry or report a broken release.
      expect(output).toContain('anonymous rate limit')
    } finally {
      releaseListStatus = 200
    }
  })

  it('picks the newest stable release that actually carries assets', async () => {
    const result = await runInstaller(['--dry-run'])

    // v0.6.1 is newer and stable, and has nothing to download.
    expect(result.stdout).toContain('Installing LoopTroop 0.5.9')
    expectExit(result, 0)
  })

  it('never picks a prerelease by default', async () => {
    expect((await runInstaller(['--dry-run'])).stdout).not.toContain('0.6.0-rc.1')
  })

  it('installs a pinned prerelease when asked for one by name', async () => {
    const result = await runInstaller(['--dry-run', '--version', '0.6.0-rc.1'])

    expect(result.stdout).toContain('Installing LoopTroop 0.6.0-rc.1')
    expectExit(result, 0)
  })

  it('accepts a pinned version written with a leading v', async () => {
    expect((await runInstaller(['--dry-run', '--version', 'v0.5.9'])).stdout).toContain('Installing LoopTroop 0.5.9')
  })

  it('refuses a pinned release with no installable assets', async () => {
    const result = await runInstaller(['--dry-run', '--version', '0.6.1'])

    expectExit(result, 1)
    expect(result.stderr).toContain('no installable assets')
  })

  /**
   * The same three rules `cli-args.ts` applies to the release scripts. This
   * parser had only the first, and both gaps were reachable from a shell:
   * `--prefix "$DIR"` with `DIR` unset installed the standalone executable into
   * the current working directory, and `--version -h` asked GitHub for a
   * release called `v-h`.
   */
  it.each([
    [['--prefix', ''], 'was given an empty one'],
    [['--version', ''], 'was given an empty one'],
    [['--version', '-h'], 'is followed by -h'],
    [['--tarball', '--binary'], 'is followed by --binary'],
    [['--prefix'], 'is the last argument'],
  ])('refuses %j where a value belongs', async (argv, expected) => {
    const result = await runInstaller(argv)

    expectExit(result, 1)
    expect(result.stderr).toContain(expected)
  })

  it('refuses an unknown option rather than ignoring it', async () => {
    const result = await runInstaller(['--dry-run', '--global'])

    expectExit(result, 1)
    expect(result.stderr).toContain('Unknown option')
  })

  it('refuses bytes that do not match the checksum, and installs nothing', async () => {
    corruptDownload = 'substituted'
    try {
      const result = await runInstaller([])

      expectExit(result, 1)
      expect(result.stderr).toContain('does not match the checksum')
      expect(result.stderr).toContain('Nothing was installed.')
      expect(result.stdout).not.toContain('Installing with npm')
    } finally {
      corruptDownload = false
    }
  })

  it('refuses a truncated download too', async () => {
    corruptDownload = 'truncated'
    try {
      const result = await runInstaller([])

      expectExit(result, 1)
      expect(result.stderr).toContain('the release records')
      expect(result.stdout).not.toContain('Installing with npm')
    } finally {
      corruptDownload = false
    }
  })

  it('installs the verified tarball with npm, so npm can still uninstall it', async () => {
    const result = await runInstaller([])

    expectExit(result, 0)
    expect(result.stdout).toContain(`Verified sha256 ${TARBALL_SHA}`)
    expect(result.stdout).toContain('Installing with npm')
    // `-g`, and the downloaded file rather than a registry name: the bytes that
    // were just checked are the bytes installed.
    expect(result.stdout).toContain('install -g')
    expect(result.stdout).toContain('looptroop-0.5.9.tgz')
  })

  /**
   * The floor travels in the release manifest rather than being baked into the
   * installer. An installer that hardcodes it is wrong for every release but
   * the one it shipped with — and these scripts are downloaded fresh, so the
   * copy a user runs is often older than the release it installs.
   */
  it('stops when the running Node is below the floor the release records', async () => {
    engines = { node: '>=99.0.0' }
    try {
      const result = await runInstaller(['--dry-run'])

      expectExit(result, 1)
      expect(result.stderr).toContain('needs Node >=99.0.0')
      expect(result.stderr).toContain('will not install Node for you')
    } finally {
      engines = null
    }
  })

  it('stops when npm is below the floor the release records', async () => {
    engines = { npm: '>=999.0.0' }
    try {
      const result = await runInstaller(['--dry-run'])

      expectExit(result, 1)
      expect(result.stderr).toContain('needs npm >=999.0.0')
    } finally {
      engines = null
    }
  })

  it('installs from a manifest written before the floor was recorded', async () => {
    // The manifest shipped by the release before this one has no `engines`.
    // Treating that as a failed check would make the installer unable to install
    // the very release it is being added for.
    expectExit(await runInstaller(['--dry-run']), 0)
  })

  it('installs a local tarball without touching the network', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-local-'))
    tempDirs.push(dir)
    const tarball = join(dir, 'looptroop-0.5.9.tgz')
    writeFileSync(tarball, TARBALL_BODY)

    const result = await runInstaller(['--tarball', tarball], { LOOPTROOP_INSTALL_API: 'http://127.0.0.1:1' })

    expectExit(result, 0)
    expect(result.stdout).toContain('Installing with npm')
  })

  /**
   * macOS reaches its temporary directory through `/var`, a symlink to
   * `/private/var`, and the wrappers write the core there and run it. Node
   * resolves symlinks when it records `import.meta.url` and does not when it
   * records `argv[1]`, so a naive main-module check is false on exactly one
   * platform — and a false answer is not an error, it is a program that does
   * nothing and exits 0. The installer "succeeded" and installed nothing.
   */
  it('runs when it was reached through a symlinked directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-symlink-'))
    tempDirs.push(dir)
    mkdirSync(join(dir, 'real'))
    copyFileSync(CORE, join(dir, 'real', 'installer-core.mjs'))
    symlinkSync(join(dir, 'real'), join(dir, 'link'), 'dir')

    const result = await new Promise<InstallerRun & { stdout: string }>((done) => {
      const child = spawn(process.execPath, [join(dir, 'link', 'installer-core.mjs'), '--help'])
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.on('close', (status, signal) => done({ status, signal, stdout }))
    })

    expectExit(result, 0)
    expect(result.stdout).toContain('Usage:')
  })

  it('reports a missing local tarball instead of installing something else', async () => {
    const result = await runInstaller(['--tarball', join(tmpdir(), 'looptroop-absent.tgz')])

    expectExit(result, 1)
    expect(result.stderr).toContain('No such tarball')
  })

  /**
   * The standalone executable, which the installer unpacks itself.
   *
   * The npm path hands the dangerous parts to npm. This one owns them, and the
   * case that matters is not a first install but an *upgrade*: somebody already
   * running LoopTroop, whose working copy must survive anything that goes wrong
   * here. Every test below is about that copy.
   */
  describe('--binary', () => {
    /**
     * Stands in for the executable. Answers the four things the installer asks.
     *
     * `status` is deliberately overridable. It is the one probe with three
     * answers rather than two — running, stopped, and "cannot say" — and the
     * third is what an upgrade used to read as stopped.
     */
    function stubProgram(version: string, { status = 'report', start = 'plain' } = {}) {
      const statusArm = status === 'report'
        // Statefulness via a file, so `stop` is observable and `status` can
        // disagree with itself before and after.
        ? '  status) if [ -f "$LOOPTROOP_STUB_STATE" ]; then echo \'{"running":true}\'; else echo \'{"running":false}\'; fi ;;'
        // A live process that is not answering. The real CLI reports this as
        // `running: false` with the pid in `notAnswering`, on purpose.
        : status === 'not-answering'
          ? '  status) if [ -f "$LOOPTROOP_STUB_STATE" ]; then echo \'{"running":false,"notAnswering":{"pid":4242}}\'; else echo \'{"running":false,"notAnswering":null}\'; fi ;;'
          // Runs, exits 0, and says nothing a probe can parse.
          : '  status) echo "not json at all" ;;'
      // A `stop` that reports failure, for the case where nothing at all can be
      // established: the probe cannot answer and the command did not work.
      const stopArm = status === 'unparseable-and-stop-fails'
        ? '  stop) echo "stub cannot stop" >&2; exit 1 ;;'
        : '  stop) rm -f "$LOOPTROOP_STUB_STATE"; echo "stub stopped" ;;'
      const startArm = start === 'plain'
        ? '  start) : > "$LOOPTROOP_STUB_STATE"; echo "stub started" ;;'
        // Stands in for another installer claiming the directory while this one
        // is mid-install, which is the only moment the lock can change hands.
        : '  start) : > "$LOOPTROOP_STUB_STATE"; [ -n "$LOOPTROOP_STUB_LOCK" ] && echo "someone-else 2000-01-01" > "$LOOPTROOP_STUB_LOCK"; echo "stub started" ;;'

      return [
        '#!/bin/sh',
        'case "$1" in',
        `  --version) echo "${version}" ;;`,
        statusArm,
        stopArm,
        startArm,
        'esac',
        '',
      ].join('\n')
    }

    /** A release archive with the layout `build-binary.mjs` produces. */
    function buildArchive(version: string, program: string, notice = 'Node.js is MIT licensed.') {
      const dir = mkdtempSync(join(tmpdir(), 'looptroop-archive-'))
      tempDirs.push(dir)
      const name = `looptroop-${version}-${TARGET}`
      mkdirSync(join(dir, name))
      writeFileSync(join(dir, name, 'looptroop'), program)
      chmodSync(join(dir, name, 'looptroop'), 0o755)
      writeFileSync(join(dir, name, 'LICENSE.node.txt'), notice)

      const out = join(dir, `${name}.tar.gz`)
      const packed = spawnSync('tar', ['-czf', out, '-C', dir, name], { encoding: 'utf8' })
      expect(packed.status, packed.stderr).toBe(0)

      const body = readFileSync(out)
      return { name: `${name}.tar.gz`, body, sha256: createHash('sha256').update(body).digest('hex') }
    }

    function freshPrefix() {
      const dir = mkdtempSync(join(tmpdir(), 'looptroop-prefix-'))
      tempDirs.push(dir)
      return dir
    }

    beforeEach(() => {
      archive = canInstallBinary ? buildArchive('0.5.9', stubProgram('0.5.9')) : null
      omitArchiveDigest = false
    })

    afterEach(() => {
      archive = null
    })

    /**
     * Refusing is an answer, not a failure mode. Every one of these platforms
     * has a working LoopTroop through another channel, and the only useful
     * thing to say is which one.
     */
    // `as const` so the libc column keeps its literal type; widened to `string`
    // it no longer says which of the two values it is.
    it.each([
      ['darwin', 'x64', 'glibc', 'Intel Macs', 'brew install'],
      ['linux', 'x64', 'musl', 'musl systems such as Alpine', 'docker run'],
      ['win32', 'arm64', 'glibc', 'win32-arm64', 'npm install -g looptroop'],
      ['freebsd', 'x64', 'glibc', 'freebsd-x64', 'npm install -g looptroop'],
    ] as const)('refuses %s-%s (%s) by naming what to use instead', (platform, arch, libc, mention, remedy) => {
      const decision = binaryTarget(platform, arch, libc)

      expect(decision.refusal?.join('\n')).toContain(mention)
      expect(decision.refusal?.join('\n')).toContain(remedy)
    })

    it('names an archive the way a release names it', () => {
      expect(binaryAssetName('1.2.3', 'linux-arm64')).toBe('looptroop-1.2.3-linux-arm64.tar.gz')
      // Windows gets a zip, because that is what WinGet reads and what Windows
      // unpacks without help.
      expect(binaryAssetName('1.2.3', 'win-x64')).toBe('looptroop-1.2.3-win-x64.zip')
    })

    it('installs into its own directory rather than somewhere already on PATH', () => {
      expect(defaultPrefix({}, '/home/someone')).toBe(join('/home/someone', '.looptroop'))
      expect(defaultPrefix({ LOOPTROOP_INSTALL_DIR: '/opt/lt' }, '/home/someone')).toBe('/opt/lt')
    })

    it('knows whether its directory is on PATH', () => {
      const path = ['/usr/bin', '/opt/lt/bin'].join(process.platform === 'win32' ? ';' : ':')

      expect(onPath('/opt/lt/bin', path)).toBe(true)
      // A trailing separator is the same directory, and saying otherwise would
      // print PATH advice to somebody who does not need it.
      expect(onPath('/opt/lt/bin/', path)).toBe(true)
      expect(onPath('/opt/other/bin', path)).toBe(false)
    })

    it('refuses to combine with --tarball rather than picking one', async () => {
      const result = await runInstaller(['--binary', '--tarball', '/tmp/x.tgz'])

      expectExit(result, 1)
      expect(result.stderr).toContain('cannot be combined')
    })

    it('refuses --prefix without --binary, which would silently do nothing', async () => {
      const result = await runInstaller(['--prefix', '/opt/lt'])

      expectExit(result, 1)
      expect(result.stderr).toContain('applies only to --binary')
    })

    it.runIf(canInstallBinary)('says what it would do without touching the prefix', async () => {
      const prefix = freshPrefix()
      const result = await runInstaller(['--binary', '--dry-run', '--prefix', prefix])

      expectExit(result, 0)
      expect(result.stdout).toContain(`would verify sha256 ${archive?.sha256}`)
      expect(existsSync(join(prefix, 'bin'))).toBe(false)
    })

    it.runIf(canInstallBinary)('refuses a release that carries no executable for this target', async () => {
      const result = await runInstaller(['--binary', '--version', '0.6.1', '--prefix', freshPrefix()])

      expectExit(result, 1)
      expect(result.stderr).toContain(`carries no ${TARGET} executable`)
    })

    /**
     * The manifest is what carries the checksum. Installing an archive without
     * one would be trusting a download because of where it was hosted, which is
     * the thing the npm path already refuses to do.
     */
    it.runIf(canInstallBinary)('refuses an archive the manifest records no checksum for', async () => {
      omitArchiveDigest = true
      const result = await runInstaller(['--binary', '--prefix', freshPrefix()])

      expectExit(result, 1)
      expect(result.stderr).toContain('records no checksum')
    })

    it.runIf(canInstallBinary)('refuses bytes that do not match, and installs nothing', async () => {
      corruptDownload = 'substituted'
      const prefix = freshPrefix()
      try {
        const result = await runInstaller(['--binary', '--prefix', prefix])

        expectExit(result, 1)
        expect(result.stderr).toContain('does not match the checksum')
        expect(existsSync(join(prefix, 'bin', 'looptroop'))).toBe(false)
      } finally {
        corruptDownload = false
      }
    })

    it.runIf(canInstallBinary)('installs the executable, and the licences that must travel with it', async () => {
      const prefix = freshPrefix()
      const result = await runInstaller(['--binary', '--prefix', prefix], {
        LOOPTROOP_STUB_STATE: join(prefix, 'state'),
      })

      expectExit(result, 0)
      expect(result.stdout).toContain(`Verified sha256 ${archive?.sha256}`)

      const installed = join(prefix, 'bin', 'looptroop')
      expect(spawnSync(installed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.5.9')
      // Shipping this archive redistributes Node, and Node's licence has to come
      // with it. It goes beside the program, not inside a directory that is on
      // somebody's PATH.
      expect(existsSync(join(prefix, 'LICENSE.node.txt'))).toBe(true)
      expect(existsSync(join(prefix, 'bin', 'LICENSE.node.txt'))).toBe(false)
    })

    /**
     * The licences are payload, and payload is not transactional.
     *
     * They used to be copied into the prefix at the top of the install, before
     * the daemon check, the swap, the version probe and the restart. So an
     * upgrade that rolled back restored the executable and then told the user
     * "your previous version is back in place" — beside the *new* version's
     * notices. Nothing may be written into the prefix until the one thing with
     * a rollback has committed.
     */
    it.runIf(canInstallBinary)('does not update the licences an upgrade rolled back', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      archive = buildArchive('0.5.9', stubProgram('0.5.9'), 'notice from the installed version')
      expectExit(await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState }), 0)

      archive = buildArchive('0.5.9', '#!/bin/sh\nexit 3\n', 'notice from the version that does not run')
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 1)
      expect(result.stderr).toContain('rolled back')
      expect(readFileSync(join(prefix, 'LICENSE.node.txt'), 'utf8')).toBe('notice from the installed version')
    })

    /**
     * `status` has three answers and the swap used to accept two of them as
     * "stopped", so an upgrade could replace the executable under a live daemon
     * and then never start it again — leaving the old version serving while
     * `looptroop --version` reported the new one.
     *
     * Resolved rather than refused: it is asked to stop, has to *confirm* it
     * stopped, and is started again afterwards, because a probe that cannot
     * answer may well have been answering for a service that was up.
     */
    it.runIf(canInstallBinary)('stops and restarts a daemon whose state it cannot read', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      archive = buildArchive('0.5.9', stubProgram('0.5.9', { status: 'unparseable' }))
      expectExit(await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState }), 0)

      archive = buildArchive('0.5.9', stubProgram('0.5.9'))
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 0)
      expect(result.stdout).toContain('would not report whether its daemon is running')
      // Started again, from the copy that is now installed.
      expect(result.stdout).toContain('the daemon is running again')
      expect(existsSync(stubState)).toBe(true)
    })

    /**
     * The other half of that rule, and the reason it resolves rather than
     * refuses. An executable that cannot print its own version cannot answer a
     * daemon probe either — so refusing on an unreadable state would wedge
     * exactly the person who most needs to reinstall.
     */
    /**
     * The mirror of the `notAnswering` fix, and the regression it caused.
     *
     * "Something is there" is the right question for the *stop* decision and
     * the wrong one for the *start* decision: a daemon that comes up and never
     * answers is precisely the failure the restart check exists to catch, so
     * counting it as started reported a broken upgrade as a successful one and
     * skipped the rollback. One predicate cannot answer both questions.
     */
    it.runIf(canInstallBinary)('rolls back when the restarted daemon never answers', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      archive = buildArchive('0.5.9', stubProgram('0.5.9'))
      expectExit(await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState }), 0)
      writeFileSync(stubState, '')

      // Starts, and then only ever reports itself as present-but-not-answering.
      archive = buildArchive('0.5.9', stubProgram('0.5.9', { status: 'not-answering' }))
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 1)
      expect(result.stderr).toContain('would not start')
      expect(result.stderr).toContain('rolled back')
    }, 90_000)

    /**
     * `running: false` is not "nothing is there". The CLI reports a live but
     * unresponsive daemon that way, with the pid in a separate `notAnswering`
     * field — its own comment says the split exists because every installer
     * reads `running` as "answering". Reading only `running` called a process
     * holding the port stopped, so the executable was swapped underneath it and
     * the daemon started afterwards could not bind.
     */
    it.runIf(canInstallBinary)('stops a daemon that is alive but not answering', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      archive = buildArchive('0.5.9', stubProgram('0.5.9', { status: 'not-answering' }))
      expectExit(await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState }), 0)
      // Alive, and not answering.
      writeFileSync(stubState, '')

      // The version being installed answers normally, so the upgrade should
      // succeed. Written the other way round first — both copies unresponsive —
      // this asserted a successful install, and passed only because
      // `startDaemon` was accepting a present-but-silent daemon as started. The
      // test was encoding the bug.
      archive = buildArchive('0.5.9', stubProgram('0.5.9'))
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 0)
      expect(result.stdout).toContain('Stopping the running daemon')
      // Stopped, and put back: it was serving before the upgrade.
      expect(result.stdout).toContain('the daemon is running again')
      expect(existsSync(stubState)).toBe(true)
    })

    /**
     * The other end of the unknown branch. When the probe cannot answer *and*
     * `stop` reports that it failed, nothing at all has been established — so
     * the executable is left alone rather than swapped on no information.
     *
     * `stop`'s exit code is the evidence here. Before it was read, the check
     * was `daemonRunning(...) !== true`, which an unreadable probe satisfies on
     * the first poll: the thirty-second wait proved nothing and the swap went
     * ahead regardless.
     */
    it.runIf(canInstallBinary)('refuses when the state is unreadable and the stop failed', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      archive = buildArchive('0.5.9', stubProgram('0.5.9', { status: 'unparseable-and-stop-fails' }))
      expectExit(await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState }), 0)

      const installed = join(prefix, 'bin', 'looptroop')
      const before = readFileSync(installed, 'utf8')
      archive = buildArchive('0.5.9', stubProgram('0.5.9'))
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 1)
      expect(result.stderr).toContain('did not succeed')
      expect(result.stderr).toContain('Nothing was installed')
      // The executable it refused to replace is byte-for-byte what it was.
      expect(readFileSync(installed, 'utf8')).toBe(before)
    })

    it.runIf(canInstallBinary)('installs over an executable that does not run at all', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      archive = buildArchive('0.5.9', '#!/bin/sh\nexit 3\n')
      // It installs nothing, but it does leave the broken copy quarantined and
      // no working executable behind, which is the state to recover from.
      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })
      mkdirSync(join(prefix, 'bin'), { recursive: true })
      writeFileSync(join(prefix, 'bin', 'looptroop'), '#!/bin/sh\nexit 3\n')
      chmodSync(join(prefix, 'bin', 'looptroop'), 0o755)

      archive = buildArchive('0.5.9', stubProgram('0.5.9'))
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 0)
      expect(result.stdout).toContain('does not run, so there is no daemon of its to stop')
      expect(spawnSync(join(prefix, 'bin', 'looptroop'), ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.5.9')
      // Without that escape this would take the "cannot say, so stop it" path,
      // whose whole point is that it starts the daemon again afterwards — and
      // there was no daemon here to put back.
      expect(existsSync(stubState)).toBe(false)
    })

    /**
     * A lock is removed by whoever holds it, and only by them.
     *
     * The takeover path is where this goes wrong: two installers that both see
     * one stale lock used to both delete it and both create their own, after
     * which the second deleted the first's. Injected here from the other end —
     * the lock changes hands while this install is running — because the
     * observable consequence is the same and it is reachable without a race.
     */
    it.runIf(canInstallBinary)('leaves behind a lock that is no longer its own', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      const lock = join(prefix, '.install.lock')

      archive = buildArchive('0.5.9', stubProgram('0.5.9'))
      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })
      // Running, so the upgrade below stops it and starts it again — and it is
      // the restart that stands in for another installer claiming the lock.
      writeFileSync(stubState, '')

      archive = buildArchive('0.5.9', stubProgram('0.5.9', { start: 'takeover' }))
      const result = await runInstaller(['--binary', '--prefix', prefix], {
        LOOPTROOP_STUB_STATE: stubState,
        LOOPTROOP_STUB_LOCK: lock,
      })

      expectExit(result, 0)
      expect(existsSync(lock)).toBe(true)
      expect(readFileSync(lock, 'utf8')).toContain('someone-else')
    })

    /**
     * The sweep at the top of every install removes leftovers, which is right
     * while there is a working executable beside them. With `installed`
     * missing, the backup *is* the user's only copy — the state a rollback
     * whose restore failed leaves behind, and whose message tells them where
     * that backup is. Re-running the installer is the obvious next move, and it
     * used to delete the backup before the fresh install had proved anything.
     */
    it.runIf(canInstallBinary)('keeps the backup when nothing is installed beside it', async () => {
      const prefix = freshPrefix()
      const bin = join(prefix, 'bin')
      mkdirSync(bin, { recursive: true })
      const backup = join(bin, '.looptroop-previous-4242')
      writeFileSync(backup, 'the only working copy')
      // Alongside leftovers that are nobody's only copy and should still go.
      writeFileSync(join(bin, 'looptroop.rejected-4242'), 'rejected')

      archive = buildArchive('0.5.9', stubProgram('0.5.9'))
      const result = await runInstaller(['--binary', '--prefix', prefix], {
        LOOPTROOP_STUB_STATE: join(prefix, 'state'),
      })

      expectExit(result, 0)
      expect(readFileSync(backup, 'utf8')).toBe('the only working copy')
      expect(existsSync(join(bin, 'looptroop.rejected-4242'))).toBe(false)
    })

    it.runIf(canInstallBinary)('leaves no staging files behind', async () => {
      const prefix = freshPrefix()
      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: join(prefix, 'state') })

      expect(readdirSync(join(prefix, 'bin'))).toEqual(['looptroop'])
      expect(existsSync(join(prefix, '.install.lock'))).toBe(false)
    })

    /**
     * The whole reason this mode is transactional. An executable that downloads
     * whole, matches its checksum, and still cannot run here — wrong
     * architecture, a signature the kernel refuses, a missing glibc symbol —
     * passes every earlier check and fails at the only moment somebody is
     * watching. Their working copy has to survive it.
     */
    it.runIf(canInstallBinary)('rolls back to the working copy when the new one does not run', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      const installed = join(prefix, 'bin', 'looptroop')

      expectExit(await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState }), 0)

      // The same version, from an archive whose program is broken.
      archive = buildArchive('0.5.9', '#!/bin/sh\nexit 3\n')
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 1)
      expect(result.stderr).toContain('rolled back')
      expect(result.stderr).toContain('previous version is back in place')
      // The point of all of it: what they had still works.
      expect(spawnSync(installed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.5.9')
    })

    /**
     * Restoring the executable is only half a rollback.
     *
     * The install stops a daemon that was up. Putting the old file back and
     * returning leaves the previous version installed and *not running* — an
     * outage caused by an upgrade that reported failure, which is the worst of
     * both. It also used to say "back in place and working" while the service
     * was down.
     */
    it.runIf(canInstallBinary)('restarts the daemon it stopped when it rolls back', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      const installed = join(prefix, 'bin', 'looptroop')

      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })
      writeFileSync(stubState, '')

      archive = buildArchive('0.5.9', '#!/bin/sh\nexit 3\n')
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 1)
      expect(result.stderr).toContain('rolled back')
      expect(result.stderr).toContain('It is running again.')
      // The daemon it stopped is back, from the executable that still works.
      expect(existsSync(stubState)).toBe(true)
      expect(spawnSync(installed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.5.9')
    })

    /**
     * The third way an upgrade can fail after stopping the daemon.
     *
     * Replacing the file can throw — a permission problem here, and on Windows a
     * locked executable, which is the likeliest cause of all. This path restored
     * nothing to restart for two rounds of review because the executable was
     * never moved; but the *daemon* was already stopped, so exiting here left
     * the service down exactly as the other paths did.
     *
     * Injected by making the directory unwritable, which is the one way to make
     * the swap fail without also breaking the copy it has to fall back to.
     */
    it.runIf(canInstallBinary && process.getuid?.() !== 0)('restarts the daemon when the swap itself fails', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      const bin = join(prefix, 'bin')

      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })
      writeFileSync(stubState, '')

      chmodSync(bin, 0o555)
      try {
        const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

        expectExit(result, 1)
        expect(result.stderr).toContain('Could not replace')
        expect(result.stderr).toContain('previous version is untouched')
        // The point: it stopped the daemon, so it has to start it again.
        expect(result.stderr).toContain('daemon is running again')
        expect(existsSync(stubState)).toBe(true)
      } finally {
        chmodSync(bin, 0o755)
      }
    })

    /**
     * `--version` succeeding does not prove the daemon comes up. A build that
     * starts and immediately exits passes the first check and fails the second,
     * and those are different failures — so the backup has to survive until the
     * daemon is answering, not until the file runs once.
     */
    it.runIf(canInstallBinary)('rolls back a version that runs but whose daemon will not start', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')
      const installed = join(prefix, 'bin', 'looptroop')

      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })
      writeFileSync(stubState, '')

      // Reports the right version, answers `status`, and `start` does nothing.
      archive = buildArchive('0.5.9', [
        '#!/bin/sh',
        'case "$1" in',
        '  --version) echo "0.5.9" ;;',
        '  status) if [ -f "$LOOPTROOP_STUB_STATE" ]; then echo \'{"running":true}\'; else echo \'{"running":false}\'; fi ;;',
        '  stop) rm -f "$LOOPTROOP_STUB_STATE"; echo "stub stopped" ;;',
        '  start) echo "refusing to start" ;;',
        'esac',
        '',
      ].join('\n'))

      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 1)
      expect(result.stderr).toContain('would not start')
      expect(result.stderr).toContain('It is running again.')
      // Back on the version that works, and serving again: the state file only
      // exists because the restored executable's `start` recreated it.
      expect(existsSync(stubState)).toBe(true)
      expect(spawnSync(installed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.5.9')
    }, 120_000)

    it.runIf(canInstallBinary)('reports a first install that does not run, without claiming a rollback', async () => {
      archive = buildArchive('0.5.9', '#!/bin/sh\nexit 3\n')
      const result = await runInstaller(['--binary', '--prefix', freshPrefix()])

      expectExit(result, 1)
      expect(result.stderr).toContain('does not run here')
      expect(result.stderr).not.toContain('rolled back')
    })

    /**
     * An upgrade must not turn into an outage. Somebody had a daemon running a
     * second ago; leaving it stopped makes them notice and fix it themselves.
     */
    it.runIf(canInstallBinary)('stops a running daemon and starts it again afterwards', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')

      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })
      writeFileSync(stubState, '')

      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expectExit(result, 0)
      expect(result.stdout).toContain('Stopping the running daemon')
      expect(result.stdout).toContain('Starting it again')
      expect(existsSync(stubState)).toBe(true)
    })

    it.runIf(canInstallBinary)('leaves a stopped daemon stopped', async () => {
      const prefix = freshPrefix()
      const stubState = join(prefix, 'state')

      await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expect(result.stdout).not.toContain('Starting it again')
      expect(existsSync(stubState)).toBe(false)
    })

    /**
     * Two installers in one directory is not hypothetical: it is what happens
     * when somebody re-runs a curl pipe because the first looked stuck. The
     * interleaving that costs you leaves no working executable at all.
     */
    it.runIf(canInstallBinary)('refuses to run while another install holds the lock', async () => {
      const prefix = freshPrefix()
      mkdirSync(prefix, { recursive: true })
      writeFileSync(join(prefix, '.install.lock'), '999999 now\n')

      const result = await runInstaller(['--binary', '--prefix', prefix])

      expectExit(result, 1)
      expect(result.stderr).toContain('Another install is already running')
      // Still there: a refusal must not clear the lock it refused over.
      expect(existsSync(join(prefix, '.install.lock'))).toBe(true)
    })

    it.runIf(canInstallBinary)('takes a lock old enough to be from a killed run', async () => {
      const prefix = freshPrefix()
      mkdirSync(prefix, { recursive: true })
      const lock = join(prefix, '.install.lock')
      writeFileSync(lock, '999999 ages ago\n')
      const hoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000)
      utimesSync(lock, hoursAgo, hoursAgo)

      const result = await runInstaller(['--binary', '--prefix', prefix], {
        LOOPTROOP_STUB_STATE: join(prefix, 'state'),
      })

      expect(result.stdout).toContain('stale install lock')
      expectExit(result, 0)
    })
  })
})

/**
 * The two halves of "a transfer this installer will not let run away with it".
 *
 * Both used to be absent: metadata and assets were fetched with no timeout at
 * all, and the body was taken with `arrayBuffer()`, which buffers whatever the
 * other end sends before the checksum that exists to catch a wrong file has a
 * chance to object.
 */
describe('bounded transfers', () => {
  it('abandons a transfer that stops making progress', async () => {
    const guard = stallGuard(20, 'The download')

    await new Promise((done) => setTimeout(done, 60))

    expect(guard.signal.aborted).toBe(true)
    expect(guard.reason()).toContain('made no progress')
    guard.release()
  })

  it('does not fire while bytes keep arriving', async () => {
    const guard = stallGuard(60, 'The download')

    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((done) => setTimeout(done, 20))
      guard.touch()
    }

    expect(guard.signal.aborted).toBe(false)
    expect(guard.reason()).toBeNull()
    guard.release()
  })

  it('refuses a body that declares more than the limit, before reading any of it', async () => {
    let read = 0
    const response = new Response('0123456789', { headers: { 'content-length': '10' } })

    await expect(streamBody(response, 4, 'The archive', () => { read += 1 }, () => {}))
      .rejects.toThrow(/declares 10 bytes/)
    expect(read).toBe(0)
  })

  /**
   * A chunked response declares no length at all, so the only bound that always
   * applies is the running total.
   */
  it('refuses a body that grows past the limit while it is being read', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let chunk = 0; chunk < 4; chunk += 1) controller.enqueue(new Uint8Array(8))
        controller.close()
      },
    })

    await expect(streamBody(new Response(body), 10, 'The archive', () => {}, () => {}))
      .rejects.toThrow(/larger than the 10 bytes/)
  })

  it('hands every chunk to the writer, and counts them', async () => {
    const written: Buffer[] = []
    let touches = 0
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('abc'))
        controller.enqueue(new TextEncoder().encode('de'))
        controller.close()
      },
    })

    const total = await streamBody(new Response(body), 100, 'The archive',
      (chunk) => written.push(chunk), () => { touches += 1 })

    expect(total).toBe(5)
    expect(Buffer.concat(written).toString()).toBe('abcde')
    // Once per chunk: the stall deadline restarts on arrival, not on completion.
    expect(touches).toBe(2)
  })
})

/**
 * `shell: true` was how the installer reached `npm.cmd` and `looptroop.cmd` on
 * Windows, and Node builds that command line by joining the file and arguments
 * with spaces and quoting none of them. Every Windows account whose name
 * contains a space puts the temporary directory somewhere that breaks under
 * that rule, which is most of them.
 */
/**
 * The resolver **as it is generated into the installer**, not as it is written.
 *
 * `scripts/sync-installers.mjs` strips `server/lib/executablePath.ts` into
 * `scripts/installer-core.mjs`, which then goes verbatim into `install.sh` and
 * `install.ps1`. These import from the core, so what is exercised is the copy
 * that ships — the previous hand-written copy passed its own tests for four
 * releases while disagreeing with the daemon about which `npm` to run.
 *
 * Every case here is a Windows rule, and these run on Linux, so PATH, PATHEXT
 * and the platform are passed in. That is deliberate: the first version of this
 * resolver tried the extensionless name first, which broke every `npm` call on
 * Windows and could not fail anywhere else. A rule that only holds on one
 * platform has to be testable on the others.
 */
describe('PATH resolution', () => {
  const roots: string[] = []

  afterAll(() => {
    for (const dir of roots.splice(0)) removeTempDir(dir)
  })

  /** A directory holding each named file, and its path. */
  /**
   * Canonicalised, because the resolver answers with the real path and macOS
   * keeps its temp directory behind a symlink (`/var` is `/private/var`). A raw
   * `tmpdir()` here failed five cases on the macOS lane and nowhere else.
   */
  function directoryWith(...names: string[]) {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'looptroop-path-test-')))
    roots.push(dir)
    for (const name of names) writeFileSync(join(dir, name), '')
    return dir
  }

  /**
   * The Windows search, by Windows rules, on whatever host runs the suite.
   *
   * `platform: 'win32'` makes the generated resolver split PATH on `;` and apply
   * PATHEXT, so these cases join their PATH with `win32.delimiter`. No override
   * is needed: Windows has no ownership signal for the resolver to judge, so a
   * directory is searched wherever it is.
   */
  function resolveOnPath(command: string, pathValue: string, pathExt: string): string | null {
    return findTrustedExecutablePath(command, {
      env: { PATH: pathValue, PATHEXT: pathExt },
      platform: 'win32',
      cache: null,
    })
  }

  // Lowercase, unlike the real `.COM;.EXE;.BAT;.CMD`. Windows filesystems are
  // case-insensitive so the real casing never matters there; this test runs on
  // a filesystem where it does, and what is under test is the precedence and
  // ordering rules, not the spelling of the environment variable.
  const PATHEXT = '.com;.exe;.bat;.cmd'

  /**
   * The regression. A Windows Node install ships `npm` — a POSIX shell script
   * for Git Bash — in the same directory as `npm.cmd`. Resolving the bare name
   * first found the script, which is not a `.cmd`, so it was spawned directly;
   * Windows cannot execute it, and every npm call in the installer failed with
   * "npm is not on PATH".
   */
  it('prefers an executable extension over a file with no extension', () => {
    const dir = directoryWith('npm', 'npm.cmd')

    expect(resolveOnPath('npm', dir, PATHEXT)).toBe(join(dir, 'npm.cmd'))
  })

  it('follows PATHEXT order', () => {
    const dir = directoryWith('tool.cmd', 'tool.exe')

    // `.exe` comes before `.cmd` in PATHEXT, and Windows picks the first match
    // rather than the best one.
    expect(resolveOnPath('tool', dir, PATHEXT)).toBe(join(dir, 'tool.exe'))
  })

  /**
   * Windows will not execute a file with no extension at all, so one must never
   * be the answer for a bare command name — not even when nothing else matches.
   */
  it('does not resolve a bare name to an extensionless file', () => {
    const dir = directoryWith('npm')

    expect(resolveOnPath('npm', dir, PATHEXT)).toBeNull()
  })

  it('uses a command that names its own extension as written', () => {
    const dir = directoryWith('tool.cmd', 'tool.exe')

    expect(resolveOnPath('tool.cmd', dir, PATHEXT)).toBe(join(dir, 'tool.cmd'))
  })

  it('searches PATH entries in order', () => {
    const first = directoryWith('tool.exe')
    const second = directoryWith('tool.exe')

    expect(resolveOnPath('tool', [first, second].join(win32.delimiter), PATHEXT)).toBe(join(first, 'tool.exe'))
    expect(resolveOnPath('tool', [second, first].join(win32.delimiter), PATHEXT)).toBe(join(second, 'tool.exe'))
  })

  /**
   * Windows tolerates a quoted PATH entry and `SearchPath` strips the quotes.
   * `join` does not, so an unstripped entry matches nothing — and quoting is
   * exactly what a directory containing a space attracts.
   */
  it('strips quotes from a PATH entry', () => {
    const dir = directoryWith('tool.exe')

    expect(resolveOnPath('tool', `"${dir}"`, PATHEXT)).toBe(join(dir, 'tool.exe'))
  })

  it('skips empty entries and reports nothing found as null', () => {
    const dir = directoryWith('other.exe')

    expect(resolveOnPath('tool', ['', dir, '""'].join(win32.delimiter), PATHEXT)).toBeNull()
  })
})

describe('windows command lines', () => {
  it('makes one token of an argument containing spaces', () => {
    expect(quoteForCmd(String.raw`C:\Users\Ada Lovelace\AppData\Local\Temp\looptroop-9.9.9.tgz`))
      .toBe(String.raw`"C:\Users\Ada Lovelace\AppData\Local\Temp\looptroop-9.9.9.tgz"`)
  })

  /**
   * The other half of the rule, and the one that is easy to get wrong by
   * quoting everything. `cmd` hands a `.cmd` shim its arguments as written, so
   * a quoted `install` arrives as `"install"` and a shim comparing
   * `if "%1"=="--version"` stops matching. Anything that needs no quoting is
   * passed through exactly as the caller wrote it.
   */
  it('leaves an argument that needs no quoting exactly as it was', () => {
    for (const plain of ['install', '-g', '--no-audit', String.raw`C:\Users\ada\x.tgz`]) {
      expect(quoteForCmd(plain)).toBe(plain)
    }
  })

  it('makes one token of an argument cmd.exe would otherwise read as an operator', () => {
    for (const value of ['a&b', 'a|b', 'a>b', 'a<b', 'a^b', 'a(b)']) {
      expect(quoteForCmd(value)).toBe(`"${value}"`)
    }
  })

  /**
   * A path cannot contain a quote on Windows, so this is about arguments that
   * are not paths. Doubling is cmd's own escape.
   */
  it('doubles an embedded quote rather than ending the token', () => {
    expect(quoteForCmd('say "hello"')).toBe('"say ""hello"""')
  })
})

describe('installer wrappers', () => {
  it('carry an exact copy of the installer core', () => {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'sync-installers.mjs'), '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(`${result.stdout}${result.stderr}`).toContain('PASS')
    expectExit(result, 0)
  })

  /**
   * `--check` compares the generated regions and says nothing about the code
   * around them. That is exactly where a regeneration breaks a wrapper: when the
   * generated block grew from a `case` *arm* to the whole `case…esac`, the
   * handwritten arms below the end marker became a second, unbalanced statement
   * and `install.sh` stopped parsing — while `--check` still reported PASS.
   *
   * Two parsers because they disagree: `sh` is what the documented
   * `curl … | sh` pipeline uses, `bash` is what most people have interactively.
   */
  it.runIf(process.platform !== 'win32')('parse as shell scripts', () => {
    for (const shell of ['sh', 'bash']) {
      const result = spawnSync(shell, ['-n', join(repoRoot, 'install.sh')], { encoding: 'utf8' })

      expect(`${shell}: ${result.stderr}`).toBe(`${shell}: `)
      expect(`${shell}: ${result.status}`).toBe(`${shell}: 0`)
    }
  })

  /**
   * The same failure mode in `install.ps1`, which has no parser available on the
   * Linux runners. Structural instead: every generated region is delimited once,
   * and the PowerShell blocks balance. A leftover handwritten remnant below an
   * end marker shows up as an extra brace.
   */
  it('keep one delimited region per generated block, with balanced braces', () => {
    for (const wrapper of ['install.sh', 'install.ps1']) {
      const source = readFileSync(join(repoRoot, wrapper), 'utf8')
      const begins = source.match(/--- BEGIN [a-z-]+ \(generated/g) ?? []
      const ends = source.match(/--- END [a-z-]+ ---/g) ?? []

      expect(`${wrapper}: ${begins.length === ends.length}`).toBe(`${wrapper}: true`)
      expect(`${wrapper}: ${begins.length > 0}`).toBe(`${wrapper}: true`)

      const opens = (source.match(/\{/g) ?? []).length
      const closes = (source.match(/\}/g) ?? []).length
      expect(`${wrapper}: ${opens}`).toBe(`${wrapper}: ${closes}`)
    }
  })

  /**
   * The handwritten halves, which `installers:check` does not read.
   *
   * `--check` compares the generated regions only, and only in the release
   * workflow at that. Everything a wrapper does *around* the embedded core —
   * finding Node, forwarding options, refusing a truncated body — is
   * handwritten, unchecked, and is where the drift that reaches users actually
   * lives: `install.ps1` forwarded four of the six options the core parses, so
   * `--dry-run` and `--help` worked on macOS and Linux and did nothing at all on
   * Windows for as long as both have existed.
   */
  it('forward every option the core accepts', () => {
    const ps1 = readFileSync(join(repoRoot, 'install.ps1'), 'utf8')
    const sh = readFileSync(join(repoRoot, 'install.sh'), 'utf8')

    for (const option of INSTALL_OPTIONS) {
      // Declared as a parameter, so PowerShell binds it rather than refusing
      // the whole invocation as an unknown argument.
      expect(`${option.ps} declared: ${new RegExp(`^\\s*\\[(?:string|switch)\\]\\$${option.ps.slice(1)},?\\s*$`, 'm').test(ps1)}`)
        .toBe(`${option.ps} declared: true`)
      // And mapped onto the spelling the core parses.
      expect(`${option.ps} forwarded: ${ps1.includes(`'${option.sh}'`)}`)
        .toBe(`${option.ps} forwarded: true`)
    }

    // `install.sh` forwards positionally, so it needs no per-option mapping —
    // but it does have to pass the arguments on at all.
    expect(sh).toContain('node "$core" "$@"')
  })

  /**
   * A truncated body is the one failure both wrappers can detect about
   * themselves, and the only useful thing to say about it is what to do next.
   * `install.ps1` had the guard and printed no way out of it.
   */
  it('tell the reader how to recover from a truncated download', () => {
    for (const [wrapper, url] of [
      ['install.sh', 'https://www.looptroop.ovh/install'],
      ['install.ps1', 'https://www.looptroop.ovh/install.ps1'],
    ]) {
      const source = readFileSync(join(repoRoot, wrapper!), 'utf8')
      const guard = source.slice(source.indexOf('truncated in transit'))

      expect(`${wrapper}: ${guard.slice(0, 400).includes(url!)}`).toBe(`${wrapper}: true`)
    }
  })

  /**
   * `install.sh` ended in `exec node`, which replaced the shell and so meant
   * its EXIT trap never ran: every install leaked the temporary directory it
   * had just written the core into. Removing `exec` means reproducing what
   * `exec` was doing — signal delivery and the exit status — by hand, and each
   * of those is a separate way to get this wrong, so all three are exercised
   * rather than read out of the source.
   */
  describe.runIf(process.platform !== 'win32')('install.sh cleans up after itself', () => {
    const scratch: string[] = []

    afterAll(() => {
      for (const dir of scratch.splice(0)) removeTempDir(dir)
    })

    /**
     * Runs the wrapper with a temporary directory of its own, so what it leaves
     * behind is the whole content of that directory afterwards.
     */
    function runWrapper(args: string[], stubs: Record<string, string> = {}) {
      const temp = mkdtempSync(join(tmpdir(), 'looptroop-wrapper-tmp-'))
      const bin = mkdtempSync(join(tmpdir(), 'looptroop-wrapper-bin-'))
      scratch.push(temp, bin)
      // `looptroop --version` is probed at the end of a successful install, and
      // without a stub that reads whatever is on the runner.
      for (const [name, body] of Object.entries({ looptroop: '#!/bin/sh\necho 9.9.9\n', ...stubs })) {
        writeFileSync(join(bin, name), body)
        chmodSync(join(bin, name), 0o755)
      }

      const child = spawn('sh', [join(repoRoot, 'install.sh'), ...args], {
        env: { ...process.env, TMPDIR: temp, PATH: `${bin}:${process.env.PATH ?? ''}` },
        // Its own process group, so a signal aimed at the wrapper's pid is
        // aimed at the wrapper alone — which is the case `exec` used to cover
        // and forwarding now has to.
        detached: true,
      })

      let output = ''
      child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })

      const settled = new Promise<{ status: number | null, signal: string | null }>((done, reject) => {
        child.on('error', reject)
        child.on('close', (status, signal) => done({ status, signal }))
      })

      return { child, temp, output: () => output, settled }
    }

    /** Everything under `dir`, so "cleaned up" is a claim about the directory. */
    function leftovers(dir: string) {
      return readdirSync(dir)
    }

    it('leaves nothing behind after an install that worked', async () => {
      const tarball = join(mkdtempSync(join(tmpdir(), 'looptroop-wrapper-pkg-')), 'looptroop-9.9.9.tgz')
      scratch.push(dirname(tarball))
      writeFileSync(tarball, 'not really a tarball')

      const run = runWrapper(['--tarball', tarball], {
        npm: '#!/bin/sh\nexit 0\n',
      })
      const { status } = await run.settled

      expect(`${status}: ${run.output()}`).toContain('0: ')
      expect(leftovers(run.temp)).toEqual([])
    })

    it('leaves nothing behind after an install that failed, and reports the failure', async () => {
      const run = runWrapper(['--tarball', '/nonexistent/looptroop.tgz'])
      expectExit({ ...await run.settled, outputText: run.output }, 1)
      expect(run.output()).toContain('No such tarball')
      expect(leftovers(run.temp)).toEqual([])
    })

    /** Waits for `marker` to appear in a run's output, or gives up. */
    async function waitForOutput(run: { output: () => string }, marker: string) {
      const deadline = Date.now() + 15_000
      while (!run.output().includes(marker) && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50))
      }
      expect(run.output()).toContain(marker)
    }

    /**
     * Ctrl+C mid-install, which is the case `exec` broke.
     *
     * The terminal delivers to the whole foreground process group, so the
     * install stops either way — what `exec` cost was the cleanup, because it
     * had replaced the shell that owned the trap. Every interrupted install
     * left a temporary directory holding a copy of the installer, and the core
     * left its own download directory beside it.
     *
     * Only the cleanup is asserted, deliberately. The exit status is not a
     * property of the wrapper here: the signal goes to the group, so it races
     * the npm the core has just spawned, and an `npm` that returns before the
     * signal reaches it makes this an install that *succeeded* — after which 0
     * is the right answer. Measured rather than assumed: across thirty-odd
     * runs, loaded and idle, the status was 1, 130 or 0 and the temporary
     * directory was empty every time. The status propagation is proved next
     * door instead, against a stub that decides its own exit code.
     */
    it('leaves nothing behind when the install is interrupted', async () => {
      const tarball = join(mkdtempSync(join(tmpdir(), 'looptroop-wrapper-pkg-')), 'looptroop-9.9.9.tgz')
      scratch.push(dirname(tarball))
      writeFileSync(tarball, 'not really a tarball')

      // An npm that does not come back, so there is an install in progress to
      // interrupt. It ends on its own if nothing reaches it, rather than
      // outliving the test run.
      const run = runWrapper(['--tarball', tarball], {
        npm: '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 99.9.9; exit 0; fi\nsleep 30\n',
      })
      await waitForOutput(run, 'Installing with npm')

      // Only while it is still running: once it has exited, its pid — and so
      // the group id, which is the same number — can belong to something else,
      // and this would deliver a SIGINT to whatever inherited it.
      expect(run.child.exitCode).toBeNull()
      try {
        process.kill(-run.child.pid!, 'SIGINT')
      } catch (error) {
        // It exited between the check above and this line. Nothing to
        // interrupt, and nothing to fail: what this asserts is the cleanup.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
      await run.settled

      // Both directories: the wrapper's own, and the one the core creates
      // inside it for downloads. `TMPDIR` is this run's, so anything at all
      // here is something that leaked.
      expect(leftovers(run.temp)).toEqual([])
    }, 40_000)

    /**
     * The half a process group does not cover: a signal sent to this script's
     * pid alone, which is how `timeout` and most supervisors stop a process.
     * With `exec` the signal arrived at node because node *was* this process;
     * without forwarding it would be handled here and node would keep running.
     *
     * Against a stub rather than the real core, deliberately. Node cannot act
     * on a signal while it is blocked in `spawnSync` waiting for npm, so a real
     * core would only prove how Node schedules signal handlers. What is being
     * tested is the wrapper: that it passes the signal on, and that the status
     * the caller sees is the child's own rather than the shell's.
     */
    /**
     * A child may exit above 128 without any signal reaching the wrapper —
     * `exit 130` is a perfectly ordinary thing for a build tool to do. `wait`
     * reports that identically to an interrupted wait, so a retry keyed on the
     * number alone re-waits on a status that will never change: the wrapper
     * hangs instead of exiting. The retry is keyed on the trap having fired.
     *
     * 127 is in the list because the retry uses it as its "no such child"
     * sentinel. That reading is only valid on a retry: on the first wait, 127
     * is the child's own exit code, and a child is entitled to exit 127.
     *
     * These are deterministic, unlike the signal race they sit beside: no
     * signal is sent, so there is nothing to lose.
     */
    it.each([127, 129, 130, 137, 255])('passes on a child that exits %i of its own accord', async (code) => {
      const run = runWrapper(['--tarball', '/nonexistent/looptroop.tgz'], {
        node: `#!/bin/sh\nexit ${code}\n`,
      })

      expectExit({ ...await run.settled, outputText: run.output }, code)
      expect(leftovers(run.temp)).toEqual([])
    }, 20_000)

    it('forwards a signal aimed at the wrapper, and passes on the child\'s status', async () => {
      const run = runWrapper(['--tarball', '/nonexistent/looptroop.tgz'], {
        node: [
          '#!/bin/sh',
          "trap 'echo CHILD-GOT-TERM; exit 3' TERM",
          'echo CHILD-RUNNING',
          // Backgrounded and waited on, because a trap in `sh` cannot interrupt
          // a foreground command either.
          'sleep 30 &',
          'wait',
          '',
        ].join('\n'),
      })
      await waitForOutput(run, 'CHILD-RUNNING')

      run.child.kill('SIGTERM')
      const settled = await run.settled

      expect(run.output()).toContain('CHILD-GOT-TERM')
      expectExit({ ...settled, outputText: run.output }, 3)
      expect(leftovers(run.temp)).toEqual([])
    }, 40_000)
  })
})

/**
 * `runTool` used to take "no trusted answer" as one case and spawn the bare
 * name for it — so a tool found and *refused* was run anyway, by the child's
 * own search of the same PATH. A refusal now stops the install with the reason.
 */
describe('runTool', () => {
  it.runIf(process.platform !== 'win32')('stops on a refused tool instead of spawning it by name', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'looptroop-runtool-')))
    const marker = join(dir, 'ran')
    const tool = join(dir, 'looptool')
    writeFileSync(tool, `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(tool, 0o755)
    const previousPath = process.env.PATH
    process.env.PATH = dir
    // Root can give the directory away; anyone else makes every file look
    // foreign by stubbing getuid, which is enough for one directory.
    const asRoot = process.getuid?.() === 0
    if (asRoot) chownSync(dir, 4242, 4242)
    const spy = asRoot ? null : vi.spyOn(process, 'getuid').mockReturnValue((process.getuid?.() ?? 0) + 1)
    // The running Node's owner is trusted too — on a CI runner that is the very
    // uid being made to look foreign — so it is taken out of the case.
    const execPath = process.execPath
    if (!asRoot) process.execPath = '/nonexistent/looptroop-test/node'
    try {
      expect(() => runTool('looptool', [])).toThrow(/neither root, you, nor the owner of the Node/)
      expect(existsSync(marker)).toBe(false)
    } finally {
      spy?.mockRestore()
      process.execPath = execPath
      if (asRoot) chownSync(dir, 0, 0)
      process.env.PATH = previousPath
      removeTempDir(dir)
    }
  })
})

describe('runTool when a tool is not installed', () => {
  it.runIf(process.platform !== 'win32')('reports ENOENT instead of letting the OS search the current directory', () => {
    // The resolver skips relative and empty PATH entries; the operating system
    // does not. With a trailing colon — the everyday result of `PATH=$PATH:` —
    // a bare-name fallback ran `./looptool` from the child's working directory.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'looptroop-runtool-cwd-')))
    const marker = join(dir, 'ran')
    writeFileSync(join(dir, 'looptool'), `#!/bin/sh\ntouch '${marker}'\n`)
    chmodSync(join(dir, 'looptool'), 0o755)
    try {
      const result = runTool('looptool', [], { cwd: dir, env: { PATH: '/nonexistent-looptroop-bin:' } })

      expect(result.status).toBeNull()
      expect((result.error as NodeJS.ErrnoException | undefined)?.code).toBe('ENOENT')
      expect(existsSync(marker)).toBe(false)
    } finally {
      removeTempDir(dir)
    }
  })

  it('keeps an empty argument as an argument', () => {
    expect(quoteForCmd('')).toBe('""')
  })
})

