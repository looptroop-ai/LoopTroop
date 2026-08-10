import { DEFAULT_OPENCODE_BASE_URL } from '../../shared/appConfig'
import type { ResolvedSettings } from '../lib/appSettings'

/**
 * OpenCode settings for this process, once a host has resolved them.
 *
 * Null until `configureOpenCodeRuntime` runs. Everything below falls back to the
 * environment in that case, which is what keeps a bare `createApp()` and the
 * dev scripts working without a resolved settings object.
 */
let configured: { baseUrl: string; mock: boolean } | null = null

/**
 * Hands the resolved settings to the OpenCode layer.
 *
 * Without this, `opencodeBaseUrl` and `opencodeMode` in `config.json` were
 * resolved, reported by `doctor`, and then ignored: the adapter read
 * `LOOPTROOP_OPENCODE_BASE_URL` straight from the environment, so a user who
 * pointed their config file at another port silently kept talking to the
 * default one — while `doctor` health-checked the port they asked for and
 * called it reachable.
 *
 * Must run before anything touches the adapter. The singleton is built during
 * module import (`server/workflow/phases/state.ts` is reachable from the route
 * graph), so this also resets it: a config applied afterwards would otherwise
 * land on an adapter that already has its client.
 */
export function configureOpenCodeRuntime(settings: Pick<ResolvedSettings, 'opencodeBaseUrl' | 'opencodeMode'>): void {
  configured = { baseUrl: settings.opencodeBaseUrl, mock: settings.opencodeMode === 'mock' }
}

/** Drops the resolved config so a second runtime in-process starts clean. */
export function resetOpenCodeRuntimeConfig(): void {
  configured = null
}

export function getOpenCodeBaseUrl(): string {
  if (configured) return configured.baseUrl
  return process.env.LOOPTROOP_OPENCODE_BASE_URL?.trim() || DEFAULT_OPENCODE_BASE_URL
}

export function isOpenCodeMockMode(): boolean {
  if (configured) return configured.mock
  return process.env.LOOPTROOP_OPENCODE_MODE === 'mock'
}
