export const LOOPTROOP_DEV_FRONTEND = 'LOOPTROOP_DEV_FRONTEND'

export type DevFrontendMode = 'dev' | 'preview'

type Env = Partial<Record<string, string | undefined>>

const PREVIEW_VALUES = new Set(['preview', 'built', 'build'])
const DEV_VALUES = new Set(['', 'dev', 'hmr', 'default'])

/**
 * Chooses between the frontend dev server and the built bundle.
 *
 * `dev` (the default) serves every source file separately and hot-reloads
 * edits. That is the right trade on the machine doing the editing, and the
 * wrong one everywhere else: over a tunnel or a remote link, each of those
 * hundreds of files pays the round trip, and a stack nobody is editing pays it
 * for a feature nobody is using.
 *
 * `preview` builds once and serves the bundle instead. No hot reload, so a code
 * change needs a restart — which is the deal worth taking when the stack is
 * being *run* rather than developed.
 */
export function resolveDevFrontendMode(env: Env = process.env): DevFrontendMode {
  const raw = env[LOOPTROOP_DEV_FRONTEND]?.trim().toLowerCase() ?? ''

  if (PREVIEW_VALUES.has(raw)) return 'preview'
  if (DEV_VALUES.has(raw)) return 'dev'

  // An unrecognised value is a typo, and silently serving the dev bundle to
  // someone who asked for the built one hides exactly the slowness they were
  // trying to remove. Say so, then fall back to the safe default.
  console.warn(
    `[dev] Ignoring ${LOOPTROOP_DEV_FRONTEND}="${raw}": expected "dev" or "preview". Using the dev server.`,
  )
  return 'dev'
}

export function describeDevFrontendMode(mode: DevFrontendMode): string {
  return mode === 'preview'
    ? 'Built bundle (no hot reload) — faster first load, rebuild to see code changes'
    : 'Dev server with hot reload'
}
