import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORCE_KILL_DELAY_MS } from '../constants'

const tokenForPid = vi.hoisted(() => new Map<number, string>())
const readProcessStartTokenMock = vi.hoisted(() => vi.fn((pid: number) => tokenForPid.get(pid) ?? null))
const readFileSyncMock = vi.hoisted(() => vi.fn((path: string) => {
  const match = /^\/proc\/(\d+)\/stat$/.exec(path)
  if (match === null) return null
  if (match[1] === '4242' && !tokenForPid.has(4242)) return null
  return `${match[1]} (node) S 1 4242`
}))
const readdirSyncMock = vi.hoisted(() => vi.fn(() => ['4242', '5252']))

describe.runIf(process.platform === 'linux')('terminateProcessTreeWithEscalation', () => {
  let processKill: ReturnType<typeof vi.spyOn>
  let terminateProcessTree: typeof import('../processTree').terminateProcessTree
  let terminateProcessTreeWithEscalation: typeof import('../processTree').terminateProcessTreeWithEscalation

  beforeEach(async () => {
    vi.useFakeTimers()
    tokenForPid.clear()
    tokenForPid.set(4242, 'leader-start')
    tokenForPid.set(5252, 'descendant-start')
    readProcessStartTokenMock.mockClear()
    readFileSyncMock.mockClear()
    readdirSyncMock.mockClear()
    processKill = vi.spyOn(process, 'kill').mockImplementation(() => undefined as never)

    vi.doMock('../processIdentity', () => ({ readProcessStartToken: readProcessStartTokenMock }))
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return { ...actual, readFileSync: readFileSyncMock, readdirSync: readdirSyncMock }
    })
    vi.resetModules()
    ;({ terminateProcessTree, terminateProcessTreeWithEscalation } = await import('../processTree'))
  })

  afterEach(() => {
    processKill.mockRestore()
    vi.useRealTimers()
    vi.doUnmock('../processIdentity')
    vi.doUnmock('node:fs')
    vi.resetModules()
  })

  function child(): ChildProcess {
    return { pid: 4242 } as ChildProcess
  }

  function groupKillCalls(): number {
    return (processKill.mock.calls as Array<[number, NodeJS.Signals]>).filter(
      ([pid, signal]) => pid === -4242 && signal === 'SIGKILL',
    ).length
  }

  it('retains delayed group escalation when the leader closes first', async () => {
    terminateProcessTreeWithEscalation(child(), 'linux', 'leader-start')

    // The direct child is gone, but the captured descendant ignores TERM and
    // still proves that this is the original detached group.
    tokenForPid.delete(4242)
    await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS)

    expect(groupKillCalls()).toBe(1)
  })

  it('does not escalate a recycled leader pid', async () => {
    terminateProcessTreeWithEscalation(child(), 'linux', 'leader-start')

    tokenForPid.set(4242, 'different-process-start')
    await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS)

    expect(groupKillCalls()).toBe(0)
  })

  it('does not signal a pid already recycled before escalation starts', () => {
    tokenForPid.set(4242, 'different-process-start')

    terminateProcessTreeWithEscalation(child(), 'linux', 'leader-start')

    expect(processKill).not.toHaveBeenCalled()
  })

  it('does not reconstruct an old group after its leader is gone', async () => {
    tokenForPid.delete(4242)
    tokenForPid.set(5252, 'replacement-start')

    terminateProcessTreeWithEscalation(child(), 'linux', 'leader-start')
    await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS)

    expect(processKill).not.toHaveBeenCalled()
  })

  it('declines a group whose leader is recycled during the initial snapshot', () => {
    readProcessStartTokenMock
      .mockImplementationOnce(() => 'leader-start')
      .mockImplementationOnce(() => 'leader-start')
      .mockImplementationOnce(() => {
        tokenForPid.set(4242, 'replacement-start')
        return 'replacement-start'
      })

    terminateProcessTreeWithEscalation(child(), 'linux', 'leader-start')

    expect(processKill).not.toHaveBeenCalled()
  })

  it('rechecks identity before falling back after a group failure', () => {
    const directKill = vi.fn()
    processKill.mockImplementation(((pid: number, _signal: NodeJS.Signals) => {
      if (pid === -4242) {
        tokenForPid.set(4242, 'replacement-start')
        throw new Error('group disappeared')
      }
      return undefined as never
    }) as typeof process.kill)

    terminateProcessTree({ pid: 4242, kill: directKill } as unknown as ChildProcess, 'SIGTERM', 'linux', 'leader-start')

    expect(directKill).not.toHaveBeenCalled()
  })
})
