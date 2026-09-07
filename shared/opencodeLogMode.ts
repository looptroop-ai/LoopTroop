/**
 * The environment variable that turns on full OpenCode DEBUG output.
 *
 * It crosses a process boundary in both directions — `looptroop start` sets it
 * on the daemon it spawns, the daemon reads it back, and `npm run dev` sets it
 * on the stack it starts — so it was spelled out three times: exported from
 * `scripts/opencode-log-mode.ts`, redeclared as `OPENCODE_LOG_MODE_ENV` in
 * `server/cli/commands.ts`, and written inline in `server/cli/daemonProcess.ts`.
 * A rename in one place would have left the setter and the reader disagreeing
 * with nothing to fail: an env var nobody sets simply reads as off.
 *
 * Here rather than under `server/` or `scripts/` because both sides need it and
 * neither owns it. **The name itself is an operator-facing interface** — it
 * appears in documentation and in people's shell profiles — so this constant
 * may be moved, but its value must not change.
 */
export const LOOPTROOP_OPENCODE_LOGS_ENV = 'LOOPTROOP_OPENCODE_LOGS'
