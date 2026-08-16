import { Hono } from 'hono'
import { getOpenCodeAdapter } from '../opencode/factory'
import { dismissStartupRestoreNotice, getStartupStatus } from '../startupState'
import { APP_VERSION } from '../lib/appVersion'
import { getUpdateStatus } from '../lib/updateCheck'

const health = new Hono()

health.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

health.get('/health/opencode', async (c) => {
  const adapter = getOpenCodeAdapter()
  const result = await adapter.checkHealth()
  return c.json({
    status: result.available ? 'ok' : 'unavailable',
    version: result.version,
    models: result.models ?? [],
    ...(result.error ? { error: result.error } : {}),
  })
})

health.get('/health/startup', (c) => {
  return c.json(getStartupStatus())
})

health.get('/health/update', async (c) => {
  return c.json(await getUpdateStatus({ currentVersion: APP_VERSION }))
})

health.post('/health/startup/restore-notice/dismiss', (c) => {
  return c.json(dismissStartupRestoreNotice())
})

export { health }
