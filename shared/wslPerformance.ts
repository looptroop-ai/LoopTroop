function normalizeFilesystemPath(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/\/+$/, '')
}

export function isWslWindowsMountPath(input: string): boolean {
  const normalized = normalizeFilesystemPath(input)
  if (!normalized) return false
  if (/^[A-Za-z]:\//.test(normalized)) return true
  return /^\/mnt\/[A-Za-z](?:\/|$)/.test(normalized)
}

export function buildWslAppMountedDriveWarning(appPath: string): string {
  const normalizedPath = normalizeFilesystemPath(appPath)
  return `LoopTroop is running from ${normalizedPath} inside WSL. Keeping the app on a Windows-mounted drive can significantly degrade file watching, Git, and overall app performance. If you want to use WSL, move or install LoopTroop under /home or another Linux filesystem path.`
}

export function buildWslProjectMountedDriveWarning(projectPath: string): string {
  const normalizedPath = normalizeFilesystemPath(projectPath)
  return `This project folder resolves to ${normalizedPath} while LoopTroop is running in WSL. Windows-mounted drives can significantly degrade Git, scanning, and workflow performance. Prefer a copy under /home or another Linux filesystem path.`
}

export type WatchPollingDecision = {
  usePolling: boolean
  reason: string
}

/**
 * Decide whether the dev file watcher should use polling instead of native
 * OS file-system events. This is OS-agnostic: native watching is preferred
 * everywhere (Linux, macOS, native Windows, and WSL on the Linux filesystem),
 * and polling is only enabled when it is genuinely required — a WSL runtime
 * whose workspace lives on a Windows-mounted drive (e.g. /mnt/c/...).
 *
 * An explicit `CHOKIDAR_USEPOLLING` value always wins so users can override
 * the auto-detection in either direction.
 */
export function resolveWatchPollingDecision(options: {
  explicitPolling?: string | null
  isWsl: boolean
  workspacePath: string
}): WatchPollingDecision {
  const explicit = options.explicitPolling?.trim()

  if (explicit !== undefined && explicit !== '') {
    const enabled = explicit !== '0' && explicit.toLowerCase() !== 'false'
    return {
      usePolling: enabled,
      reason: enabled
        ? `Respecting CHOKIDAR_USEPOLLING=${explicit}.`
        : 'Respecting CHOKIDAR_USEPOLLING disable override; using native file watching.',
    }
  }

  if (options.isWsl && isWslWindowsMountPath(options.workspacePath)) {
    return {
      usePolling: true,
      reason: 'Mounted-drive WSL workspace detected; enabling polling file watching.',
    }
  }

  return {
    usePolling: false,
    reason: 'Using native file watching.',
  }
}
