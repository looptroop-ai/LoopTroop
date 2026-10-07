import { Hono } from 'hono'
import { getOpenCodeAdapter } from '../opencode/factory'
import { fetchProviderCatalog, flattenCatalogModels, refreshProviderCatalog } from '../opencode/providerCatalog'
import { ProviderCatalogBusyError } from '../opencode/providerCatalogReload'
import type { OpenCodeCatalogReloadState, OpenCodeCatalogResponse, OpenCodeCatalogScope } from '../../shared/opencodeCatalog'
import { credentialsWereSent, openCodeAuthAdvice } from '../opencode/connection'
import { warnIfVerbose } from '../runtime'

const modelsRouter = new Hono()

function serializeCatalog(catalog: OpenCodeCatalogResponse, scope: 'connected' | 'all') {
  return {
    models: flattenCatalogModels(catalog, scope),
    connectedProviders: catalog.connected,
    defaultModels: catalog.default,
    catalogScope: catalog.supportsAllModels ? scope : 'available' as OpenCodeCatalogScope,
  }
}

async function modelDiscoveryFailure(error: unknown, signal: AbortSignal) {
  signal.throwIfAborted()
  warnIfVerbose('[models] OpenCode model discovery failed:', error)
  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      models: [],
      connectedProviders: [],
      defaultModels: {},
      code: 'OPENCODE_DISCOVERY_TIMEOUT' as const,
      message: 'OpenCode model discovery timed out. Try refreshing models.',
    }
  }
  const adapter = getOpenCodeAdapter()
  const health = await adapter.checkHealth(signal)
  signal.throwIfAborted()
  const available = health.available
  return {
    models: [],
    connectedProviders: [],
    defaultModels: {},
    code: available ? 'OPENCODE_DISCOVERY_FAILED' as const : 'OPENCODE_UNREACHABLE' as const,
    message: available
      ? 'OpenCode is connected, but model discovery failed.'
      : health.failureKind === 'authentication'
        // Worded by whether LoopTroop put a password on the wire, which the
        // health check reports, not by the environment the supervisor fills in.
        ? openCodeAuthAdvice(credentialsWereSent(health))
        : 'OpenCode server is not reachable. Restart LoopTroop (`looptroop restart`) so it starts OpenCode again, or check the OpenCode URL setting.',
  }
}

modelsRouter.get('/models', async (c) => {
  try {
    const scope = c.req.query('scope') === 'all' ? 'all' : 'connected'
    return c.json(serializeCatalog(await fetchProviderCatalog(c.req.raw.signal, scope), scope))
  } catch (error) {
    return c.json(await modelDiscoveryFailure(error, c.req.raw.signal))
  }
})

modelsRouter.post('/models/refresh', async (c) => {
  let reloadState: OpenCodeCatalogReloadState = 'not_started'
  try {
    const catalog = await refreshProviderCatalog(c.req.raw.signal, (state) => { reloadState = state })
    return c.json(serializeCatalog(catalog, 'connected'))
  } catch (error) {
    c.req.raw.signal.throwIfAborted()
    if (error instanceof ProviderCatalogBusyError) {
      return c.json({ code: 'OPENCODE_BUSY', message: error.message }, 409)
    }
    return c.json({ ...await modelDiscoveryFailure(error, c.req.raw.signal), reloadState })
  }
})

export { modelsRouter }
