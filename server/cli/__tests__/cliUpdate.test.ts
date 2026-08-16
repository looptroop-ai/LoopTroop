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
  let stderr = ''

  beforeEach(() => {
    stdout = ''
    stderr = ''
    vi.clearAllMocks()
    mocks.getUpdateStatus.mockResolvedValue(update)
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

  it.each([
    ['--version'],
    ['start'],
    ['open'],
  ])('checks and reports an available update for looptroop %s', async (argument) => {
    await main([argument])

    expect(mocks.getUpdateStatus).toHaveBeenCalledWith({ currentVersion: APP_VERSION })
    expect(stderr).toContain('UPDATE AVAILABLE')
  })

  /**
   * The installer verifies an install by comparing `looptroop --version` on
   * stdout to the version it meant to install (`scripts/installer-core.mjs`),
   * and six release smokes do the same. A notice on stdout turns a healthy
   * install into a reported failure, so the assertion is exact equality rather
   * than "contains the version".
   */
  it('prints nothing but the version on stdout, even when an update exists', async () => {
    await main(['--version'])

    expect(stdout).toBe(`${APP_VERSION}\n`)
    expect(stderr).toContain('UPDATE AVAILABLE')
  })

  it('passes update facts into status and preserves JSON-only output', async () => {
    await main(['status', '--json'])

    expect(mocks.statusCommand).toHaveBeenCalledWith(true, update)
    expect(stdout).not.toContain('UPDATE AVAILABLE')
    expect(stderr).toBe('')
  })

  /**
   * The lookup is left pending until the status itself has run. If `main` ever
   * awaits it first, nothing resolves it and this test times out — which is the
   * point: a slow or unreachable GitHub must not delay the answer that was
   * asked for.
   */
  it('does not wait on the release lookup before printing human-readable status', async () => {
    let statusRan = false
    let resolveUpdate: (value: typeof update) => void = () => undefined
    mocks.getUpdateStatus.mockReturnValue(new Promise<typeof update>((resolve) => { resolveUpdate = resolve }))
    mocks.statusCommand.mockImplementation(async () => {
      statusRan = true
      resolveUpdate(update)
      return 0
    })

    await main(['status'])

    expect(statusRan).toBe(true)
    // One argument: the status itself is never handed the update.
    expect(mocks.statusCommand).toHaveBeenCalledWith(false)
    expect(stderr).toContain('UPDATE AVAILABLE')
  })

  it('reports the update before a foreground start takes over the terminal', async () => {
    await main(['start', '--foreground'])

    expect(mocks.startCommand).toHaveBeenCalledWith({ foreground: true })
    expect(stderr).toContain('UPDATE AVAILABLE')
  })

  /**
   * The lookup is started before the command it decorates, so a rejection would
   * arrive as an unhandled rejection — which Node treats as a crash. A failed
   * release check must cost the notice, never the command.
   */
  it.each([
    ['--version'],
    ['status'],
    ['open'],
    ['doctor'],
  ])('still runs looptroop %s when the release lookup throws', async (argument) => {
    mocks.getUpdateStatus.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.github.com'))

    await expect(main([argument])).resolves.toBe(0)
    expect(stderr).toBe('')
  })

  it('hands doctor the lookup unawaited so it overlaps the local checks', async () => {
    await main(['doctor'])

    const [json, passed] = mocks.doctorCommand.mock.calls[0] as unknown as [boolean, Promise<unknown>]
    expect(json).toBe(false)
    expect(passed).toBeInstanceOf(Promise)
    await expect(passed).resolves.toEqual(update)
  })
})
