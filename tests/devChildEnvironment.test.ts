import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getSpawnOpts } from '../node_modules/concurrently/dist/lib/spawn.js'
import { maskOpenCodeCredentials } from '../server/lib/childEnvironment'

describe('development service child environments', () => {
  it('masks configured OpenCode passwords after concurrently merges the parent environment', () => {
    const parentEnv = {
      ...process.env,
      OPENCODE_PASSWORD: 'configured-v2-password',
      OPENCODE_SERVER_PASSWORD: 'configured-v1-password',
      opencode_server_password: 'windows-case-alias',
      LOOPTROOP_OPENCODE_BASE_URL: 'http://127.0.0.1:4096',
    }
    const overlay = maskOpenCodeCredentials(parentEnv, true)
    const options = getSpawnOpts({
      colorSupport: false,
      process: { cwd: process.cwd, platform: process.platform, env: parentEnv },
      env: overlay,
    })

    expect(options.env?.OPENCODE_PASSWORD).toBeUndefined()
    expect(options.env?.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(options.env?.opencode_server_password).toBeUndefined()
    expect(options.env?.LOOPTROOP_OPENCODE_BASE_URL).toBe('http://127.0.0.1:4096')

    const child = spawnSync(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify([process.env.OPENCODE_PASSWORD ?? null, process.env.OPENCODE_SERVER_PASSWORD ?? null, process.env.opencode_server_password ?? null, process.env.LOOPTROOP_OPENCODE_BASE_URL]))',
    ], { cwd: options.cwd, env: options.env, encoding: 'utf8', timeout: 3_000 })
    expect(child.status, child.stderr).toBe(0)
    expect(child.stdout).toBe('[null,null,null,"http://127.0.0.1:4096"]')
  })
})
