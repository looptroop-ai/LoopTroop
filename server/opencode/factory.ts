import { OpenCodeSDKAdapter, type OpenCodeAdapter } from './adapter'
import { MockOpenCodeAdapter } from './mockAdapter'
import { getOpenCodeBaseUrl } from './runtimeConfig'

let singleton: OpenCodeAdapter | null = null

export function isMockOpenCodeMode(): boolean {
  return process.env.LOOPTROOP_OPENCODE_MODE === 'mock'
}

export function getOpenCodeAdapter(): OpenCodeAdapter {
  if (singleton) return singleton
  singleton = isMockOpenCodeMode() ? new MockOpenCodeAdapter() : new OpenCodeSDKAdapter(getOpenCodeBaseUrl())
  return singleton
}

/** Lets a host start a second runtime in-process without inheriting the old base URL. */
export function resetOpenCodeAdapter(): void {
  singleton = null
}


