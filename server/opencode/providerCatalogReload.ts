export class ProviderCatalogBusyError extends Error {
  constructor() {
    super('OpenCode has active work or unanswered requests. Wait for them to finish, then retry.')
    this.name = 'ProviderCatalogBusyError'
  }
}

let activePrompts = 0
let waitingPrompts = 0
let catalogReloading = false
let catalogReloadFinished: Promise<void> | undefined
let finishCatalogReload: (() => void) | undefined

export function beginOpenCodePromptActivity(): () => void {
  if (catalogReloading) throw new ProviderCatalogBusyError()
  activePrompts += 1
  let active = true
  return () => {
    if (!active) return
    active = false
    activePrompts -= 1
  }
}

function waitForReload(signal: AbortSignal | undefined, reloadFinished: Promise<void>): Promise<void> {
  if (!signal) return reloadFinished
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    reloadFinished.then(() => {
      cleanup()
      resolve()
    }, error => {
      cleanup()
      reject(error)
    })
    if (signal.aborted) onAbort()
  })
}

export async function waitForOpenCodePromptActivity(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
  if (!catalogReloading) return beginOpenCodePromptActivity()

  waitingPrompts += 1
  try {
    const reloadFinished = catalogReloadFinished
    if (!reloadFinished) throw new Error('OpenCode catalog reload completion signal is unavailable')
    await waitForReload(signal, reloadFinished)
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError')
    return beginOpenCodePromptActivity()
  } finally {
    waitingPrompts -= 1
  }
}

export async function withProviderCatalogReload<T>(
  assertIdle: () => Promise<void>,
  reload: () => Promise<T>,
): Promise<T> {
  if (catalogReloading || activePrompts > 0 || waitingPrompts > 0) throw new ProviderCatalogBusyError()
  catalogReloading = true
  catalogReloadFinished = new Promise<void>(resolve => { finishCatalogReload = resolve })
  try {
    await assertIdle()
    return await reload()
  } finally {
    catalogReloading = false
    finishCatalogReload?.()
    finishCatalogReload = undefined
    catalogReloadFinished = undefined
  }
}
