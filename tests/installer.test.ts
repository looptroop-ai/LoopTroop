import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { binaryAssetName, binaryTarget, defaultPrefix, detectLibc, onPath } from '../scripts/installer-core.mjs'
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
    return new Promise<{ status: number | null, stdout: string, stderr: string }>((done, reject) => {
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
      child.on('close', (status) => done({ status, stdout, stderr }))
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
    expect(result.status).toBe(0)
  })

  it('never picks a prerelease by default', async () => {
    expect((await runInstaller(['--dry-run'])).stdout).not.toContain('0.6.0-rc.1')
  })

  it('installs a pinned prerelease when asked for one by name', async () => {
    const result = await runInstaller(['--dry-run', '--version', '0.6.0-rc.1'])

    expect(result.stdout).toContain('Installing LoopTroop 0.6.0-rc.1')
    expect(result.status).toBe(0)
  })

  it('accepts a pinned version written with a leading v', async () => {
    expect((await runInstaller(['--dry-run', '--version', 'v0.5.9'])).stdout).toContain('Installing LoopTroop 0.5.9')
  })

  it('refuses a pinned release with no installable assets', async () => {
    const result = await runInstaller(['--dry-run', '--version', '0.6.1'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('no installable assets')
  })

  it('refuses an unknown option rather than ignoring it', async () => {
    const result = await runInstaller(['--dry-run', '--global'])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Unknown option')
  })

  it('refuses bytes that do not match the checksum, and installs nothing', async () => {
    corruptDownload = 'substituted'
    try {
      const result = await runInstaller([])

      expect(result.status).toBe(1)
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

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('the release records')
      expect(result.stdout).not.toContain('Installing with npm')
    } finally {
      corruptDownload = false
    }
  })

  it('installs the verified tarball with npm, so npm can still uninstall it', async () => {
    const result = await runInstaller([])

    expect(result.status).toBe(0)
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

      expect(result.status).toBe(1)
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

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('needs npm >=999.0.0')
    } finally {
      engines = null
    }
  })

  it('installs from a manifest written before the floor was recorded', async () => {
    // The manifest shipped by the release before this one has no `engines`.
    // Treating that as a failed check would make the installer unable to install
    // the very release it is being added for.
    expect((await runInstaller(['--dry-run'])).status).toBe(0)
  })

  it('installs a local tarball without touching the network', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'looptroop-local-'))
    tempDirs.push(dir)
    const tarball = join(dir, 'looptroop-0.5.9.tgz')
    writeFileSync(tarball, TARBALL_BODY)

    const result = await runInstaller(['--tarball', tarball], { LOOPTROOP_INSTALL_API: 'http://127.0.0.1:1' })

    expect(result.status).toBe(0)
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

    const result = await new Promise<{ status: number | null, stdout: string }>((done) => {
      const child = spawn(process.execPath, [join(dir, 'link', 'installer-core.mjs'), '--help'])
      let stdout = ''
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.on('close', (status) => done({ status, stdout }))
    })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Usage:')
  })

  it('reports a missing local tarball instead of installing something else', async () => {
    const result = await runInstaller(['--tarball', join(tmpdir(), 'looptroop-absent.tgz')])

    expect(result.status).toBe(1)
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
    /** Stands in for the executable. Answers the four things the installer asks. */
    function stubProgram(version: string) {
      return [
        '#!/bin/sh',
        'case "$1" in',
        `  --version) echo "${version}" ;;`,
        // Statefulness via a file, so `stop` is observable and `status` can
        // disagree with itself before and after.
        '  status) if [ -f "$LOOPTROOP_STUB_STATE" ]; then echo \'{"running":true}\'; else echo \'{"running":false}\'; fi ;;',
        '  stop) rm -f "$LOOPTROOP_STUB_STATE"; echo "stub stopped" ;;',
        '  start) : > "$LOOPTROOP_STUB_STATE"; echo "stub started" ;;',
        'esac',
        '',
      ].join('\n')
    }

    /** A release archive with the layout `build-binary.mjs` produces. */
    function buildArchive(version: string, program: string) {
      const dir = mkdtempSync(join(tmpdir(), 'looptroop-archive-'))
      tempDirs.push(dir)
      const name = `looptroop-${version}-${TARGET}`
      mkdirSync(join(dir, name))
      writeFileSync(join(dir, name, 'looptroop'), program)
      chmodSync(join(dir, name, 'looptroop'), 0o755)
      writeFileSync(join(dir, name, 'LICENSE.node.txt'), 'Node.js is MIT licensed.')

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

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('cannot be combined')
    })

    it('refuses --prefix without --binary, which would silently do nothing', async () => {
      const result = await runInstaller(['--prefix', '/opt/lt'])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('applies only to --binary')
    })

    it.runIf(canInstallBinary)('says what it would do without touching the prefix', async () => {
      const prefix = freshPrefix()
      const result = await runInstaller(['--binary', '--dry-run', '--prefix', prefix])

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`would verify sha256 ${archive?.sha256}`)
      expect(existsSync(join(prefix, 'bin'))).toBe(false)
    })

    it.runIf(canInstallBinary)('refuses a release that carries no executable for this target', async () => {
      const result = await runInstaller(['--binary', '--version', '0.6.1', '--prefix', freshPrefix()])

      expect(result.status).toBe(1)
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

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('records no checksum')
    })

    it.runIf(canInstallBinary)('refuses bytes that do not match, and installs nothing', async () => {
      corruptDownload = 'substituted'
      const prefix = freshPrefix()
      try {
        const result = await runInstaller(['--binary', '--prefix', prefix])

        expect(result.status).toBe(1)
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

      expect(result.status).toBe(0)
      expect(result.stdout).toContain(`Verified sha256 ${archive?.sha256}`)

      const installed = join(prefix, 'bin', 'looptroop')
      expect(spawnSync(installed, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('0.5.9')
      // Shipping this archive redistributes Node, and Node's licence has to come
      // with it. It goes beside the program, not inside a directory that is on
      // somebody's PATH.
      expect(existsSync(join(prefix, 'LICENSE.node.txt'))).toBe(true)
      expect(existsSync(join(prefix, 'bin', 'LICENSE.node.txt'))).toBe(false)
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

      expect((await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })).status).toBe(0)

      // The same version, from an archive whose program is broken.
      archive = buildArchive('0.5.9', '#!/bin/sh\nexit 3\n')
      const result = await runInstaller(['--binary', '--prefix', prefix], { LOOPTROOP_STUB_STATE: stubState })

      expect(result.status).toBe(1)
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

      expect(result.status).toBe(1)
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

        expect(result.status).toBe(1)
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

      expect(result.status).toBe(1)
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

      expect(result.status).toBe(1)
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

      expect(result.status).toBe(0)
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

      expect(result.status).toBe(1)
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
      expect(result.status).toBe(0)
    })
  })
})

describe('installer wrappers', () => {
  it('carry an exact copy of the installer core', () => {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'sync-installers.mjs'), '--check'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })

    expect(`${result.stdout}${result.stderr}`).toContain('PASS')
    expect(result.status).toBe(0)
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
})
