import type { DiagnosticCheck, PreFlightContext, PreFlightReport } from './types'
import type { OpenCodeAdapter } from '../../opencode/adapter'
import type { Bead } from '../beads/types'
import { existsSync } from 'fs'
import { findProjectExecutionBandConflict, getLatestPhaseArtifact, getTicketContext, getTicketPaths } from '../../storage/tickets'
import { throwIfAborted } from '../../council/types'
import { raceWithCancel, throwIfCancelled } from '../../lib/abort'
import { getRunnable } from '../execution/scheduler'
import { getCurrentBranch } from '../../git/repository'
import { buildExecutionBandConflictMessage } from '../../workflow/executionBand'
import {
  getGhAuthStatus,
  getGitHubRepoAccess,
  isGhInstalled,
  parseGitHubRemoteUrl,
  readOriginRemoteUrl,
} from '../../git/github'
import { fetchConnectedModelIds } from '../../opencode/providerCatalog'
import { buildPromptFromTemplate, PROM_EXECUTION_CAPABILITY_PROBE } from '../../prompts/index'
import { OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS } from '../../opencode/permissions'
import { resolveOpenCodePermissions } from '../../opencode/toolPolicy'
import { parseModelRef, type Session, type SessionErrorStreamEvent, type StreamEvent } from '../../opencode/types'
import { summarizeModelErrorForLog } from '../../opencode/errorDetails'
import { createOpenCodeSessionWithRetry } from '../../opencode/sessionCreation'
import {
  buildGeneratedNoiseWarning,
  buildWorktreeDirtyError,
  getExecutionSetupCommitExcludedRoots,
  summarizeWorktreeChanges,
} from '../../git/worktreeChanges'

export interface DoctorDeps {
  fileExists: (path: string) => boolean
  getTicketPaths: typeof getTicketPaths
  getCurrentBranch: typeof getCurrentBranch
  readOriginRemoteUrl: typeof readOriginRemoteUrl
  parseGitHubRemoteUrl: typeof parseGitHubRemoteUrl
  isGhInstalled: typeof isGhInstalled
  getGhAuthStatus: typeof getGhAuthStatus
  getGitHubRepoAccess: typeof getGitHubRepoAccess
  getLatestPhaseArtifact: typeof getLatestPhaseArtifact
  fetchConnectedModelIds: typeof fetchConnectedModelIds
  findExecutionBandConflict: (ticketId: string) => ReturnType<typeof findProjectExecutionBandConflict>
  getTicketExternalId?: (ticketId: string) => string | undefined
  getWorktreeChangeSummary: typeof summarizeWorktreeChanges
}

export interface PreFlightRunOptions {
  onOpenCodeStreamEvent?: (event: {
    session: Session
    modelId: string
    event: StreamEvent
  }) => void
}

export const defaultDoctorDeps: DoctorDeps = {
  fileExists: existsSync,
  getTicketPaths,
  getCurrentBranch,
  readOriginRemoteUrl,
  parseGitHubRemoteUrl,
  isGhInstalled,
  getGhAuthStatus,
  getGitHubRepoAccess,
  getLatestPhaseArtifact,
  fetchConnectedModelIds,
  findExecutionBandConflict: (ticketId: string) => {
    const ticket = getTicketContext(ticketId)
    return ticket ? findProjectExecutionBandConflict(ticket.projectId, ticket.ticketRef) : null
  },
  getTicketExternalId: (ticketId: string) => getTicketContext(ticketId)?.externalId,
  getWorktreeChangeSummary: summarizeWorktreeChanges,
}

async function runExecutionCapabilityProbe(
  adapter: OpenCodeAdapter,
  worktreePath: string,
  preFlightContext: PreFlightContext,
  signal?: AbortSignal,
  options: PreFlightRunOptions = {},
): Promise<void> {
  const modelId = preFlightContext.lockedMainImplementer
  if (!modelId) {
    throw new Error('No main implementer model configured')
  }

  const session = await raceWithCancel(
    createOpenCodeSessionWithRetry(adapter, worktreePath, signal, {
      permission: OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS,
    }),
    signal,
  )
  let sessionErrorEvent: SessionErrorStreamEvent | undefined
  const handleStreamEvent = (event: StreamEvent) => {
    if (event.type === 'session_error') {
      sessionErrorEvent = event
    }
    options.onOpenCodeStreamEvent?.({
      session,
      modelId,
      event,
    })
  }
  const throwSessionErrorIfPresent = () => {
    if (!sessionErrorEvent) return
    const summary = summarizeModelErrorForLog(sessionErrorEvent.details ?? sessionErrorEvent.error, sessionErrorEvent.error)
    throw new Error(summary.message)
  }
  try {
    let response: string
    try {
      response = await raceWithCancel(
        adapter.promptSession(
          session.id,
          [{ type: 'text', content: buildPromptFromTemplate(PROM_EXECUTION_CAPABILITY_PROBE, []) }],
          signal,
          {
            model: parseModelRef(modelId),
            variant: preFlightContext.lockedMainImplementerVariant ?? undefined,
            // The capability probe is a diagnostic, not a workflow step: it
            // checks that the model answers at all. It must never stop to ask.
            permission: resolveOpenCodePermissions(PROM_EXECUTION_CAPABILITY_PROBE.toolPolicy, false),
            autoApprovePermissions: true,
            onEvent: handleStreamEvent,
          },
        ),
        signal,
      )
    } catch (err) {
      throwSessionErrorIfPresent()
      throw err
    }
    throwSessionErrorIfPresent()
    if (response.trim() !== 'OK') {
      throw new Error(`Probe returned unexpected response: ${response.trim() || '<empty>'}`)
    }
  } finally {
    await adapter.abortSession(session.id).catch(() => false)
  }
}

export async function runPreFlightChecks(
  adapter: OpenCodeAdapter,
  ticketId: string,
  beads: Bead[],
  preFlightContext: PreFlightContext,
  signal?: AbortSignal,
  deps: DoctorDeps = defaultDoctorDeps,
  options: PreFlightRunOptions = {},
): Promise<PreFlightReport> {
  const checks: DiagnosticCheck[] = []

  // 1. OpenCode connectivity
  try {
    throwIfAborted(signal, ticketId)
    const health = await raceWithCancel(adapter.checkHealth(), signal, ticketId)
    throwIfAborted(signal, ticketId)
    checks.push({
      name: 'OpenCode Connectivity',
      category: 'connectivity',
      result: health.available ? 'pass' : 'fail',
      message: health.available ? 'OpenCode is reachable' : `OpenCode unreachable: ${health.error}`,
    })
  } catch (err) {
    throwIfCancelled(err, signal, ticketId)
    checks.push({
      name: 'OpenCode Connectivity',
      category: 'connectivity',
      result: 'fail',
      message: `OpenCode check failed: ${err instanceof Error ? err.message : 'Unknown'}`,
    })
  }

  // 2. Ticket directory exists
  const paths = deps.getTicketPaths(ticketId)
  const ticketDir = paths?.ticketDir
  checks.push({
    name: 'Ticket Directory',
    category: 'artifacts',
    result: ticketDir && deps.fileExists(ticketDir) ? 'pass' : 'fail',
    message: ticketDir && deps.fileExists(ticketDir) ? 'Ticket directory exists' : 'Ticket directory not found',
  })

  // 3. Relevant files artifact exists
  const relevantFiles = ticketDir ? `${ticketDir}/relevant-files.yaml` : null
  checks.push({
    name: 'Relevant Files',
    category: 'artifacts',
    result: relevantFiles && deps.fileExists(relevantFiles) ? 'pass' : 'warning',
    message: relevantFiles && deps.fileExists(relevantFiles) ? 'Relevant files artifact exists' : 'Relevant files artifact not found',
  })

  // 4. Beads validation
  if (beads.length === 0) {
    checks.push({
      name: 'Beads Available',
      category: 'config',
      result: 'fail',
      message: 'No beads to execute',
    })
  } else {
    checks.push({
      name: 'Beads Available',
      category: 'config',
      result: 'pass',
      message: `${beads.length} beads ready for execution`,
    })
  }

  // 5. Dependency graph integrity (dangling + self-deps)
  const beadIds = new Set(beads.map((b) => b.id))
  let graphValid = true
  for (const bead of beads) {
    for (const dep of bead.dependencies.blocked_by) {
      if (!beadIds.has(dep)) {
        graphValid = false
        checks.push({
          name: 'Dependency Graph',
          category: 'graph',
          result: 'fail',
          message: `Bead ${bead.id} has dangling blocked_by dependency: ${dep}`,
        })
      }
    }
    for (const dep of bead.dependencies.blocks) {
      if (!beadIds.has(dep)) {
        graphValid = false
        checks.push({
          name: 'Dependency Graph',
          category: 'graph',
          result: 'fail',
          message: `Bead ${bead.id} has dangling blocks dependency: ${dep}`,
        })
      }
    }
    if (bead.dependencies.blocked_by.includes(bead.id) || bead.dependencies.blocks.includes(bead.id)) {
      graphValid = false
      checks.push({
        name: 'Dependency Graph',
        category: 'graph',
        result: 'fail',
        message: `Bead ${bead.id} has self-dependency`,
      })
    }
  }

  // 6. Duplicate bead IDs
  if (beads.length > 0 && beadIds.size !== beads.length) {
    graphValid = false
    const seen = new Set<string>()
    for (const bead of beads) {
      if (seen.has(bead.id)) {
        checks.push({
          name: 'Dependency Graph',
          category: 'graph',
          result: 'fail',
          message: `Duplicate bead ID: ${bead.id}`,
        })
      }
      seen.add(bead.id)
    }
  }

  // 7. Circular dependency detection
  if (beads.length > 0 && graphValid) {
    const visited = new Set<string>()
    const recStack = new Set<string>()
    let hasCycleResult = false

    function detectCycle(beadId: string): boolean {
      visited.add(beadId)
      recStack.add(beadId)

      const bead = beads.find(b => b.id === beadId)
      if (bead) {
        for (const dep of bead.dependencies.blocked_by) {
          if (!visited.has(dep)) {
            if (detectCycle(dep)) return true
          } else if (recStack.has(dep)) {
            return true
          }
        }
      }

      recStack.delete(beadId)
      return false
    }

    for (const bead of beads) {
      if (!visited.has(bead.id)) {
        if (detectCycle(bead.id)) {
          hasCycleResult = true
          break
        }
      }
    }

    if (hasCycleResult) {
      graphValid = false
      checks.push({
        name: 'Dependency Graph',
        category: 'graph',
        result: 'fail',
        message: 'Circular dependency detected in bead graph',
      })
    }
  }

  // 8. Runnable bead exists (at least one bead can start immediately)
  if (beads.length > 0 && graphValid) {
    const runnable = getRunnable(beads)
    if (runnable.length === 0) {
      graphValid = false
      checks.push({
        name: 'Dependency Graph',
        category: 'graph',
        result: 'fail',
        message: 'No runnable bead found — all beads are blocked by dependencies',
      })
    }
  }

  if (graphValid && beads.length > 0) {
    checks.push({
      name: 'Dependency Graph',
      category: 'graph',
      result: 'pass',
      message: 'No dangling, circular, or duplicate dependencies detected',
    })
  }

  // 9. Git safety — verify worktree and branch
  if (paths?.worktreePath) {
    const worktreeExists = deps.fileExists(paths.worktreePath)
    if (!worktreeExists) {
      checks.push({
        name: 'Git Worktree',
        category: 'git',
        result: 'fail',
        message: 'Ticket worktree directory does not exist',
      })
    } else {
      try {
        const currentBranch = deps.getCurrentBranch(paths.worktreePath)
        if (currentBranch) {
          checks.push({
            name: 'Git Worktree',
            category: 'git',
            result: 'pass',
            message: `Worktree active on branch: ${currentBranch}`,
          })
        } else {
          checks.push({
            name: 'Git Worktree',
            category: 'git',
            result: 'fail',
            message: 'Worktree is in detached HEAD state',
          })
        }
      } catch {
        checks.push({
          name: 'Git Worktree',
          category: 'git',
          result: 'fail',
          message: 'Failed to inspect git worktree branch',
        })
      }
    }

    if (worktreeExists) {
      try {
        const changeSummary = deps.getWorktreeChangeSummary(paths.worktreePath, {
          setupExcludedRoots: getExecutionSetupCommitExcludedRoots(paths.worktreePath),
        })
        if (changeSummary.hasCommittableChanges) {
          checks.push({
            name: 'Worktree Cleanliness',
            category: 'git',
            result: 'fail',
            message: buildWorktreeDirtyError(changeSummary.committable.map(entry => entry.path)),
          })
        } else if (changeSummary.generatedNoise.length > 0) {
          checks.push({
            name: 'Worktree Cleanliness',
            category: 'git',
            result: 'warning',
            message: buildGeneratedNoiseWarning(changeSummary.generatedNoise),
          })
        } else {
          checks.push({
            name: 'Worktree Cleanliness',
            category: 'git',
            result: 'pass',
            message: 'No pre-existing project changes need committing before setup',
          })
        }
      } catch (err) {
        checks.push({
          name: 'Worktree Cleanliness',
          category: 'git',
          result: 'fail',
          message: `Failed to inspect worktree cleanliness: ${err instanceof Error ? err.message : 'Unknown error'}`,
        })
      }
    }
  } else {
    checks.push({
      name: 'Git Worktree',
      category: 'git',
      result: 'fail',
      message: 'Ticket paths not available — cannot verify worktree',
    })
  }

  // 10. GitHub origin remote
  if (paths?.worktreePath) {
    const remoteUrl = deps.readOriginRemoteUrl(paths.worktreePath)
    const githubRepo = deps.parseGitHubRemoteUrl(remoteUrl)
    checks.push({
      name: 'GitHub Remote',
      category: 'git',
      result: githubRepo ? 'pass' : 'fail',
      message: githubRepo
        ? `GitHub origin detected: ${githubRepo.slug}`
        : 'Origin remote must resolve to github.com',
    })

    // 11. GitHub CLI availability
    const ghInstalled = deps.isGhInstalled()
    checks.push({
      name: 'GitHub CLI',
      category: 'connectivity',
      result: ghInstalled ? 'pass' : 'fail',
      message: ghInstalled ? 'gh CLI is installed' : 'gh CLI is not installed',
    })

    // 12. GitHub auth
    const authStatus = ghInstalled ? await deps.getGhAuthStatus() : { ok: false as const, error: 'gh CLI is not installed' }
    checks.push({
      name: 'GitHub Auth',
      category: 'connectivity',
      result: authStatus.ok ? 'pass' : 'fail',
      message: authStatus.ok ? 'gh auth status passed' : `GitHub auth failed: ${authStatus.error}`,
    })

    // 13. GitHub repository access
    const repoAccess = ghInstalled && authStatus.ok
      ? await deps.getGitHubRepoAccess(paths.worktreePath)
      : { ok: false as const, error: 'GitHub auth is not ready' }
    checks.push({
      name: 'GitHub Repo Access',
      category: 'connectivity',
      result: repoAccess.ok ? 'pass' : 'fail',
      message: repoAccess.ok
        ? `GitHub repository access verified: ${repoAccess.repo.slug}`
        : `GitHub repository access failed: ${repoAccess.error}`,
    })
  } else {
    checks.push({
      name: 'GitHub Remote',
      category: 'git',
      result: 'fail',
      message: 'Ticket paths not available — cannot verify GitHub remote',
    })
    checks.push({
      name: 'GitHub CLI',
      category: 'connectivity',
      result: 'fail',
      message: 'Ticket paths not available — cannot verify gh CLI',
    })
    checks.push({
      name: 'GitHub Auth',
      category: 'connectivity',
      result: 'fail',
      message: 'Ticket paths not available — cannot verify GitHub auth',
    })
    checks.push({
      name: 'GitHub Repo Access',
      category: 'connectivity',
      result: 'fail',
      message: 'Ticket paths not available — cannot verify GitHub repository access',
    })
  }

  // 14. Beads approval receipt
  const approvalReceipt = deps.getLatestPhaseArtifact(ticketId, 'approval_receipt', 'WAITING_BEADS_APPROVAL')
  checks.push({
    name: 'Beads Approval',
    category: 'artifacts',
    result: approvalReceipt ? 'pass' : 'fail',
    message: approvalReceipt ? 'Beads approval receipt found' : 'Beads approval receipt not found',
  })

  // 15. Main implementer model reachability
  if (preFlightContext.lockedMainImplementer) {
    try {
      throwIfAborted(signal, ticketId)
      const connectedIds = await raceWithCancel(deps.fetchConnectedModelIds(), signal, ticketId)
      throwIfAborted(signal, ticketId)
      const connected = new Set(connectedIds)
      if (connected.has(preFlightContext.lockedMainImplementer)) {
        checks.push({
          name: 'Main Implementer Model',
          category: 'config',
          result: 'pass',
          message: `Model available: ${preFlightContext.lockedMainImplementer}`,
        })
      } else {
        checks.push({
          name: 'Main Implementer Model',
          category: 'config',
          result: 'fail',
          message: `Main implementer model not available in OpenCode: ${preFlightContext.lockedMainImplementer}`,
        })
      }
    } catch (err) {
      throwIfCancelled(err, signal, ticketId)
      checks.push({
        name: 'Main Implementer Model',
        category: 'config',
        result: 'fail',
        message: `Failed to verify model availability: ${err instanceof Error ? err.message : 'Unknown'}`,
      })
    }
  } else {
    checks.push({
      name: 'Main Implementer Model',
      category: 'config',
      result: 'fail',
      message: 'No main implementer model configured',
    })
  }

  // 16. OpenCode execution-band capability
  if (preFlightContext.lockedMainImplementer && paths?.worktreePath) {
    try {
      throwIfAborted(signal, ticketId)
      await runExecutionCapabilityProbe(adapter, paths.worktreePath, preFlightContext, signal, options)
      throwIfAborted(signal, ticketId)
      checks.push({
        name: 'OpenCode Execution Capability',
        category: 'connectivity',
        result: 'pass',
        message: 'Execution-mode session creation and read-only prompt probe succeeded',
      })
    } catch (err) {
      throwIfCancelled(err, signal, ticketId)
      checks.push({
        name: 'OpenCode Execution Capability',
        category: 'connectivity',
        result: 'fail',
        message: `Execution-mode probe failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      })
    }
  } else {
    checks.push({
      name: 'OpenCode Execution Capability',
      category: 'connectivity',
      result: 'fail',
      message: 'Execution-mode probe could not run because the worktree or main implementer was unavailable',
    })
  }

  // 17. Project execution exclusivity
  const executionConflict = deps.findExecutionBandConflict(ticketId)
  const blockedTicketExternalId = deps.getTicketExternalId?.(ticketId)
    ?? (ticketId.includes(':') ? ticketId.slice(ticketId.indexOf(':') + 1) : ticketId)
  checks.push({
    name: 'Project Execution Lock',
    category: 'config',
    result: executionConflict ? 'fail' : 'pass',
    message: executionConflict
      ? buildExecutionBandConflictMessage({ externalId: blockedTicketExternalId }, executionConflict)
      : 'No competing execution-band ticket found for this project',
  })

  // 18. Runtime safety budgets
  if (preFlightContext.maxIterations < 0) {
    checks.push({
      name: 'Runtime Budget',
      category: 'config',
      result: 'fail',
      message: `Invalid maxIterations: ${preFlightContext.maxIterations} (must be >= 0)`,
    })
  } else {
    checks.push({
      name: 'Runtime Budget',
      category: 'config',
      result: 'pass',
      message: preFlightContext.maxIterations === 0
        ? 'maxIterations: unlimited'
        : `maxIterations: ${preFlightContext.maxIterations}`,
    })
  }

  // Build report
  const criticalFailures = checks.filter((c) => c.result === 'fail')
  const warnings = checks.filter((c) => c.result === 'warning')

  return {
    passed: criticalFailures.length === 0,
    checks,
    criticalFailures,
    warnings,
  }
}
