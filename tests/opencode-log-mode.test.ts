import { describe, expect, it } from 'vitest'
import { NPM_CONFIG_OPENCODE_LOGS, resolveOpenCodeLogMode } from '../scripts/opencode-log-mode'
import { LOOPTROOP_OPENCODE_LOGS_ENV } from '../shared/opencodeLogMode'

describe('resolveOpenCodeLogMode', () => {
  it('uses default mode without console printing', () => {
    expect(resolveOpenCodeLogMode({ env: {} })).toEqual({
      mode: 'default',
      requested: false,
    })
  })

  it('supports npm run config flags without the argument forwarding separator', () => {
    expect(resolveOpenCodeLogMode({
      env: { [NPM_CONFIG_OPENCODE_LOGS]: 'all' },
    })).toEqual({
      mode: 'all',
      requested: true,
      source: 'npm-config',
    })
  })

  it('supports an environment fallback for direct OpenCode watcher use', () => {
    expect(resolveOpenCodeLogMode({
      env: { [LOOPTROOP_OPENCODE_LOGS_ENV]: 'all' },
    })).toEqual({
      mode: 'all',
      requested: true,
      source: 'env',
    })
  })

  it('rejects invalid requested log modes with a clear message', () => {
    expect(() => resolveOpenCodeLogMode({
      env: { [NPM_CONFIG_OPENCODE_LOGS]: 'debug' },
    })).toThrow('Invalid OpenCode log mode "debug". Use npm run dev --opencode-logs=all.')

    expect(() => resolveOpenCodeLogMode({
      env: { [LOOPTROOP_OPENCODE_LOGS_ENV]: 'verbose' },
    })).toThrow('Invalid OpenCode log mode "verbose". Use LOOPTROOP_OPENCODE_LOGS=all.')
  })
})
