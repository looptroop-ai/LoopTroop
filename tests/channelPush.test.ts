import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderHomebrewFormula } from '../scripts/package-manifests.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PUSH = join(repoRoot, 'scripts', 'channel-push.ts')

const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)
const REPO = 'looptroop-ai/homebrew-looptroop'

/**
 * The URL carries the version, which is not incidental: the formula states no
 * `version` field, because `brew audit --strict` rejects one the URL already
 * carries, so a fixture whose URL disagrees with its version is not a formula
 * Homebrew would ever see.
 */
function urlFor(version: string): string {
  return `https://example.invalid/looptroop-${version}-bundle.tar.gz`
}

const URL = urlFor('9.9.9')

/**
 * `gh` replaced by a script that answers from a JSON fixture and records what it
 * was asked to write.
 *
 * The decisions are unit-tested in `channelState.test.ts`; what this covers is
 * the wiring around them — that a token without push rights stops the release
 * before anything is read, that a 404 is treated as an empty channel, that the
 * blob SHA read is the one handed back as the compare-and-swap token, and that
 * a refusal writes nothing at all.
 */
/**
 * Not on Windows. The stub below is a script, and `execFileSync` without a
 * shell — which is what the driver uses, correctly, because a real `gh` is an
 * executable — cannot start a `.cmd` on Windows at all. Running these there
 * would be testing the stub rather than the driver, and every job that runs
 * `channel-push.ts` is `runs-on: ubuntu-latest`.
 */
describe.runIf(process.platform !== 'win32')('pushing a descriptor to a package channel', () => {
  const tempDirs: string[] = []
  let stubBin: string
  let statePath: string

  beforeAll(() => {
    stubBin = mkdtempSync(join(tmpdir(), 'looptroop-gh-stub-'))
    tempDirs.push(stubBin)
    statePath = join(stubBin, 'state.json')

    const shim = `
import { readFileSync, appendFileSync } from 'node:fs'
const state = JSON.parse(readFileSync(process.env.GH_STUB_STATE, 'utf8'))
const args = process.argv.slice(2)
const joined = args.join(' ')

if (joined.includes('.permissions.push')) {
  if (state.push === 'unknown') { process.stdout.write('null\\n') }
  else if (state.push === false) { process.stdout.write('false\\n') }
  else { process.stdout.write('true\\n') }
} else if (args.includes('--method') && args.includes('PUT')) {
  appendFileSync(process.env.GH_STUB_STATE + '.put', JSON.stringify(args) + '\\n')
  process.stdout.write('deadbeef\\n')
} else if (joined.includes('/contents/')) {
  if (state.remote === null) process.exit(1)
  process.stdout.write(JSON.stringify({
    content: Buffer.from(state.remote, 'utf8').toString('base64'),
    sha: state.blobSha,
  }) + '\\n')
} else {
  process.exit(1)
}
`
    writeFileSync(join(stubBin, 'gh.mjs'), shim)
    writeFileSync(join(stubBin, 'gh'), `#!/bin/sh\nexec node "${join(stubBin, 'gh.mjs')}" "$@"\n`)
    chmodSync(join(stubBin, 'gh'), 0o755)
  })

  afterAll(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function setState(state: { push?: boolean | 'unknown', remote?: string | null, blobSha?: string }): void {
    writeFileSync(statePath, JSON.stringify({ push: true, remote: null, blobSha: 'abc123', ...state }))
    rmSync(`${statePath}.put`, { force: true })
  }

  function putCalls(): string[][] {
    try {
      return readFileSync(`${statePath}.put`, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  function push(extra: string[] = []) {
    return new Promise<{ status: number | null, stdout: string, stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [
        PUSH,
        '--channel', 'homebrew',
        '--repo', REPO,
        '--version', '9.9.9',
        '--url', URL,
        '--sha256', SHA,
        ...extra,
      ], {
        env: {
          ...process.env,
          GH_STUB_STATE: statePath,
          PATH: `${stubBin}:${process.env.PATH ?? ''}`,
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

  it('publishes when the channel has nothing yet', async () => {
    setState({ remote: null })

    const result = await push()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('publish')
    expect(putCalls()).toHaveLength(1)
  })

  /**
   * The first write of a version must not carry a compare-and-swap token: there
   * is nothing to swap against, and sending one would fail every first publish.
   */
  it('sends no blob sha when creating the file', async () => {
    setState({ remote: null })
    await push()

    expect(putCalls()[0]!.join(' ')).not.toContain('sha=')
  })

  it('hands back the blob sha it read, so a concurrent push loses rather than this one', async () => {
    setState({ remote: renderHomebrewFormula({ version: '9.9.8', url: urlFor('9.9.8'), sha256: SHA }), blobSha: 'the-blob-we-read' })

    const result = await push()

    expect(result.status).toBe(0)
    expect(putCalls()[0]!.join(' ')).toContain('sha=the-blob-we-read')
  })

  it('does nothing when the published descriptor is already this one', async () => {
    setState({ remote: renderHomebrewFormula({ version: '9.9.9', url: URL, sha256: SHA }) })

    const result = await push()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('noop')
    expect(putCalls()).toHaveLength(0)
  })

  it('refuses to downgrade the channel, and writes nothing', async () => {
    setState({ remote: renderHomebrewFormula({ version: '10.0.0', url: urlFor('10.0.0'), sha256: SHA }) })

    const result = await push()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('downgrade')
    expect(putCalls()).toHaveLength(0)
  })

  it('refuses the same version with different bytes, and says how to override', async () => {
    setState({ remote: renderHomebrewFormula({ version: '9.9.9', url: URL, sha256: OTHER_SHA }) })

    const result = await push()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('sha256')
    expect(result.stderr).toContain('force')
    expect(putCalls()).toHaveLength(0)
  })

  it('replaces the same version when an operator forces it', async () => {
    setState({ remote: renderHomebrewFormula({ version: '9.9.9', url: URL, sha256: OTHER_SHA }) })

    const result = await push(['--force'])

    expect(result.status).toBe(0)
    expect(putCalls()).toHaveLength(1)
  })

  /**
   * A token that lost its scope answers 404 to the read, which is
   * indistinguishable from an empty channel. The contents API will not replace
   * a file without its blob SHA, so this cannot overwrite anything — but saying
   * so up front beats a baffling failure halfway through a release.
   */
  it('stops on a token that is explicitly read-only, before reading anything', async () => {
    setState({ push: false })

    const result = await push()

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('cannot push')
    expect(putCalls()).toHaveLength(0)
  })

  /**
   * Not every token shape reports `permissions` on a repository. Refusing to
   * publish because a diagnostic field was absent would block a release over
   * nothing.
   */
  it('warns but continues when push access cannot be confirmed either way', async () => {
    setState({ push: 'unknown', remote: null })

    const result = await push()

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Could not confirm push access')
    expect(putCalls()).toHaveLength(1)
  })

  it('writes nothing on a dry run', async () => {
    setState({ remote: null })

    const result = await push(['--dry-run'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('class Looptroop < Formula')
    expect(putCalls()).toHaveLength(0)
  })
})
