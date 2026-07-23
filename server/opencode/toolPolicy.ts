import type { OpenCodePermissionRule, PromptSessionOptions } from './types'
import { OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS } from './permissions'

export type OpenCodeToolPolicy = 'default' | 'disabled' | 'read_only' | 'execution_setup_online'

const OPENCODE_DEFAULT_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({
  webfetch: false,
  websearch: false,
})

const OPENCODE_DISABLED_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({
  '*': false,
  bash: false,
  codesearch: false,
  doom_loop: false,
  edit: false,
  external_directory: false,
  glob: false,
  grep: false,
  list: false,
  lsp: false,
  question: false,
  read: false,
  skill: false,
  task: false,
  todoread: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
  write: false,
})

const OPENCODE_READ_ONLY_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({
  '*': false,
  bash: false,
  codesearch: true,
  doom_loop: false,
  edit: false,
  external_directory: false,
  glob: true,
  grep: true,
  list: true,
  lsp: true,
  question: false,
  read: true,
  skill: false,
  task: false,
  todoread: false,
  todowrite: false,
  webfetch: false,
  websearch: false,
  write: false,
})

const OPENCODE_EXECUTION_SETUP_ONLINE_OVERRIDES: Readonly<Record<string, boolean>> = Object.freeze({
  webfetch: true,
  websearch: true,
})

function buildPermissionRules(
  overrides: Readonly<Record<string, boolean>>,
): ReadonlyArray<OpenCodePermissionRule> {
  return Object.freeze([
    ...OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS,
    ...Object.entries(overrides).map(([permission, enabled]) => ({
      permission,
      pattern: '*',
      action: enabled ? 'allow' as const : 'deny' as const,
    })),
  ])
}

export const OPENCODE_DEFAULT_PERMISSIONS = buildPermissionRules(OPENCODE_DEFAULT_OVERRIDES)
export const OPENCODE_DISABLED_PERMISSIONS = buildPermissionRules(OPENCODE_DISABLED_OVERRIDES)
export const OPENCODE_READ_ONLY_PERMISSIONS = buildPermissionRules(OPENCODE_READ_ONLY_OVERRIDES)
export const OPENCODE_EXECUTION_SETUP_ONLINE_PERMISSIONS = buildPermissionRules(
  OPENCODE_EXECUTION_SETUP_ONLINE_OVERRIDES,
)

export function resolveOpenCodePermissions(
  toolPolicy: OpenCodeToolPolicy = 'default',
): PromptSessionOptions['permission'] | undefined {
  if (toolPolicy === 'default') return OPENCODE_DEFAULT_PERMISSIONS
  if (toolPolicy === 'disabled') return OPENCODE_DISABLED_PERMISSIONS
  if (toolPolicy === 'read_only') return OPENCODE_READ_ONLY_PERMISSIONS
  if (toolPolicy === 'execution_setup_online') return OPENCODE_EXECUTION_SETUP_ONLINE_PERMISSIONS
  return undefined
}
