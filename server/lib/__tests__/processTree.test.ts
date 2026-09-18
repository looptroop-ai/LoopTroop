import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FORCE_KILL_DELAY_MS } from '../constants'

const tokenForPid = vi.hoisted(() => new Map<number, string>())
const leaderStatVisible = vi.hoisted(() => ({ value: false }))
const readProcessStartTokenMock = vi.hoisted(() => vi.fn((pid: number) => tokenForPid.get(pid) ?? null))
const readFileSyncMock = vi.hoisted(() => vi.fn((path: string) => {
  const match = /^\/proc\/(\d+)\/stat$/.exec(path)
  if (match === null) return null
  if (match[1] === '4242' && !tokenForPid.has(4242) && !leaderStatVisible.value) return null
  return `${match[1]} (node) S 1 4242`
}))
const readdirSyncMock = vi.hoisted(() => vi.fn(() => ['4242', '5252']))

describe.runIf(process.platform === 'linux')('terminateProcessTreeWithEscalation', () => {
  let processKill: ReturnType<typeof vi.spyOn>
  let captureProcessGroup: typeof import('../processTree').captureProcessGroup
  let refreshProcessGroup: typeof import('../processTree').refreshProcessGroup
  let terminateProcessTree: typeof import('../processTree').terminateProcessTree
  let terminateProcessTreeWithEscalation: typeof import('../processTree').terminateProcessTreeWithEscalation

  beforeEach(async () => {
    vi.useFakeTimers()
    tokenForPid.clear()
    tokenForPid.set(4242, 'leader-start')
    tokenForPid.set(5252, 'descendant-start')
    leaderStatVisible.value = false
    readProcessStartTokenMock.mockImplementation((pid: number) => tokenForPid.get(pid) ?? null)
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
    ;({ captureProcessGroup, refreshProcessGroup, terminateProcessTree, terminateProcessTreeWithEscalation } = await import('../processTree'))
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
    leaderStatVisible.value = false
    await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS)

    expect(groupKillCalls()).toBe(1)
  })

  it('retains descendants discovered after the initial group scan', () => {
    tokenForPid.delete(5252)
    const initial = captureProcessGroup(4242, 'linux', 'leader-start')
    expect(initial?.members.has(5252)).toBe(false)

    tokenForPid.set(6262, 'late-descendant-start')
    readdirSyncMock.mockReturnValue(['4242', '6262'])
    const refreshed = refreshProcessGroup(initial!)

    expect(refreshed.members.get(6262)).toBe('late-descendant-start')
  })

  it('rejects members scanned across a leader identity change', () => {
    const initial = captureProcessGroup(4242, 'linux', 'leader-start')
    let leaderReads = 0
    readProcessStartTokenMock.mockImplementation((pid: number) => {
      if (pid === 4242) {
        leaderReads += 1
        return leaderReads === 1 ? 'leader-start' : 'replacement-start'
      }
      return tokenForPid.get(pid) ?? null
    })
    tokenForPid.set(6262, 'late-descendant-start')
    readdirSyncMock.mockReturnValue(['4242', '6262'])

    const refreshed = refreshProcessGroup(initial!)

    expect(refreshed.members.has(6262)).toBe(false)
  })

  it('refreshes the shared escalation snapshot while the leader is still live', async () => {
    tokenForPid.delete(5252)
    readdirSyncMock.mockReturnValue(['4242'])
    terminateProcessTreeWithEscalation(child(), 'linux', 'leader-start')

    tokenForPid.set(5252, 'late-descendant-start')
    readdirSyncMock.mockReturnValue(['4242', '5252'])
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
    leaderStatVisible.value = false

    terminateProcessTreeWithEscalation(child(), 'linux', 'leader-start')
    await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS)

    expect(processKill).not.toHaveBeenCalled()
  })

  it('uses the owned child handle when a live leader probe is unavailable', () => {
    const snapshot = captureProcessGroup(4242, 'linux', 'leader-start')
    const directKill = vi.fn()
    const ownedChild = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: directKill,
    } as unknown as ChildProcess
    tokenForPid.delete(4242)
    tokenForPid.delete(5252)

    terminateProcessTreeWithEscalation(ownedChild, 'linux', 'leader-start', snapshot)

    expect(directKill).toHaveBeenCalledWith('SIGTERM')
    expect(processKill).not.toHaveBeenCalled()
  })

  it('uses the owned child handle for delayed escalation when identity is unavailable', async () => {
    const directKill = vi.fn()
    const ownedChild = {
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill: directKill,
    } as unknown as ChildProcess

    terminateProcessTreeWithEscalation(ownedChild, 'linux', 'leader-start')
    tokenForPid.delete(4242)
    // The leader still has a readable /proc stat, so a numeric group kill is
    // not safe to infer from the transiently unavailable identity token.
    leaderStatVisible.value = true
    await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS)

    expect(directKill).toHaveBeenCalledWith('SIGKILL')
    expect(groupKillCalls()).toBe(0)
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

  it('uses the owned child handle when no start token is available', async () => {
    const directKill = vi.fn()
    const ownedChild = {
      pid: 4242,
      exitCode: null,
      kill: directKill,
    } as unknown as ChildProcess

    terminateProcessTreeWithEscalation(ownedChild, 'linux', null)
    expect(directKill).toHaveBeenCalledWith('SIGTERM')
    expect(processKill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(FORCE_KILL_DELAY_MS)
    expect(directKill).toHaveBeenCalledWith('SIGKILL')
  })
})
