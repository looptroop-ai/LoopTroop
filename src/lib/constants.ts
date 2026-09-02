/** Delay before hiding copy-success indicator */
export const COPY_SUCCESS_DISPLAY_MS = 2000
/** Shorter copy-success delay for compact inline copy buttons */
export const COPY_SUCCESS_DISPLAY_SHORT_MS = 1500
/** SSE reconnection delay */
export const SSE_RECONNECT_DELAY_MS = 3000
/** Interval for polling backend health to detect server downtime */
export const BACKEND_HEALTH_POLL_MS = 3000
/** Delay before confirming a failed backend health probe */
export const BACKEND_HEALTH_RECONNECT_GRACE_MS = 1500
/** Grace-delayed retry count after the initial failed health probe */
export const BACKEND_HEALTH_RECONNECT_CONFIRMATION_PROBES = 1
/** Dedicated health deadline; normal API calls keep their shorter timeout. */
export const BACKEND_HEALTH_TIMEOUT_MS = 5000
/** Cooldown that prevents repeated automatic recovery reloads */
export const RECOVERY_RELOAD_COOLDOWN_MS = 10_000
/** Short delay before running an automatic recovery reload */
export const RECOVERY_RELOAD_DELAY_MS = 50
/** Minimum visible warning duration before an automatic recovery reload is armed */
export const RECOVERY_RELOAD_MIN_ACTIVE_MS = 5000
/** Default API call timeout */
export const API_TIMEOUT_MS = 1000
/** Model fetch timeout */
export const MODEL_FETCH_TIMEOUT_MS = 5000
/** Max raw output length before truncation */
export const MAX_RAW_OUTPUT_LENGTH = 4000

/** Dropdown positioning */
export const DROPDOWN_MARGIN = 8
export const DROPDOWN_OFFSET = 4
export const DROPDOWN_MAX_HEIGHT = 420
export const DROPDOWN_PADDING = 12

/** Delay before focusing dropdown search input (lets DOM settle after portal mount) */
export const DROPDOWN_FOCUS_DELAY_MS = 50

/** Query stale time for infrequently-changing data (5 minutes) */
export const QUERY_STALE_TIME_5M = 5 * 60 * 1000
/**
 * How the model catalog waits out OpenCode's startup window.
 *
 * The catalog answers HTTP 200 with a `message` while OpenCode is still coming
 * up, so the query retries its way through that window. These are its own knobs:
 * they started life borrowed from the SSE reconnect delay, which meant retuning
 * the stream's cadence silently retuned model fetching. Same numbers, separate
 * reasons to change.
 */
export const MODEL_FETCH_RETRY_COUNT = 8
export const MODEL_FETCH_RETRY_DELAY_MS = 3000
/** Default toast notification duration */
export const TOAST_DURATION_MS = 4000
/** Interval for polling to recover unanswered AI questions */
export const QUESTION_RECOVERY_INTERVAL_MS = 30_000

/** Debounce delay for git-check triggered by folder input change */
export const GIT_CHECK_DEBOUNCE_MS = 300
/** Debounce delay for git-check in project form */
export const PROJECT_GIT_CHECK_DEBOUNCE_MS = 500
/** Tick interval for the active-bead countdown timer */
export const COUNTDOWN_TICK_MS = 1_000

/** z-index for absolutely positioned dropdowns above all other UI */
export const DROPDOWN_Z_INDEX = 9999

/**
 * The keyboard-shortcuts overlay, above everything including the dropdowns. It both
 * holds focus and makes the rest of the page inert while it is open, so anything it
 * renders underneath is a surface the user cannot see and cannot use.
 */
export const SHORTCUTS_OVERLAY_Z_INDEX = DROPDOWN_Z_INDEX + 1

/** Seconds in one hour — used for time display formatting */
export const SECONDS_PER_HOUR = 3_600
/** Seconds in one day — used for time display formatting */
export const SECONDS_PER_DAY = 86_400

/** Bytes per kibibyte — used for file-size formatting */
export const BYTES_PER_KIB = 1_024

/** Maximum value (in seconds) for timeout configuration fields */
export const MAX_TIMEOUT_SECONDS = 3_600

/** Grace period (ms) to distinguish a user edit from auto-save after plan generation */
export const EXECUTION_SETUP_EDIT_GRACE_MS = 1000
