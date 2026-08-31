import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

const LAZY_RELOAD_KEY_PREFIX = 'looptroop-lazy-reload:'

type ReloadStorage = Pick<Storage, 'getItem' | 'setItem'>
// React.lazy uses ComponentType<any> so required component props are preserved through inference.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LazyComponent = ComponentType<any>

// Intentionally not `@shared/typeGuards`'s `getErrorMessage`: callers regex-match the result,
// so a non-Error value has to come back as '' rather than as its `String(...)` form, which
// would otherwise let text like "Loading chunk 1 failed" inside an arbitrary object match.
function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return ''
}

export function isRecoverableLazyImportError(error: unknown): boolean {
  const message = getErrorMessage(error)
  return /Failed to fetch dynamically imported module/i.test(message)
    || /error loading dynamically imported module/i.test(message)
    || /Importing a module script failed/i.test(message)
    || /Loading chunk \d+ failed/i.test(message)
    || /ChunkLoadError/i.test(message)
}

export function requestLazyImportReload(
  label: string,
  storage: ReloadStorage,
  reload: () => void,
): boolean {
  const storageKey = `${LAZY_RELOAD_KEY_PREFIX}${label}`
  if (storage.getItem(storageKey) === 'pending') {
    return false
  }

  storage.setItem(storageKey, 'pending')
  reload()
  return true
}

function reloadOnceForLazyImport(label: string): boolean {
  if (typeof window === 'undefined') return false

  try {
    return requestLazyImportReload(label, window.sessionStorage, () => window.location.reload())
  } catch {
    return false
  }
}

function clearLazyImportReloadMarker(label: string): void {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.removeItem(`${LAZY_RELOAD_KEY_PREFIX}${label}`)
  } catch {
    // Storage failures should not prevent the lazy module from rendering.
  }
}

export function lazyWithChunkReload<TComponent extends LazyComponent>(
  label: string,
  importer: () => Promise<{ default: TComponent }>,
): LazyExoticComponent<TComponent> {
  return lazy(async () => {
    try {
      const module = await importer()
      clearLazyImportReloadMarker(label)
      return module
    } catch (error) {
      if (isRecoverableLazyImportError(error) && reloadOnceForLazyImport(label)) {
        return new Promise<{ default: TComponent }>(() => {
          // Keep Suspense visible until the browser processes the reload.
        })
      }

      throw error
    }
  })
}
