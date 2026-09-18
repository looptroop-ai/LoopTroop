import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { killProcessTree, signalTermination } from '../server/cli/processControl'
import * as processIdentity from '../server/lib/processIdentity'

describe('process-control identity guards', () => {
  let processKill: ReturnType<typeof vi.spyOn>
  const children: ChildProcess[] = []

  beforeEach(() => {
    processKill = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid === -4242 && signal === 'SIGKILL') throw new Error('group disappeared')
      return undefined as never
    }) as typeof process.kill)
  })

  afterEach(() => {
    processKill.mockRestore()
    for (const child of children.splice(0)) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    vi.restoreAllMocks()
  })

  function target(): { pid: number; token: string } {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    children.push(child)
    const token = processIdentity.readProcessStartToken(child.pid ?? 0)
    expect(token).not.toBeNull()
    return { pid: child.pid ?? 0, token: token ?? '' }
  }

  it('refuses every destructive operation without an expected token', async () => {
    expect(signalTermination(4242, null)).toBe(false)
    await killProcessTree(4242, null)

    expect(processKill).not.toHaveBeenCalled()
  })

  it('refuses a live pid whose token is different or unavailable', async () => {
    const { pid } = target()
    const match = vi.spyOn(processIdentity, 'matchProcess').mockReturnValue({ kind: 'different' })

    expect(signalTermination(pid, 'original-start')).toBe(false)
    await killProcessTree(pid, 'original-start')

    const calls = processKill.mock.calls as Array<[number, NodeJS.Signals | number | undefined]>
    expect(calls.some(([, signal]) => signal !== 0)).toBe(false)
    expect(match).toHaveBeenCalled()
  })

  it.runIf(process.platform !== 'win32')('rechecks identity before direct fallback after a failed group kill', async () => {
    // The first match authorises the group attempt. The second says that the
    // pid was recycled while the group operation failed; direct SIGKILL must
    // not be sent to that replacement.
    const { pid, token } = target()
    const match = vi.spyOn(processIdentity, 'matchProcess')
      .mockReturnValueOnce({ kind: 'same' })
      .mockReturnValueOnce({ kind: 'different' })
    processKill.mockImplementation(((killPid: number, signal?: NodeJS.Signals | number) => {
      if (killPid === -pid && signal === 'SIGKILL') throw new Error('group disappeared')
      return undefined as never
    }) as typeof process.kill)

    await killProcessTree(pid, token)

    expect(processKill).toHaveBeenCalledWith(-pid, 'SIGKILL')
    expect(processKill).not.toHaveBeenCalledWith(pid, 'SIGKILL')
    expect(match).toHaveBeenCalledTimes(2)
  })

  it.runIf(process.platform !== 'win32')('uses the direct fallback only while the identity still matches', async () => {
    const { pid, token } = target()

    processKill.mockImplementation(((killPid: number, signal?: NodeJS.Signals | number) => {
      if (killPid === -pid && signal === 'SIGKILL') throw new Error('group disappeared')
      return undefined as never
    }) as typeof process.kill)

    await killProcessTree(pid, token)

    expect(processKill).toHaveBeenCalledWith(-pid, 'SIGKILL')
    expect(processKill).toHaveBeenCalledWith(pid, 'SIGKILL')
  })
})
