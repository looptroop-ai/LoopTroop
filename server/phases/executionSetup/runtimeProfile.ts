import type { ExecutionSetupProfile } from './types'
import { EXECUTION_SETUP_RUNTIME_DIR } from './types'
import { accessSync, constants, lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { renderCommandSpec, type CommandSpec } from '@shared/commandSpec'

export const EXECUTION_SETUP_RUN_WRAPPER = `${EXECUTION_SETUP_RUNTIME_DIR}/run`

export function normalizeExecutionSetupCommandPath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

export function commandMentionsExecutionSetupWrapper(command: string | CommandSpec, wrapperPath: string = EXECUTION_SETUP_RUN_WRAPPER): boolean {
  const normalizedCommand = normalizeExecutionSetupCommandPath(
    typeof command === 'string' ? command : renderCommandSpec(command),
  )
  const normalizedWrapper = normalizeExecutionSetupCommandPath(wrapperPath)
  return normalizedCommand.includes(normalizedWrapper)
}

function isPathContainedBy(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

export function findCanonicalExecutionSetupCommandWrapper(worktreePath: string): string | null {
  try {
    const worktreeRealPath = realpathSync(worktreePath)
    const wrapperPath = resolve(worktreePath, EXECUTION_SETUP_RUN_WRAPPER)
    const wrapperStat = lstatSync(wrapperPath)
    if (!wrapperStat.isFile()) return null
    if (process.platform !== 'win32') accessSync(wrapperPath, constants.X_OK)
    const wrapperRealPath = realpathSync(wrapperPath)
    if (!isPathContainedBy(worktreeRealPath, wrapperRealPath)) return null
    return EXECUTION_SETUP_RUN_WRAPPER
  } catch {
    return null
  }
}

function getExplicitExecutionSetupCommandWrapper(profile: ExecutionSetupProfile | null | undefined): string | null {
  if (!profile) return null

  const explicitWrapper = profile.reusableArtifacts.find((artifact) => artifact.kind === 'command-wrapper' && artifact.path.trim())
  return explicitWrapper?.path ?? null
}

function getDeclaredExecutionSetupCommandWrapper(profile: ExecutionSetupProfile | null | undefined): string | null {
  if (!profile) return null

  const explicitWrapper = getExplicitExecutionSetupCommandWrapper(profile)
  if (explicitWrapper) return explicitWrapper

  const wrapperArtifact = profile.reusableArtifacts.find((artifact) => (
    artifact.path.trim()
    && normalizeExecutionSetupCommandPath(artifact.path) === EXECUTION_SETUP_RUN_WRAPPER
  ))
  if (wrapperArtifact) return wrapperArtifact.path

  const projectCommands = [
    ...profile.projectCommands.prepare,
    ...profile.projectCommands.testFull,
    ...profile.projectCommands.lintFull,
    ...profile.projectCommands.typecheckFull,
  ]
  return projectCommands.some((command) => commandMentionsExecutionSetupWrapper(command))
    ? EXECUTION_SETUP_RUN_WRAPPER
    : null
}

export function getExecutionSetupCommandWrapper(
  profile: ExecutionSetupProfile | null | undefined,
  worktreePath?: string,
): string | null {
  return getDeclaredExecutionSetupCommandWrapper(profile)
    ?? (worktreePath ? findCanonicalExecutionSetupCommandWrapper(worktreePath) : null)
}

const DISCOVERED_WRAPPER_PURPOSE = 'Preserves the execution setup environment for later project commands.'
const DISCOVERED_WRAPPER_CAUTION = 'LoopTroop detected and recorded the canonical execution setup command wrapper.'

export function repairExecutionSetupCommandWrapper(
  profile: ExecutionSetupProfile,
  worktreePath: string,
): { profile: ExecutionSetupProfile; repaired: boolean } {
  if (getExplicitExecutionSetupCommandWrapper(profile)) return { profile, repaired: false }
  const wrapper = findCanonicalExecutionSetupCommandWrapper(worktreePath)
  if (!wrapper) return { profile, repaired: false }

  let wrapperRecorded = false
  const reusableArtifacts = profile.reusableArtifacts.flatMap((artifact) => {
    if (normalizeExecutionSetupCommandPath(artifact.path) !== wrapper) return [artifact]
    if (wrapperRecorded) return []
    wrapperRecorded = true
    return [{
      ...artifact,
      path: wrapper,
      kind: 'command-wrapper',
      purpose: artifact.purpose.trim() || DISCOVERED_WRAPPER_PURPOSE,
    }]
  })
  if (!wrapperRecorded) {
    reusableArtifacts.push({
      path: wrapper,
      kind: 'command-wrapper',
      purpose: DISCOVERED_WRAPPER_PURPOSE,
    })
  }

  return {
    repaired: true,
    profile: {
      ...profile,
      reusableArtifacts,
      cautions: profile.cautions.includes(DISCOVERED_WRAPPER_CAUTION)
        ? profile.cautions
        : [...profile.cautions, DISCOVERED_WRAPPER_CAUTION],
    },
  }
}

export function hasExecutionSetupProjectCommands(profile: ExecutionSetupProfile | null | undefined): boolean {
  if (!profile) return false
  return [
    profile.projectCommands.prepare,
    profile.projectCommands.testFull,
    profile.projectCommands.lintFull,
    profile.projectCommands.typecheckFull,
  ].some((commands) => commands.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getValueByAliases(record: Record<string, unknown>, aliases: string[]): unknown {
  for (const alias of aliases) {
    if (alias in record) return record[alias]
  }
  return undefined
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
}

function getRawProjectCommands(record: Record<string, unknown>): string[] {
  const rawProjectCommands = getValueByAliases(record, ['projectCommands', 'project_commands'])
  if (!isRecord(rawProjectCommands)) return []
  return [
    ...toStringArray(getValueByAliases(rawProjectCommands, ['prepare'])),
    ...toStringArray(getValueByAliases(rawProjectCommands, ['testFull', 'test_full'])),
    ...toStringArray(getValueByAliases(rawProjectCommands, ['lintFull', 'lint_full'])),
    ...toStringArray(getValueByAliases(rawProjectCommands, ['typecheckFull', 'typecheck_full'])),
  ]
}

export function getExecutionSetupCommandWrapperFromRecord(
  record: Record<string, unknown>,
  worktreePath?: string,
): string | null {
  const profileRecord = isRecord(getValueByAliases(record, ['profile']))
    ? getValueByAliases(record, ['profile']) as Record<string, unknown>
    : record
  const artifacts = getValueByAliases(profileRecord, ['reusableArtifacts', 'reusable_artifacts'])
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      if (!isRecord(artifact)) continue
      const path = typeof artifact.path === 'string' ? artifact.path.trim() : ''
      const kind = typeof artifact.kind === 'string' ? artifact.kind.trim() : ''
      if (path && kind === 'command-wrapper') return path
    }
    for (const artifact of artifacts) {
      if (!isRecord(artifact)) continue
      const path = typeof artifact.path === 'string' ? artifact.path.trim() : ''
      if (path && normalizeExecutionSetupCommandPath(path) === EXECUTION_SETUP_RUN_WRAPPER) return path
    }
  }

  const declaredWrapper = getRawProjectCommands(profileRecord).some((command) => commandMentionsExecutionSetupWrapper(command))
    ? EXECUTION_SETUP_RUN_WRAPPER
    : null
  return declaredWrapper ?? (worktreePath ? findCanonicalExecutionSetupCommandWrapper(worktreePath) : null)
}

export function getExecutionSetupCommandWrapperFromContent(
  content: string | undefined | null,
  worktreePath?: string,
): string | null {
  if (!content) return worktreePath ? findCanonicalExecutionSetupCommandWrapper(worktreePath) : null
  try {
    const parsed = JSON.parse(content) as unknown
    return isRecord(parsed)
      ? getExecutionSetupCommandWrapperFromRecord(parsed, worktreePath)
      : worktreePath
        ? findCanonicalExecutionSetupCommandWrapper(worktreePath)
        : null
  } catch {
    return worktreePath ? findCanonicalExecutionSetupCommandWrapper(worktreePath) : null
  }
}
