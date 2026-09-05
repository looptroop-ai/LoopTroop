import {
  RECOVERY_RELOAD_COOLDOWN_MS,
  RECOVERY_RELOAD_DELAY_MS,
} from '@/lib/constants'

const RECOVERY_RELOAD_STORAGE_KEY = 'looptroop-recovery-reload:last'

type ReloadStorage = Pick<Storage, 'getItem' | 'setItem'>

interface RecoveryReloadRecord {
  at: number
  source: string
}

interface RecoveryReloadOptions {
  storage?: ReloadStorage
  now?: () => number
  reload?: () => void
  setTimeout?: (handler: () => void, timeout: number) => unknown
}

function parseRecoveryReloadRecord(raw: string | null): RecoveryReloadRecord | null {
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<RecoveryReloadRecord>
    return typeof parsed.at === 'number' && Number.isFinite(parsed.at)
      ? { at: parsed.at, source: typeof parsed.source === 'string' ? parsed.source : 'unknown' }
      : null
  } catch {
    const legacyTimestamp = Number(raw)
    return Number.isFinite(legacyTimestamp)
      ? { at: legacyTimestamp, source: 'legacy' }
      : null
  }
}

export function requestRecoveryReload(
  source: string,
  options: RecoveryReloadOptions = {},
): boolean {
  if (typeof window === 'undefined' && (!options.reload || !options.setTimeout)) {
    return false
  }

  const now = options.now?.() ?? Date.now()
  const storage = options.storage ?? window.sessionStorage
  const reload = options.reload ?? (() => window.location.reload())
  const schedule = options.setTimeout ?? ((handler, timeout) => window.setTimeout(handler, timeout))

  try {
    const lastReload = parseRecoveryReloadRecord(storage.getItem(RECOVERY_RELOAD_STORAGE_KEY))
    if (lastReload && now - lastReload.at < RECOVERY_RELOAD_COOLDOWN_MS) {
      return false
    }

    storage.setItem(RECOVERY_RELOAD_STORAGE_KEY, JSON.stringify({ at: now, source }))
  } catch {
    // Storage failures should not prevent the user-facing recovery reload.
  }

  schedule(reload, RECOVERY_RELOAD_DELAY_MS)
  return true
}
