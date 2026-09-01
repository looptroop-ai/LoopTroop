/**
 * Why a workspace input cannot be reproduced from the repository alone.
 *
 * The list, the union and the guard live here because they are read from three
 * directions — the server's structured-output parsing, the ticket route's
 * request schema, and the SPA's plan parsing and editor. Each of those used to
 * spell the categories out again, so a renamed category had three places to
 * reach and the client ones failed silently.
 */
export const EXECUTION_SETUP_WORKSPACE_INPUT_CATEGORIES = [
  'local_config',
  'secret',
  'fixture',
  'dataset',
  'other_non_reproducible',
] as const

export type ExecutionSetupWorkspaceInputCategory = (typeof EXECUTION_SETUP_WORKSPACE_INPUT_CATEGORIES)[number]

export function isExecutionSetupWorkspaceInputCategory(
  value: unknown,
): value is ExecutionSetupWorkspaceInputCategory {
  return (EXECUTION_SETUP_WORKSPACE_INPUT_CATEGORIES as readonly unknown[]).includes(value)
}
