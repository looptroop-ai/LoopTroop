import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_ARGV } from '../daemonHandoff'

const mocks = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(() => Promise.resolve(null)),
  runDaemonProcess: vi.fn(() => Promise.resolve()),
  setupCommand: vi.fn(() => Promise.resolve(0)),
  startCommand: vi.fn(() => Promise.resolve(0)),
  stopCommand: vi.fn(() => Promise.resolve(0)),
  restartCommand: vi.fn(() => Promise.resolve(0)),
  statusCommand: vi.fn((_json: boolean, _update?: Promise<unknown>) => Promise.resolve(0)),
  openCommand: vi.fn(() => Promise.resolve(0)),
  doctorCommand: vi.fn((_json: boolean, _update: Promise<unknown>) => Promise.resolve(0)),
  logsCommand: vi.fn(() => Promise.resolve(0)),
  cleanCommand: vi.fn(() => Promise.resolve(0)),
}))

vi.mock('../../lib/updateCheck', () => ({
  getUpdateStatus: mocks.getUpdateStatus,
  formatUpdateStatusNotice: () => '',
}))
vi.mock('../daemonProcess', () => ({ runDaemonProcess: mocks.runDaemonProcess }))
vi.mock('../setupCommand', () => ({ setupCommand: mocks.setupCommand }))
vi.mock('../commands', () => ({
  startCommand: mocks.startCommand,
  stopCommand: mocks.stopCommand,
  restartCommand: mocks.restartCommand,
  statusCommand: mocks.statusCommand,
  openCommand: mocks.openCommand,
}))
vi.mock('../doctorCommand', () => ({ doctorCommand: mocks.doctorCommand }))
vi.mock('../logsCommand', () => ({ logsCommand: mocks.logsCommand }))
vi.mock('../cleanCommand', () => ({ cleanCommand: mocks.cleanCommand }))

import { main } from '../cli'

describe('CLI command dispatch', () => {
  let stdout = ''
  let stderr = ''

  beforeEach(() => {
    stdout = ''
    stderr = ''
    vi.clearAllMocks()
    mocks.getUpdateStatus.mockResolvedValue(null)
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it('hands the daemon marker to the daemon runner before argument parsing', async () => {
    await expect(main([DAEMON_ARGV])).resolves.toBe(0)
    expect(mocks.runDaemonProcess).toHaveBeenCalledOnce()
    expect(stderr).toBe('')
  })

  it.each([
    { args: ['--version'], rejection: undefined, exitCode: 0, output: /\d+\.\d+\.\d+/, isEntryPoint: true, isSea: false },
    { args: [DAEMON_ARGV], rejection: 'daemon failed', exitCode: 1, output: /daemon failed/, isEntryPoint: true, isSea: false },
    { args: ['--version'], rejection: undefined, exitCode: 0, output: /\d+\.\d+\.\d+/, isEntryPoint: false, isSea: true },
  ])('sets the process exit code when the CLI is an entry point or SEA binary', async ({ args, rejection, exitCode, output, isEntryPoint, isSea }) => {
    const originalArgv = [...process.argv]
    const originalExitCode = process.exitCode
    process.argv.splice(0, process.argv.length, process.execPath, '/tmp/looptroop-cli-entrypoint.js', ...args)
    process.exitCode = undefined
    if (rejection) mocks.runDaemonProcess.mockRejectedValueOnce(new Error(rejection))
    vi.doMock('../entryPoint', () => ({ isEntryPoint: () => isEntryPoint }))
    vi.doMock('../../lib/isSea', () => ({ isSea: () => isSea }))

    try {
      vi.resetModules()
      await import('../cli')
      await vi.waitFor(() => expect(process.exitCode).toBe(exitCode))
      expect(`${stdout}${stderr}`).toMatch(output)
    } finally {
      process.argv.splice(0, process.argv.length, ...originalArgv)
      process.exitCode = originalExitCode
      vi.doUnmock('../entryPoint')
      vi.doUnmock('../../lib/isSea')
      vi.resetModules()
    }
  })

  it('prints the overview when no command is supplied', async () => {
    expect(await main([])).toBe(0)
    expect(stdout).toContain('Usage: looptroop <command> [options]')
  })

  it('prints a parse error and the overview for invalid options', async () => {
    expect(await main(['--not-a-real-option'])).toBe(1)
    expect(stderr).toContain("Unknown option '--not-a-real-option'")
    expect(stderr).toContain('Usage: looptroop <command> [options]')
  })

  it.each(['abc', '0', '65536'])('rejects invalid port %s before dispatch', async (port) => {
    expect(await main(['start', `--port=${port}`])).toBe(1)
    expect(stderr).toContain(`Invalid --port "${port}".`)
    expect(mocks.startCommand).not.toHaveBeenCalled()
  })

  it('dispatches setup with and without accepting defaults', async () => {
    await main(['setup'])
    await main(['setup', '--yes'])
    await main(['setup', '-y'])

    expect(mocks.setupCommand.mock.calls).toEqual([[{}], [{ yes: true }], [{ yes: true }]])
  })

  it('dispatches start with its port, foreground, and OpenCode log options', async () => {
    await main(['start', '--port=4312', '--foreground', '--opencode-logs=all'])

    expect(mocks.startCommand).toHaveBeenCalledWith({ port: 4312, foreground: true, opencodeLogs: 'all' })
  })

  it('dispatches stop and restart, preserving an optional restart port', async () => {
    await main(['stop'])
    await main(['restart'])
    await main(['restart', '--port=4312'])

    expect(mocks.stopCommand).toHaveBeenCalledOnce()
    expect(mocks.restartCommand.mock.calls).toEqual([[{}], [{ port: 4312 }]])
  })

  it('passes JSON, print-url, and doctor flags to their handlers', async () => {
    await main(['status', '--json'])
    await main(['open', '--print-url'])
    await main(['doctor', '--json'])

    expect(mocks.statusCommand.mock.calls[0]?.[0]).toBe(true)
    expect(mocks.openCommand).toHaveBeenCalledWith({ printUrl: true })
    expect(mocks.doctorCommand.mock.calls[0]?.[0]).toBe(true)
    expect(mocks.doctorCommand.mock.calls[0]?.[1]).toBeInstanceOf(Promise)
  })

  it('dispatches logs with default and explicit follow and line options', async () => {
    await main(['logs'])
    await main(['logs', '--follow', '--lines=12'])
    await main(['logs', '-f', '--lines=3'])

    expect(mocks.logsCommand.mock.calls).toEqual([
      [{ follow: false }],
      [{ follow: true, lines: 12 }],
      [{ follow: true, lines: 3 }],
    ])
  })

  it('dispatches clean as a dry run by default and applies only when requested', async () => {
    await main(['clean'])
    await main(['clean', '--apply'])

    expect(mocks.cleanCommand.mock.calls).toEqual([[{ apply: false }], [{ apply: true }]])
  })

  it('reports unknown commands without running a command handler', async () => {
    expect(await main(['not-a-command'])).toBe(1)
    expect(stderr).toContain('Unknown command "not-a-command".')
    expect(stdout).toBe('')
    expect(mocks.setupCommand).not.toHaveBeenCalled()
    expect(mocks.startCommand).not.toHaveBeenCalled()
  })
})
