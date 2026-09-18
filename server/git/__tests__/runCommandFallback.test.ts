import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.hoisted(() => vi.fn())
const terminateProcessTreeMock = vi.hoisted(() => vi.fn())

vi.mock('../../lib/executablePath', () => ({
  resolveTrustedProgram: (program: string) => ({ path: program }),
}))

vi.mock('../../lib/processTree', () => ({
  terminateProcessTree: terminateProcessTreeMock,
}))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return {
    ...actual,
    spawn: spawnMock,
  }
})

function makeChild(): EventEmitter & {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: { end: () => void; on: (event: string, listener: () => void) => void }
  unref: () => void
} {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: () => void; on: (event: string, listener: () => void) => void }
    unref: () => void
  }
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: () => {}, on: () => {} }
  child.unref = vi.fn()
  return child
}

describe('runCommand timeout abandonment', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    spawnMock.mockReset()
    terminateProcessTreeMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports an unknown signal when close never confirms the escalation', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const { runCommand } = await import('../runCommand')
    const resultPromise = runCommand('git', ['hang'], { timeoutMs: 10, log: false })
    await vi.advanceTimersByTimeAsync(4_100)
    const result = await resultPromise

    expect(result).toMatchObject({
      ok: false,
      status: null,
      signal: null,
      timedOut: true,
    })
    expect(terminateProcessTreeMock).toHaveBeenNthCalledWith(1, child, 'SIGTERM')
    expect(terminateProcessTreeMock).toHaveBeenNthCalledWith(2, child, 'SIGKILL')
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it('does not treat a live-child error as a close confirmation', async () => {
    const child = makeChild()
    spawnMock.mockReturnValue(child)

    const { runCommand } = await import('../runCommand')
    const resultPromise = runCommand('git', ['error'], { timeoutMs: 1_000, log: false })
    child.emit('error', new Error('signal failed'))

    let settled = false
    void resultPromise.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    child.emit('close', 2, null)
    const result = await resultPromise
    expect(result.ok).toBe(false)
    expect(result.errorDetail).toBe('signal failed')
  })

  it('confirms a Windows timeout only after taskkill succeeds and the child closes', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const child = makeChild()
      const taskkill = new EventEmitter()
      spawnMock.mockReturnValue(child)
      terminateProcessTreeMock.mockReturnValue(taskkill)

      const { runCommand, stopActiveCommands } = await import('../runCommand')
      const resultPromise = runCommand('git', ['windows-timeout'], { timeoutMs: 10, log: false })
      await vi.advanceTimersByTimeAsync(10)
      child.emit('close', null, 'SIGTERM')
      taskkill.emit('close', 0)
      await vi.advanceTimersByTimeAsync(4_100)

      const result = await resultPromise
      expect(result.timedOut).toBe(true)
      expect(result.ok).toBe(false)
      expect(terminateProcessTreeMock).toHaveBeenCalledWith(child, 'SIGTERM')
      await expect(stopActiveCommands()).resolves.toBeUndefined()
      expect(terminateProcessTreeMock).toHaveBeenCalledTimes(1)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
