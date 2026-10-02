import { Hono } from 'hono'
import { getOpenCodeAdapter } from '../opencode/factory'
import { fetchProviderCatalog, flattenCatalogModels, refreshProviderCatalog } from '../opencode/providerCatalog'
import { ProviderCatalogBusyError } from '../opencode/providerCatalogReload'
import type { OpenCodeCatalogResponse, OpenCodeCatalogScope } from '../../shared/opencodeCatalog'
import { hasOpenCodePassword } from '../../shared/opencodeAuth'
import { openCodeAuthAdvice } from '../opencode/connection'

const modelsRouter = new Hono()

function serializeCatalog(catalog: OpenCodeCatalogResponse, scope: 'connected' | 'all') {
  return {
    models: flattenCatalogModels(catalog, scope),
    connectedProviders: catalog.connected,
    defaultModels: catalog.default,
    catalogScope: catalog.supportsAllModels ? scope : 'available' as OpenCodeCatalogScope,
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
      : health.failureKind === 'authentication'
        // Worded by whether LoopTroop put a password on the wire, which the
        // health check reports. Not the environment: the supervisor fills that
        // with a generated password before launching its own server, so it says
        // "configured" for a password nobody configured.
        ? openCodeAuthAdvice(health.credentialsSent ?? hasOpenCodePassword(process.env))
        : 'OpenCode server is not reachable. Restart LoopTroop (`looptroop restart`) so it starts OpenCode again, or check the OpenCode URL setting.',
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
  } catch (error) {
    if (error instanceof ProviderCatalogBusyError) {
      return c.json({ code: 'OPENCODE_BUSY', message: error.message }, 409)
    }
    return c.json(await modelDiscoveryFailure())
  }
})

export { modelsRouter }
