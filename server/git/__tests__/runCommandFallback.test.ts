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
})
