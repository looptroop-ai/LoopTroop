import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_VERSION } from '../../lib/appVersion'

const mocks = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
  startCommand: vi.fn(async () => 0),
  statusCommand: vi.fn(async () => 0),
  openCommand: vi.fn(async () => 0),
  doctorCommand: vi.fn(async () => 0),
}))

vi.mock('../../lib/updateCheck', () => ({
  getUpdateStatus: mocks.getUpdateStatus,
  formatUpdateStatusNotice: (status: { updateAvailable: boolean }) => status.updateAvailable ? '\nUPDATE AVAILABLE\n' : '',
}))

vi.mock('../commands', () => ({
  startCommand: mocks.startCommand,
  statusCommand: mocks.statusCommand,
  openCommand: mocks.openCommand,
}))

vi.mock('../doctorCommand', () => ({ doctorCommand: mocks.doctorCommand }))

import { main } from '../cli'

const update = {
  currentVersion: APP_VERSION,
  latestVersion: '0.6.0',
  updateAvailable: true,
  checkedAt: '2026-08-16T08:00:00.000Z',
  installChannel: 'npm' as const,
  upgradeCommand: 'npm install -g looptroop@latest',
  postUpgradeCommand: 'looptroop restart',
  release: null,
}

describe('CLI update surfaces', () => {
  let stdout = ''

  beforeEach(() => {
    stdout = ''
    vi.clearAllMocks()
    mocks.getUpdateStatus.mockResolvedValue(update)
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString()
      return true
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it.each([
    ['--version'],
    ['start'],
    ['open'],
  ])('checks and displays an available update for looptroop %s', async (argument) => {
    await main([argument])

    expect(mocks.getUpdateStatus).toHaveBeenCalledWith({ currentVersion: APP_VERSION })
    expect(stdout).toContain('UPDATE AVAILABLE')
  })

  it('passes update facts into status and preserves JSON-only output', async () => {
    await main(['status', '--json'])

    expect(mocks.statusCommand).toHaveBeenCalledWith(true, update)
    expect(stdout).not.toContain('UPDATE AVAILABLE')
  })

  it('displays the update after human-readable status output', async () => {
    await main(['status'])

    expect(mocks.statusCommand).toHaveBeenCalledWith(false, update)
    expect(stdout).toContain('UPDATE AVAILABLE')
  })

  it('displays the update before a foreground start takes over the terminal', async () => {
    await main(['start', '--foreground'])

    expect(mocks.startCommand).toHaveBeenCalledWith({ foreground: true })
    expect(stdout).toContain('UPDATE AVAILABLE')
  })

  it('passes current and latest versions into doctor for human and JSON output', async () => {
    await main(['doctor'])

    expect(mocks.doctorCommand).toHaveBeenCalledWith(false, update)
  })
})
