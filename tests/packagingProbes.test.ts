import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimTapDirectory, isOwnedTap } from '../scripts/brew-local-tap.ts'
import { withoutCredentials } from '../scripts/container-docker.ts'
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
