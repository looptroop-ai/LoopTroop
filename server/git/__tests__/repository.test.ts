import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnFromSyncResult } from '../../test/childProcess'

const spawnSyncMock = vi.fn()
// Async commands run through `spawn`; both stubs answer from one description.
const spawnMock = vi.fn((...args: unknown[]) => spawnFromSyncResult(
  spawnSyncMock(...args) as ReturnType<typeof import('node:child_process').spawnSync>,
))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawnSync: spawnSyncMock,
    spawn: spawnMock,
  }
})

function makeSpawnResult(overrides: {
  status?: number
  stdout?: string
  stderr?: string
  error?: Error
} = {}): ReturnType<typeof import('node:child_process').spawnSync> {
  return {
    status: overrides.status ?? 0,
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    error: overrides.error,
    pid: 123,
    output: [null, overrides.stdout ?? '', overrides.stderr ?? ''],
    signal: null,
  } as ReturnType<typeof import('node:child_process').spawnSync>
}

describe('server/git/repository', () => {
  beforeEach(() => {
    vi.resetModules()
    spawnSyncMock.mockReset()
    spawnMock.mockClear()
  })

  it('prefers origin/<baseBranch> when resolving a ticket base ref', async () => {
    spawnSyncMock.mockReturnValue(makeSpawnResult())

    const { resolveBaseBranchRef } = await import('../repository')
    const ref = resolveBaseBranchRef('/repo', 'main')

    expect(ref).toBe('origin/main')
    expect(spawnSyncMock).toHaveBeenCalledTimes(1)
    expect(spawnSyncMock.mock.calls[0]?.[1]).toEqual([
      '-C',
      '/repo',
      'show-ref',
      '--verify',
      '--quiet',
      'refs/remotes/origin/main',
    ])
  })

  it('falls back to a local base branch when the origin ref is unavailable', async () => {
    spawnSyncMock
      .mockReturnValueOnce(makeSpawnResult({ status: 1 }))
      .mockReturnValueOnce(makeSpawnResult())

    const { resolveBaseBranchRef } = await import('../repository')
    const ref = resolveBaseBranchRef('/repo', 'main')

    expect(ref).toBe('main')
    expect(spawnSyncMock.mock.calls[1]?.[1]).toEqual([
      '-C',
      '/repo',
      'show-ref',
      '--verify',
      '--quiet',
      'refs/heads/main',
    ])
  })
})
