import { SHARED_PROFILE_DEFAULTS } from '@shared/profileDefaults'

/** Default council member response timeout (20 minutes) */
export const COUNCIL_RESPONSE_TIMEOUT_MS = SHARED_PROFILE_DEFAULTS.councilResponseTimeout
/** Delay before retry after OpenCode adapter error */
export const ADAPTER_RETRY_DELAY_MS = 2000
/** Default SDK operation timeout */
export const SDK_OPERATION_TIMEOUT_MS = 5000
/** Delays between OpenCode session creation retries */
export const OPENCODE_SESSION_CREATE_RETRY_DELAYS_MS = [1000, 3000, 7000] as const
/** Max time spent collecting health diagnostics after a session creation failure */
export const OPENCODE_SESSION_CREATE_HEALTH_DIAGNOSTIC_TIMEOUT_MS = 1000
/** Force-kill process delay */
export const FORCE_KILL_DELAY_MS = 5000
/**
 * How long after the force-kill a command runner waits before giving up on the
 * child's `close` event and reporting the timeout anyway.
 *
 * Killing a process tree is a request, not a guarantee: on Windows it is
 * delegated to `taskkill`, whose own failure is invisible to the caller, and a
 * surviving grandchild holding the pipes open means `close` never fires. A
 * runner that waits for it hangs the whole phase rather than the one command.
 */
export const PROCESS_ABANDON_GRACE_MS = 2000
/** Most stdout or stderr a single command may contribute, in UTF-8 bytes */
export const MAX_COMMAND_OUTPUT_BYTES = 1_000_000
/** SQLite busy timeout */
export const SQLITE_BUSY_TIMEOUT_MS = 5000
/** Default context window limit for provider catalog */
export const DEFAULT_CONTEXT_WINDOW_LIMIT = 200_000
/** Default token budget for OpenCode prompt context assembly */
export const DEFAULT_OPENCODE_TOKEN_BUDGET = 100_000
/** Min timeout for OpenCode prompt operations */
export const PROMPT_MIN_TIMEOUT_MS = 10_000
/** Max timeout for OpenCode prompt operations */
export const PROMPT_MAX_TIMEOUT_MS = 30_000

/** Max SSE event buffer size */
export const MAX_SSE_BUFFER_SIZE = 1000
/** Max SSE replay buffer bytes per ticket */
export const MAX_SSE_BUFFER_BYTES = 8 * 1024 * 1024
/** How long a buffered SSE event stays replayable to a reconnecting client (5 minutes) */
export const MAX_SSE_BUFFER_TTL_MS = 300_000
/** How often the SSE buffer drops events past their TTL */
export const SSE_BUFFER_CLEANUP_INTERVAL_MS = 60_000
/** Max UI state payload size in bytes (2MB) */
export const MAX_UI_STATE_BYTES = 2_097_152

/** How often the SQLite WAL is checkpointed back into the main database */
export const WAL_CHECKPOINT_INTERVAL_MS = 30_000
/**
 * How long a shutdown waits for its own cleanup before exiting anyway.
 *
 * The same deadline in the daemon and in the foreground server, on purpose:
 * both are the same process shutting down the same resources, and a supervisor
 * that killed one after a different interval than the other would produce two
 * different post-crash states from the same event.
 */
export const SHUTDOWN_FORCE_EXIT_MS = 30_000

/** Max interview questions per batch */
export const MAX_INTERVIEW_BATCH_SIZE = 3
/** Max options for single_choice interview questions */
export const MAX_SINGLE_CHOICE_OPTIONS = 10
/** Max options for multiple_choice interview questions */
export const MAX_MULTIPLE_CHOICE_OPTIONS = 15
/** Max total chars for relevant file content */
export const MAX_RELEVANT_FILES_CHARS = 160_000

/** Max session list limit */
export const SESSION_LIST_LIMIT = 1000
/** Max message list limit */
export const MESSAGE_LIST_LIMIT = 10_000
/** Max model IDs in catalog request */
export const MAX_CATALOG_MODEL_IDS = 50

/** Default truncation length for command log output */
export const LOG_TRUNCATION_LENGTH = 800
/** Truncation length for command stdout/stderr in verification */
export const COMMAND_OUTPUT_SLICE_LENGTH = 1500
/** Truncation length for model output previews */
export const MODEL_OUTPUT_PREVIEW_LENGTH = 2000
/** Default truncation length for execution notes */
export const EXECUTOR_NOTE_TRUNCATION_LENGTH = 600
/** Truncation length for execution detail notes */
export const EXECUTOR_DETAIL_TRUNCATION_LENGTH = 320
/** Max diff patch length for PR context */
export const MAX_DIFF_PATCH_LENGTH = 30_000
/**
 * How much of a probe or hook command's combined output is kept as the excerpt
 * shown on its receipt.
 *
 * Numerically the same as `MODEL_OUTPUT_PREVIEW_LENGTH` and deliberately not
 * that constant: one bounds what a build command printed, the other what a
 * model wrote, and they have no reason to move together.
 */
export const COMMAND_OUTPUT_EXCERPT_LENGTH = 2000
/**
 * How much of a rejected response is quoted back to the model when asking it to
 * correct its structured output.
 *
 * Large because the point is to show the model its own whole answer; small
 * enough that a runaway response cannot double the next prompt.
 */
export const STRUCTURED_CORRECTION_ECHO_LENGTH = 50_000
