import { describe, it, expect } from 'vitest'
import { classifyChocoPush, compareVersions, decideChannelWrite, writes } from '../scripts/channel-state.ts'
import type { ParsedDescriptor } from '../scripts/package-manifests.ts'

const SHA = 'a'.repeat(64)
const OTHER_SHA = 'b'.repeat(64)
const URL = 'https://example.invalid/looptroop-9.9.9-bundle.tar.gz'

const desired = { version: '9.9.9', url: URL, sha256: SHA }

function published(overrides: Partial<ParsedDescriptor> = {}): ParsedDescriptor {
  return { version: '9.9.9', url: URL, sha256: SHA, ...overrides }
}

describe('deciding whether to write to a package channel', () => {
  it('publishes when the channel is empty', () => {
    expect(decideChannelWrite(desired, null).action).toBe('publish')
  })

  it('updates an older published version', () => {
    const decision = decideChannelWrite(desired, published({ version: '9.9.8' }))

    expect(decision).toMatchObject({ action: 'update', from: '9.9.8' })
  })

  it('updates over a prerelease of the same version', () => {
    expect(decideChannelWrite(desired, published({ version: '9.9.9-rc.1' })).action).toBe('update')
  })

  it('does nothing when this exact version already points at these exact bytes', () => {
    expect(decideChannelWrite(desired, published()).action).toBe('noop')
  })

  /**
   * The channel is a repository anyone with write access can push to, and a
   * release that ran twice out of order would otherwise quietly downgrade
   * everybody who installs from it.
   */
  it('refuses to publish over a newer version', () => {
    const decision = decideChannelWrite(desired, published({ version: '10.0.0' }))

    expect(decision.action).toBe('refuse')
    expect(decision.reason).toContain('downgrade')
  })

  it('refuses even when the newer version is only a patch ahead', () => {
    expect(decideChannelWrite(desired, published({ version: '9.9.10' })).action).toBe('refuse')
  })

  it('treats the same version with a different hash as a conflict', () => {
    const decision = decideChannelWrite(desired, published({ sha256: OTHER_SHA }))

    expect(decision.action).toBe('conflict')
    expect(decision).toMatchObject({ differences: [expect.stringContaining('sha256')] })
  })

  it('treats the same version pointing at a different URL as a conflict', () => {
    const decision = decideChannelWrite(desired, published({ url: 'https://elsewhere.invalid/x.tar.gz' }))

    expect(decision).toMatchObject({ action: 'conflict', differences: [expect.stringContaining('url')] })
  })

  it('reports every differing field at once rather than the first', () => {
    const decision = decideChannelWrite(desired, published({ url: 'https://elsewhere.invalid/x.tar.gz', sha256: OTHER_SHA }))

    expect(decision).toMatchObject({ action: 'conflict', differences: [expect.anything(), expect.anything()] })
  })

  /**
   * A one-character typo in a published formula is otherwise unfixable without
   * shipping a new version, which is the opposite of what a repair is for.
   */
  it('lets an operator force a replacement of the same version', () => {
    const decision = decideChannelWrite(desired, published({ sha256: OTHER_SHA }), { force: true })

    expect(decision).toMatchObject({ action: 'update', from: '9.9.9' })
    expect(decision.reason).toContain('forced')
  })

  it('does not let a force downgrade the channel', () => {
    expect(decideChannelWrite(desired, published({ version: '10.0.0' }), { force: true }).action).toBe('refuse')
  })

  it('stops on a published file it cannot read a version out of', () => {
    const decision = decideChannelWrite(desired, { version: null, url: null, sha256: null })

    expect(decision.action).toBe('conflict')
    expect(decision.reason).toContain('could not be read')
  })

  it.each([
    ['publish', null],
    ['update', published({ version: '9.9.8' })],
  ] as const)('reports %s as a write', (_action, remote) => {
    expect(writes(decideChannelWrite(desired, remote))).toBe(true)
  })

  it.each([
    ['noop', published()],
    ['refuse', published({ version: '10.0.0' })],
    ['conflict', published({ sha256: OTHER_SHA })],
  ] as const)('reports %s as not a write', (_action, remote) => {
    expect(writes(decideChannelWrite(desired, remote))).toBe(false)
  })
})

describe('version ordering', () => {
  it.each([
    ['9.9.9', '9.9.8', 1],
    ['9.9.8', '9.9.9', -1],
    ['9.9.9', '9.9.9', 0],
    ['9.10.0', '9.9.9', 1],
    ['10.0.0', '9.9.9', 1],
    ['9.9.9', '9.9.9-rc.1', 1],
    ['9.9.9-rc.1', '9.9.9', -1],
    ['9.9.9-rc.2', '9.9.9-rc.1', 1],
    ['9.9.9-rc.10', '9.9.9-rc.2', 1],
    ['9.9.9-alpha', '9.9.9-beta', -1],
  ])('sorts %s against %s as %i', (left, right, expected) => {
    expect(compareVersions(left, right)).toBe(expected)
  })
})

/**
 * The community feed moderates every package and the queue has no deadline, so
 * "accepted for review" has to be a success — otherwise every future release
 * waits behind a human at Chocolatey.
 */
describe('what choco push did', () => {
  it('treats an accepted package as submitted, not published', () => {
    expect(classifyChocoPush(0, 'looptroop 9.9.9 was pushed successfully')).toEqual({ state: 'submitted' })
  })

  /** The ordinary result of re-running a release that failed after this step. */
  it.each([
    "Failed to process request. 'A package with ID 'looptroop' and version '9.9.9' already exists",
    'The package looptroop version 9.9.9 already exists on the feed.',
  ])('treats an already-published version as done: %s', (output) => {
    expect(classifyChocoPush(1, output)).toEqual({ state: 'already-published' })
  })

  it('names a rejected API key rather than reporting an exit code', () => {
    const outcome = classifyChocoPush(1, 'Failed to process request. The remote server returned an error: (403) Forbidden.')

    expect(outcome).toMatchObject({ state: 'failed' })
    expect(outcome).toMatchObject({ reason: expect.stringContaining('API key') })
  })

  it('fails on anything else', () => {
    expect(classifyChocoPush(1, 'nuspec validation error').state).toBe('failed')
  })
})
