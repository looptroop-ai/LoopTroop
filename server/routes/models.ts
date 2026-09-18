import { Hono } from 'hono'
import { getOpenCodeAdapter } from '../opencode/factory'
import { fetchProviderCatalog, flattenCatalogModels, refreshProviderCatalog } from '../opencode/providerCatalog'
import type { OpenCodeCatalogResponse } from '../../shared/opencodeCatalog'

const modelsRouter = new Hono()

function serializeCatalog(catalog: OpenCodeCatalogResponse, scope: 'connected' | 'all') {
  return {
    models: flattenCatalogModels(catalog, scope),
    connectedProviders: catalog.connected,
    defaultModels: catalog.default,
  }
}

async function modelDiscoveryFailure() {
  const adapter = getOpenCodeAdapter()
  const health = await adapter.checkHealth()
  const available = health.available
  return {
    models: [],
    connectedProviders: [],
    defaultModels: {},
    code: available ? 'OPENCODE_DISCOVERY_FAILED' as const : 'OPENCODE_UNREACHABLE' as const,
    message: available
      ? 'OpenCode is connected, but model discovery failed.'
      : 'OpenCode server is not reachable. Start it with `opencode serve`.',
  }
}

modelsRouter.get('/models', async (c) => {
  try {
    const scope = c.req.query('scope') === 'all' ? 'all' : 'connected'
    return c.json(serializeCatalog(await fetchProviderCatalog(), scope))
  } catch {
    return c.json(await modelDiscoveryFailure())
  }
})

modelsRouter.post('/models/refresh', async (c) => {
  try {
    return c.json(serializeCatalog(await refreshProviderCatalog(), 'connected'))
  } catch {
    return c.json(await modelDiscoveryFailure())
  }
})

export { modelsRouter }
