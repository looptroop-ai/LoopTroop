import { existsSync, rmSync } from 'fs'
import { resolve } from 'path'
import { getTicketPaths, resolveTicketContainedPath } from '../../storage/tickets'
import { makeOwnerWritableRecursive } from '../../io/removal'

export interface CleanupReport {
  status: 'clean' | 'warning'
  removedDirs: string[]
  removedFiles: string[]
  errors: string[]
  preservedPaths: string[]
}

export function cleanupTicketResources(ticketId: string): CleanupReport {
  const report: CleanupReport = {
    status: 'clean',
    removedDirs: [],
    removedFiles: [],
    errors: [],
    preservedPaths: [],
  }

  const paths = getTicketPaths(ticketId)
  if (!paths) {
    report.errors.push('Ticket directory not found')
    report.status = 'warning'
    return report
  }

  const ticketRoot = paths.worktreePath

  if (!existsSync(ticketRoot)) {
    report.errors.push('Ticket directory not found')
    report.status = 'warning'
    return report
  }

  // Remove transient runtime state but preserve audit/debug evidence.
  const runtimePaths = [
    'runtime/locks',
    'runtime/sessions',
    'runtime/streams',
    'runtime/tmp',
    'runtime/state.yaml',
    'runtime/execution-setup',
    'runtime/execution-setup-profile.json',
  ]

  for (const relativePath of runtimePaths) {
    try {
      // Delete the final entry, never the canonical destination of a contained alias.
      const targetPath = resolveTicketContainedPath(ticketId, relativePath, 'remove')
      if (targetPath && existsSync(targetPath)) {
        makeOwnerWritableRecursive(targetPath)
        rmSync(targetPath, { recursive: true, force: true })
        if (relativePath.endsWith('.yaml') || relativePath.endsWith('.json')) {
          report.removedFiles.push(targetPath)
        } else {
          report.removedDirs.push(targetPath)
        }
      }
    } catch (err) {
      report.errors.push(
        `Failed to remove ${relativePath}: ${err instanceof Error ? err.message : 'Unknown'}`,
      )
    }
  }

  // Preserve planning artifacts and the execution log needed for audit/debug history.
  const preservedArtifacts = [
    'meta/ticket.meta.json',
    'interview.yaml',
    'prd.yaml',
    'relevant-files.yaml',
    'runtime/execution-log.jsonl',
    'runtime/execution-log.debug.jsonl',
    'runtime/execution-log.ai.jsonl',
  ]
  for (const artifact of preservedArtifacts) {
    const path = resolve(ticketRoot, '.ticket', artifact)
    if (existsSync(path)) {
      report.preservedPaths.push(path)
    }
  }

  if (existsSync(paths.beadsPath)) {
    report.preservedPaths.push(paths.beadsPath)
  }

  report.status = report.errors.length > 0 ? 'warning' : 'clean'
  return report
}
