import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimTapDirectory, isOwnedTap } from '../scripts/brew-local-tap.ts'
import { withoutCredentials } from '../scripts/container-docker.ts'
import { removeWorkDirectory, waitForHealth } from '../scripts/smoke-lib.mjs'
import { removeTempDir } from '../server/test/tempDir'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) removeTempDir(dir)
})

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-tap-test-'))
  scratch.push(dir)
  return dir
}

/**
 * The throwaway tap is built by deleting the directory it is about to occupy,
 * and torn down by deleting it again. Both are right for a tap this script
 * created and destructive for anything else — a developer who happens to have
 * tapped a repository under the same name lost it, with nothing asked and
 * nothing said.
 */
describe('throwaway Homebrew tap', () => {
  it('creates a marked, empty tap where there was nothing', () => {
    const directory = join(freshDir(), 'homebrew-looptroop')

    claimTapDirectory(directory)

    expect(existsSync(join(directory, 'Formula'))).toBe(true)
    expect(isOwnedTap(directory)).toBe(true)
  })

  it('replaces a tap an earlier run of this script left behind', () => {
    const directory = join(freshDir(), 'homebrew-looptroop')
    claimTapDirectory(directory)
    writeFileSync(join(directory, 'Formula', 'looptroop.rb'), 'stale')

    claimTapDirectory(directory)

    expect(existsSync(join(directory, 'Formula', 'looptroop.rb'))).toBe(false)
    expect(isOwnedTap(directory)).toBe(true)
  })

  it('refuses a tap it did not create, and does not touch it', () => {
    const directory = join(freshDir(), 'homebrew-looptroop')
    mkdirSync(join(directory, 'Formula'), { recursive: true })
    writeFileSync(join(directory, 'Formula', 'somebody-elses.rb'), 'a real formula')

    expect(() => claimTapDirectory(directory)).toThrow(/was not created by this script/)
    expect(readFileSync(join(directory, 'Formula', 'somebody-elses.rb'), 'utf8')).toBe('a real formula')
  })

  it('says a directory that does not exist is not one of ours', () => {
    expect(isOwnedTap(join(freshDir(), 'nothing-here'))).toBe(false)
  })
})

/**
 * The anonymous container check asks whether a client with no credentials can
 * pull the release. It used to establish that with `docker logout`, whose
 * result it ignored — so a logout that failed left the check authenticated,
 * which is exactly the state that makes a private repository pass.
 */
describe('anonymous Docker configuration', () => {
  it('removes credentials stored directly', () => {
    const stripped = JSON.parse(withoutCredentials(JSON.stringify({
      auths: { 'https://index.docker.io/v1/': { auth: 'c2VjcmV0' } },
    })))

    expect(stripped.auths).toBeUndefined()
  })

  /**
   * The half that removing `auths` alone would miss: these name external
   * programs that hand credentials back on demand, so a config with no `auths`
   * at all can still authenticate.
   */
  it('removes the credential helpers as well', () => {
    const stripped = JSON.parse(withoutCredentials(JSON.stringify({
      credsStore: 'desktop',
      credHelpers: { 'ghcr.io': 'gh' },
    })))

    expect(stripped.credsStore).toBeUndefined()
    expect(stripped.credHelpers).toBeUndefined()
  })

  /**
   * Everything else is kept. An empty config would lose the buildx builder
   * configuration and fail the check for a reason that has nothing to do with
   * whether the image is public.
   */
  it('keeps everything that is not a credential', () => {
    const stripped = JSON.parse(withoutCredentials(JSON.stringify({
      auths: { 'ghcr.io': { auth: 'c2VjcmV0' } },
      currentContext: 'default',
      aliases: { builder: 'buildx' },
    })))

    expect(stripped.currentContext).toBe('default')
    expect(stripped.aliases).toEqual({ builder: 'buildx' })
  })

  it('reduces an unreadable config to an empty one rather than passing it through', () => {
    expect(JSON.parse(withoutCredentials('not json at all'))).toEqual({})
  })
})

/**
 * Three smoke scripts had their own `waitForHealth` and four had their own
 * retry-and-never-throw removal. Sharing them is only safe if the shared one
 * keeps every property each copy relied on, so those are what is asserted here
 * rather than that the function exists.
 */
describe('shared smoke helpers', () => {
  it('returns the health payload as soon as the daemon answers', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', instanceId: 'abc' }))
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const { port } = server.address() as AddressInfo

    try {
      expect(await waitForHealth(`http://127.0.0.1:${port}`, 5_000))
        .toEqual({ status: 'ok', instanceId: 'abc' })
    } finally {
      await new Promise<void>((done) => server.close(() => done()))
    }
  })

  it('gives up and returns null rather than throwing when nothing is listening', async () => {
    // Port 1 needs privileges to bind and nothing holds it, so the connection
    // is refused immediately and this exercises the catch on every attempt.
    const started = Date.now()

    expect(await waitForHealth('http://127.0.0.1:1', 400)).toBeNull()
    // Bounded by the timeout it was given, not by a default of its own.
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('removes a directory and says nothing went wrong', () => {
    const directory = freshDir()
    writeFileSync(join(directory, 'inside'), 'x')

    expect(removeWorkDirectory(directory)).toBeNull()
    expect(existsSync(directory)).toBe(false)
  })

  it('treats a directory that is already gone as removed', () => {
    // `force` swallows ENOENT, and every caller runs this from a `finally` that
    // may have been reached before the directory was ever created.
    expect(removeWorkDirectory(join(tmpdir(), 'looptroop-never-existed-9f2c1a'))).toBeNull()
  })

  /**
   * The contract every caller depends on: this runs from a `finally` in each of
   * them, so a throw here would replace whatever failure the script was already
   * reporting with a complaint about a temporary directory.
   *
   * Provoked with a NUL byte, which `rmSync` rejects outright. A path under a
   * file or a path that does not exist will not do it — `force` treats both as
   * already gone, which is the behaviour the two tests above pin down.
   */
  it('returns what stopped it rather than throwing', () => {
    const failure = removeWorkDirectory(join(tmpdir(), 'looptroop\u0000invalid'))

    expect(failure).toBeInstanceOf(Error)
  })
})
