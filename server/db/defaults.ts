import { DEFAULT_GIT_HOOK_POLICY } from '@shared/gitHookPolicy'
import { DEFAULT_IGNORE_MODE } from '@shared/ignoreMode'
import { SHARED_PROFILE_DEFAULTS } from '@shared/profileDefaults'

/**
 * The full profile defaults, as the database and the workflow read them.
 *
 * Everything the SPA also reads lives in `@shared/profileDefaults`; the two
 * below stay here because only the server uses them, and both come from the
 * modules that own those unions rather than being spelled out again.
 */
export const PROFILE_DEFAULTS = {
  gitHookPolicy: DEFAULT_GIT_HOOK_POLICY,
  ignoreMode: DEFAULT_IGNORE_MODE,
  ...SHARED_PROFILE_DEFAULTS,
} as const
