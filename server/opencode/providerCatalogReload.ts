export class ProviderCatalogBusyError extends Error {
  constructor() {
    super('OpenCode has active work or unanswered requests. Wait for them to finish, then retry.')
    this.name = 'ProviderCatalogBusyError'
  }
}

let activePrompts = 0
let catalogReloading = false

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

export async function withProviderCatalogReload<T>(
  assertIdle: () => Promise<void>,
  reload: () => Promise<T>,
): Promise<T> {
  if (catalogReloading || activePrompts > 0) throw new ProviderCatalogBusyError()
  catalogReloading = true
  try {
    await assertIdle()
    return await reload()
  } finally {
    catalogReloading = false
  }
}
