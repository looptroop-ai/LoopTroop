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

function basePermissionRules(
  toolPolicy: OpenCodeToolPolicy,
): ReadonlyArray<OpenCodePermissionRule> | undefined {
  if (toolPolicy === 'default') return OPENCODE_DEFAULT_PERMISSIONS
  if (toolPolicy === 'disabled') return OPENCODE_DISABLED_PERMISSIONS
  if (toolPolicy === 'read_only') return OPENCODE_READ_ONLY_PERMISSIONS
  if (toolPolicy === 'execution_setup_online') return OPENCODE_EXECUTION_SETUP_ONLINE_PERMISSIONS
  return undefined
}

/**
 * The one policy that never asks, whatever the setting says.
 *
 * `disabled` is how a step declares it does no work in the world — it reformats
 * text it was handed and returns it. Compiling interview answers into questions,
 * writing a pull request body, summarising verification output. A step with
 * nothing to investigate has nothing to ask about, and letting one stop an
 * unattended run for five minutes buys nothing.
 */
const SILENT_TOOL_POLICIES: ReadonlySet<OpenCodeToolPolicy> = new Set<OpenCodeToolPolicy>(['disabled'])

/**
 * Replaces whatever the policy said about `question` with exactly one rule.
 *
 * Filter-then-push rather than append-and-hope: precedence between a wildcard
 * `{ permission: '*' }` rule and a specific `{ permission: 'question' }` one is
 * not documented, so relying on last-wins would be a guess. Removing every
 * existing `question` rule first is correct whichever way OpenCode resolves it.
 *
 * Two of the four policies (`disabled`, `read_only`) carry `question: false`
 * today, which is why the switch had no effect on them and only five prompts
 * could ever ask. After this the setting decides for every policy but
 * `disabled`.
 */
function withQuestionRule(
  rules: ReadonlyArray<OpenCodePermissionRule>,
  questionsAllowed: boolean,
): ReadonlyArray<OpenCodePermissionRule> {
  return Object.freeze([
    ...rules.filter((rule) => rule.permission !== 'question'),
    {
      permission: 'question',
      pattern: '*',
      action: questionsAllowed ? 'allow' as const : 'deny' as const,
    },
  ])
}

const PERMISSION_CACHE = new Map<string, ReadonlyArray<OpenCodePermissionRule>>()

/**
 * @param questionsAllowed Whether this prompt may stop and ask a person.
 *   Defaults to deny so a call site that forgets to opt in fails closed — the
 *   unattended guarantee is the thing worth protecting.
 */
export function resolveOpenCodePermissions(
  toolPolicy: OpenCodeToolPolicy = 'default',
  questionsAllowed = false,
): PromptSessionOptions['permission'] | undefined {
  const base = basePermissionRules(toolPolicy)
  if (!base) return undefined
  const permitted = questionsAllowed && !SILENT_TOOL_POLICIES.has(toolPolicy)
  const cacheKey = `${toolPolicy}:${permitted ? 'ask' : 'silent'}`
  const cached = PERMISSION_CACHE.get(cacheKey)
  if (cached) return cached
  const resolved = withQuestionRule(base, permitted)
  PERMISSION_CACHE.set(cacheKey, resolved)
  return resolved
}

/** True when this policy would let a prompt ask, given the ticket's setting. */
export function toolPolicyMayAskQuestions(toolPolicy: OpenCodeToolPolicy = 'default'): boolean {
  return !SILENT_TOOL_POLICIES.has(toolPolicy)
}

/**
 * What each policy puts on the wire when asking is off.
 *
 * The `OPENCODE_*_PERMISSIONS` constants above are the policy *tables*; these
 * are what a prompt is actually sent. Tests assert against these, so a change to
 * how the question rule is applied is caught rather than silently accepted.
 */
export const SILENT_DEFAULT_PERMISSIONS = resolveOpenCodePermissions('default')
export const SILENT_DISABLED_PERMISSIONS = resolveOpenCodePermissions('disabled')
export const SILENT_READ_ONLY_PERMISSIONS = resolveOpenCodePermissions('read_only')
export const SILENT_EXECUTION_SETUP_ONLINE_PERMISSIONS = resolveOpenCodePermissions('execution_setup_online')
