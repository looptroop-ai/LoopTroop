import { Hono } from 'hono'
import { getOpenCodeAdapter } from '../opencode/factory'
import { credentialsWereSent, openCodeAuthAdvice } from '../opencode/connection'
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
  // The setup notice shows this advice rather than a sentence of its own:
  // whether a password was sent decides between "set one" and "check it", and
  // a v1 server reads different variables than v2.
  const credentialsSent = result.failureKind === 'authentication' ? credentialsWereSent(result) : undefined
  return c.json({
    status: result.available ? 'ok' : 'unavailable',
    ...(result.protocol ? { protocol: result.protocol } : {}),
    version: result.version,
    models: result.models ?? [],
    ...(result.failureKind ? { failureKind: result.failureKind } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(credentialsSent === undefined ? {} : { credentialsSent, advice: openCodeAuthAdvice(credentialsSent) }),
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
