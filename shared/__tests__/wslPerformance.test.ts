import { describe, expect, it } from 'vitest'
import {
  buildWslAppMountedDriveWarning,
  buildWslProjectMountedDriveWarning,
  isWslWindowsMountPath,
  resolveWatchPollingDecision,
} from '../wslPerformance'

describe('isWslWindowsMountPath', () => {
  it('detects Windows-mounted drive paths', () => {
    expect(isWslWindowsMountPath('/mnt/c/Users/dev/LoopTroop')).toBe(true)
    expect(isWslWindowsMountPath('/mnt/d')).toBe(true)
    expect(isWslWindowsMountPath('C:\\Users\\dev\\LoopTroop')).toBe(true)
  })

  it('treats Linux filesystem paths as non-mounted', () => {
    expect(isWslWindowsMountPath('/home/dev/LoopTroop')).toBe(false)
    expect(isWslWindowsMountPath('/root/LoopTroop')).toBe(false)
    expect(isWslWindowsMountPath('')).toBe(false)
  })
})

describe('resolveWatchPollingDecision', () => {
  it('uses native watching on a native Linux/VPS workspace', () => {
    const decision = resolveWatchPollingDecision({
      isWsl: false,
      workspacePath: '/root/LoopTroop',
    })
    expect(decision.usePolling).toBe(false)
    expect(decision.reason).toMatch(/native file watching/i)
  })

  it('uses native watching on macOS and native Windows', () => {
    expect(
      resolveWatchPollingDecision({ isWsl: false, workspacePath: '/Users/dev/LoopTroop' }).usePolling,
    ).toBe(false)
    expect(
      resolveWatchPollingDecision({ isWsl: false, workspacePath: 'C:\\Users\\dev\\LoopTroop' }).usePolling,
    ).toBe(false)
  })

  it('uses native watching under WSL when the workspace is on the Linux filesystem', () => {
    const decision = resolveWatchPollingDecision({
      isWsl: true,
      workspacePath: '/home/dev/LoopTroop',
    })
    expect(decision.usePolling).toBe(false)
  })

  it('enables polling only under WSL on a Windows-mounted drive', () => {
    const decision = resolveWatchPollingDecision({
      isWsl: true,
      workspacePath: '/mnt/c/Users/dev/LoopTroop',
    })
    expect(decision.usePolling).toBe(true)
    expect(decision.reason).toMatch(/mounted-drive/i)
  })

  it('does not enable mounted-drive polling when not running under WSL', () => {
    // A /mnt/... path outside WSL (e.g. a Linux mount point) should not force polling.
    const decision = resolveWatchPollingDecision({
      isWsl: false,
      workspacePath: '/mnt/data/LoopTroop',
    })
    expect(decision.usePolling).toBe(false)
  })

  it('honors an explicit CHOKIDAR_USEPOLLING=1 override everywhere', () => {
    const decision = resolveWatchPollingDecision({
      explicitPolling: '1',
      isWsl: false,
      workspacePath: '/root/LoopTroop',
    })
    expect(decision.usePolling).toBe(true)
    expect(decision.reason).toMatch(/CHOKIDAR_USEPOLLING=1/)
  })

  it('honors an explicit disable override even on a mounted drive', () => {
    const decision = resolveWatchPollingDecision({
      explicitPolling: '0',
      isWsl: true,
      workspacePath: '/mnt/c/Users/dev/LoopTroop',
    })
    expect(decision.usePolling).toBe(false)
    expect(decision.reason).toMatch(/disable override/i)
  })

  it('treats "false" as a disable override', () => {
    expect(
      resolveWatchPollingDecision({
        explicitPolling: 'false',
        isWsl: true,
        workspacePath: '/mnt/c/Users/dev/LoopTroop',
      }).usePolling,
    ).toBe(false)
  })

  it('ignores blank/whitespace overrides and falls back to auto-detection', () => {
    const decision = resolveWatchPollingDecision({
      explicitPolling: '   ',
      isWsl: true,
      workspacePath: '/mnt/c/Users/dev/LoopTroop',
    })
    expect(decision.usePolling).toBe(true)
  })
})

describe('mounted-drive warnings', () => {
  it('builds app and project warnings with the normalized path', () => {
    expect(buildWslAppMountedDriveWarning('/mnt/c/Users/dev/LoopTroop/')).toContain(
      '/mnt/c/Users/dev/LoopTroop',
    )
    expect(buildWslProjectMountedDriveWarning('/mnt/c/projects/app/')).toContain(
      '/mnt/c/projects/app',
    )
  })
})
