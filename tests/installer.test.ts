import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(repoRoot, 'scripts', 'installer-core.mjs')

const TARBALL_BODY = Buffer.from('not really a tarball, but it hashes like one')
const TARBALL_SHA = createHash('sha256').update(TARBALL_BODY).digest('hex')

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
  { tag_name: 'v0.5.9', assets: [{ name: 'release-manifest.json' }, { name: 'looptroop-0.5.9.tgz' }] },
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

  function manifestFor(version: string) {
    return {
      name: 'looptroop',
      version,
      tarball: `looptroop-${version}.tgz`,
      bytes: TARBALL_BODY.length,
      sha256: TARBALL_SHA,
      ...(engines === null ? {} : { engines }),
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

  beforeAll(async () => {
    server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const tagMatch = /^\/repos\/[^/]+\/[^/]+\/releases\/tags\/(.+)$/.exec(url.pathname)
      const downloadMatch = /^\/download\/([^/]+)\/(.+)$/.exec(url.pathname)

      if (url.pathname.endsWith('/releases')) {
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
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
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
    const result = await runInstaller(['--dry-run', '--prefix', '/opt'])

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

  it('reports a missing local tarball instead of installing something else', async () => {
    const result = await runInstaller(['--tarball', join(tmpdir(), 'looptroop-absent.tgz')])

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('No such tarball')
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

  it.runIf(process.platform !== 'win32')('parse as shell scripts', () => {
    const result = spawnSync('sh', ['-n', join(repoRoot, 'install.sh')], { encoding: 'utf8' })

    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
  })
})
