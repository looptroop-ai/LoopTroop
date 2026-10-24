import { isAbsolute, relative } from 'path'
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
  external_directory: true,
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
 * Remove existing question entries and append one setting-specific rule. This
 * keeps the output unambiguous and places the setting after the policy rules.
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
  workflowGuardApplies = false,
): PromptSessionOptions['permission'] | undefined {
  const base = basePermissionRules(toolPolicy)
  if (!base) return undefined
  const permitted = questionsAllowed && !SILENT_TOOL_POLICIES.has(toolPolicy)
  const cacheKey = `${toolPolicy}:${permitted ? 'ask' : 'silent'}:${workflowGuardApplies ? 'guarded' : 'unguarded'}`
  const cached = PERMISSION_CACHE.get(cacheKey)
  if (cached) return cached
  const guardedRules = workflowGuardApplies && (toolPolicy === 'default' || toolPolicy === 'execution_setup_online')
    ? [
        ...base,
        ...['bash', 'edit', 'write', 'apply_patch'].map((permission) => ({
          permission,
          pattern: '*',
          action: 'ask' as const,
        })),
      ]
    : base
  const resolved = withQuestionRule(guardedRules, permitted)
  PERMISSION_CACHE.set(cacheKey, resolved)
  return resolved
}

/**
 * Whether the rules on this prompt deny a permission outright.
 *
 * Used where a permission is *asked for* rather than resolved silently. Auto
 * approval exists to keep an unattended run moving, not to override the policy
 * the run was given, so a denied permission has to be refused even there. The
 * OpenCode evaluates all matching rules in order and uses the last match, even
 * when that match is a wildcard rule.
 *
 * Read from the end, because that is how the array is built: the base allow-all
 * table first, then the policy's overrides. Taking the *first* match meant
 * `doom_loop` and `external_directory` — the two the base table names outright —
 * always reported the base allow, so a policy that denies them read as allowing
 * them. That is the same hole auto-approval had for `question`.
 */
export function isPermissionDeniedByRules(
  rules: ReadonlyArray<OpenCodePermissionRule> | undefined,
  permission: string | undefined,
  patterns?: readonly string[],
  directory?: string,
): boolean {
  if (!rules || !permission) return false
  const resources = patterns?.length ? patterns : ['*']
  return resources.some((resource) => {
    const candidates = [resource]
    if (directory && isAbsolute(resource)) {
      const relativeResource = relative(directory, resource)
      if (relativeResource !== resource) candidates.push(relativeResource)
    }
    const matchesResource = (rule: OpenCodePermissionRule) =>
      candidates.some((candidate) => permissionPatternMatches(rule.pattern, candidate))
    const lastMatch = rules.findLast(
      (rule) =>
        (rule.permission === permission || rule.permission === '*') &&
        matchesResource(rule),
    )
    return lastMatch?.action === 'deny'
  })
}

function permissionPatternMatches(pattern: string, resource: string): boolean {
  let normalizedPattern = pattern.replaceAll('\\', '/')
  let normalizedResource = resource.replaceAll('\\', '/')
  if (process.platform === 'win32') {
    normalizedPattern = normalizedPattern.toLowerCase()
    normalizedResource = normalizedResource.toLowerCase()
  }
  if (normalizedPattern.endsWith(' *') && normalizedResource === normalizedPattern.slice(0, -2)) return true

  // Dynamic regex construction exposed command strings to regex backtracking.
  // This two-row glob matcher treats only * and ? as operators; all other
  // characters are literal. Work is bounded by pattern length × resource
  // length and memory is bounded by the resource length.
  let previous = new Array<boolean>(normalizedResource.length + 1).fill(false)
  previous[0] = true
  for (let patternIndex = 0; patternIndex < normalizedPattern.length; patternIndex++) {
    const patternCharacter = normalizedPattern[patternIndex]!
    const current = new Array<boolean>(normalizedResource.length + 1).fill(false)
    if (patternCharacter === '*') {
      current[0] = previous[0]!
      for (let index = 1; index <= normalizedResource.length; index++) {
        current[index] = previous[index]! || current[index - 1]!
      }
    } else {
      for (let index = 1; index <= normalizedResource.length; index++) {
        current[index] =
          previous[index - 1]! &&
          (patternCharacter === '?' || patternCharacter === normalizedResource[index - 1])
      }
    }
    previous = current
  }
  return previous[normalizedResource.length]!
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
