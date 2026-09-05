import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { runGitSync } from '../../git/runCommand'
import { literalPathspec } from '../../git/pathspecs'
import type { ExecutionSetupWorkspaceInputPayload } from '../../structuredOutput/types'

const INTERNAL_ROOTS = ['.git', '.ticket', '.looptroop'] as const
export const WORKSPACE_INPUT_DEFAULT_MAX_FILES = 10_000
export const WORKSPACE_INPUT_DEFAULT_MAX_BYTES = 100 * 1024 * 1024

export interface WorkspaceInputCopyPreview {
  path: string
  fileCount: number
  totalBytes: number
  exceedsDefaultLimit: boolean
}

function normalizeRelativePath(input: string): string {
  return input.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function assertResolvedWithin(root: string, candidate: string, path: string): void {
  const realRoot = realpathSync(root)
  let existing = candidate
  while (!existsSync(existing)) {
    const parent = dirname(existing)
    if (parent === existing) break
    existing = parent
  }
  if (!isWithin(realRoot, realpathSync(existing))) {
    throw new Error(`Workspace input path escapes the project through a symbolic link: ${path}`)
  }
}

function assertSafeWorkspaceInputPath(path: string): string {
  const normalized = normalizeRelativePath(path)
  if (!normalized || normalized === '.' || isAbsolute(path) || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Workspace input path must stay inside the project: ${path}`)
  }
  if (INTERNAL_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    throw new Error(`Workspace input path cannot target Git or LoopTroop internals: ${path}`)
  }
  return normalized
}

function runGit(projectRoot: string, args: string[]): { status: number | null; stdout: string; error?: Error } {
  const result = runGitSync(projectRoot, args)
  return {
    status: result.status,
    stdout: result.stdout,
    ...(result.spawnError ? { error: result.spawnError } : {}),
  }
}

function sourceStatusMatches(projectRoot: string, path: string, status: ExecutionSetupWorkspaceInputPayload['sourceStatus']): boolean {
  // `check-ignore` takes a pathname and refuses pathspec magic outright
  // ("pathspec magic not supported by this command"), so this one stays bare
  // while its neighbours below are wrapped. The paths here are repo-scoped
  // and normalized, so a glob-shaped name is the only exposure.
  const ignored = runGit(projectRoot, ['check-ignore', '-q', '--', path]).status === 0
  if (status === 'ignored') {
    if (ignored) return true
    const evidence = runGit(projectRoot, ['status', '--porcelain=v1', '--ignored=matching', '--untracked-files=all', '--', literalPathspec(path)]).stdout
    return evidence.split('\n').some((line) => line.startsWith('!! '))
  }
  if (ignored) return false
  const evidence = runGit(projectRoot, ['status', '--porcelain=v1', '--untracked-files=all', '--', literalPathspec(path)]).stdout
  return evidence.split('\n').some((line) => line.startsWith('?? '))
}

function isTracked(projectRoot: string, path: string): boolean {
  return runGit(projectRoot, ['ls-files', '--error-unmatch', '--', literalPathspec(path)]).status === 0
}

function inspectEligiblePath(input: {
  projectRoot: string
  worktreePath: string
  path: string
  sourceStatus: ExecutionSetupWorkspaceInputPayload['sourceStatus']
}): { fileCount: number; totalBytes: number } {
  const sourcePath = resolve(input.projectRoot, input.path)
  assertResolvedWithin(input.projectRoot, sourcePath, input.path)
  const stat = lstatSync(sourcePath)
  if (stat.isSymbolicLink()) throw new Error(`Workspace input contains a symbolic link: ${input.path}`)
  if (stat.isDirectory()) {
    return readdirSync(sourcePath).reduce(
      (total, child) => {
        const childResult = inspectEligiblePath({ ...input, path: `${input.path}/${child}` })
        return {
          fileCount: total.fileCount + childResult.fileCount,
          totalBytes: total.totalBytes + childResult.totalBytes,
        }
      },
      { fileCount: 0, totalBytes: 0 },
    )
  }
  if (
    !stat.isFile()
    || isTracked(input.projectRoot, input.path)
    || isTracked(input.worktreePath, input.path)
    || !sourceStatusMatches(input.projectRoot, input.path, input.sourceStatus)
  ) {
    return { fileCount: 0, totalBytes: 0 }
  }
  return { fileCount: 1, totalBytes: stat.size }
}

export function previewExecutionSetupWorkspaceInputs(input: {
  projectRoot: string
  worktreePath: string
  workspaceInputs: ExecutionSetupWorkspaceInputPayload[]
}): WorkspaceInputCopyPreview[] {
  const workspaceInputs = validateExecutionSetupWorkspaceInputs(input)
  return workspaceInputs.map((entry) => {
    const totals = inspectEligiblePath({
      projectRoot: input.projectRoot,
      worktreePath: input.worktreePath,
      path: entry.path,
      sourceStatus: entry.sourceStatus,
    })
    return {
      path: entry.path,
      ...totals,
      exceedsDefaultLimit:
        totals.fileCount > WORKSPACE_INPUT_DEFAULT_MAX_FILES
        || totals.totalBytes > WORKSPACE_INPUT_DEFAULT_MAX_BYTES,
    }
  })
}

export function validateExecutionSetupWorkspaceInputs(input: {
  projectRoot: string
  worktreePath: string
  workspaceInputs: ExecutionSetupWorkspaceInputPayload[]
}): ExecutionSetupWorkspaceInputPayload[] {
  const seen = new Set<string>()
  const validated = input.workspaceInputs.map((entry) => {
    const path = assertSafeWorkspaceInputPath(entry.path)
    if (seen.has(path)) throw new Error(`Workspace input path is duplicated: ${path}`)
    seen.add(path)

    const sourcePath = resolve(input.projectRoot, path)
    const destinationPath = resolve(input.worktreePath, path)
    if (!isWithin(input.projectRoot, sourcePath) || !isWithin(input.worktreePath, destinationPath)) {
      throw new Error(`Workspace input path escapes the project: ${path}`)
    }
    if (!existsSync(sourcePath)) throw new Error(`Workspace input does not exist in the original checkout: ${path}`)
    assertResolvedWithin(input.projectRoot, sourcePath, path)
    assertResolvedWithin(input.worktreePath, destinationPath, path)
    const stat = lstatSync(sourcePath)
    if (stat.isSymbolicLink()) throw new Error(`Workspace input cannot be a symbolic link: ${path}`)
    if (entry.kind === 'file' && !stat.isFile()) throw new Error(`Workspace input is not a file: ${path}`)
    if (entry.kind === 'directory' && !stat.isDirectory()) throw new Error(`Workspace input is not a directory: ${path}`)
    if (!entry.reason.trim()) throw new Error(`Workspace input requires a reason: ${path}`)
    if (!sourceStatusMatches(input.projectRoot, path, entry.sourceStatus)) {
      throw new Error(`Workspace input is not ${entry.sourceStatus} in the original checkout: ${path}`)
    }
    return { ...entry, path, reason: entry.reason.trim() }
  })
  return validated.map((entry) => {
    const totals = inspectEligiblePath({
      projectRoot: input.projectRoot,
      worktreePath: input.worktreePath,
      path: entry.path,
      sourceStatus: entry.sourceStatus,
    })
    return {
      ...entry,
      fileCount: totals.fileCount,
      totalBytes: totals.totalBytes,
    }
  })
}

function copyEligiblePath(input: {
  projectRoot: string
  worktreePath: string
  path: string
  sourceStatus: ExecutionSetupWorkspaceInputPayload['sourceStatus']
}): number {
  const sourcePath = resolve(input.projectRoot, input.path)
  const destinationPath = resolve(input.worktreePath, input.path)
  assertResolvedWithin(input.projectRoot, sourcePath, input.path)
  assertResolvedWithin(input.worktreePath, destinationPath, input.path)
  const stat = lstatSync(sourcePath)
  if (stat.isSymbolicLink()) throw new Error(`Workspace input contains a symbolic link: ${input.path}`)

  if (stat.isDirectory()) {
    let copied = 0
    for (const child of readdirSync(sourcePath)) {
      const childPath = `${input.path}/${child}`
      copied += copyEligiblePath({ ...input, path: childPath })
    }
    if (copied === 0 && sourceStatusMatches(input.projectRoot, input.path, input.sourceStatus)) {
      mkdirSync(destinationPath, { recursive: true })
    }
    return copied
  }

  if (!stat.isFile()) return 0
  if (isTracked(input.projectRoot, input.path) || isTracked(input.worktreePath, input.path)) return 0
  if (!sourceStatusMatches(input.projectRoot, input.path, input.sourceStatus)) return 0
  mkdirSync(dirname(destinationPath), { recursive: true })
  copyFileSync(sourcePath, destinationPath)
  return 1
}

export function materializeExecutionSetupWorkspaceInputs(input: {
  projectRoot: string
  worktreePath: string
  workspaceInputs: ExecutionSetupWorkspaceInputPayload[]
}): { copiedPaths: string[]; previews: WorkspaceInputCopyPreview[] } {
  const workspaceInputs = validateExecutionSetupWorkspaceInputs(input)
  const previews = previewExecutionSetupWorkspaceInputs({ ...input, workspaceInputs })
  const copiedPaths: string[] = []
  for (const [index, entry] of workspaceInputs.entries()) {
    const preview = previews[index]
    if (preview?.exceedsDefaultLimit && !entry.allowLargeCopy) {
      const sizeMiB = (preview.totalBytes / (1024 * 1024)).toFixed(1)
      throw new Error(
        `Workspace input ${entry.path} contains ${preview.fileCount} files (${sizeMiB} MiB), `
        + 'which exceeds the default copy limit. Review the preview and explicitly allow the large copy to continue.',
      )
    }
    const copied = copyEligiblePath({
      projectRoot: input.projectRoot,
      worktreePath: input.worktreePath,
      path: entry.path,
      sourceStatus: entry.sourceStatus,
    })
    if (copied > 0 || entry.kind === 'directory') copiedPaths.push(entry.path)
  }
  return { copiedPaths, previews }
}
