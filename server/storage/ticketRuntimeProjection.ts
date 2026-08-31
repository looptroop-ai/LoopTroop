import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { isTerminalWorkflowStatus } from '@shared/workflowMeta'
import { safeAtomicWrite } from '../io/atomicWrite'
import { getTicketByRef, getTicketPaths, listTickets, type PublicTicket } from './ticketQueries'

function getRuntimeStatePath(ticket: PublicTicket): string | null {
  const paths = getTicketPaths(ticket.id)
  return paths ? resolve(paths.ticketDir, 'runtime', 'state.yaml') : null
}

function buildRuntimeProjection(ticket: PublicTicket) {
  return {
    ticket: {
      id: ticket.id,
      externalId: ticket.externalId,
      title: ticket.title,
      status: ticket.status,
      completionDisposition: ticket.completionDisposition,
      previousStatus: ticket.previousStatus ?? null,
      errorMessage: ticket.errorMessage ?? null,
      updatedAt: ticket.updatedAt,
    },
    runtime: {
      baseBranch: ticket.runtime.baseBranch,
      currentBead: ticket.runtime.currentBead,
      completedBeads: ticket.runtime.completedBeads,
      totalBeads: ticket.runtime.totalBeads,
      percentComplete: ticket.runtime.percentComplete,
      maxIterationsPerBead: ticket.runtime.maxIterationsPerBead,
      activeBeadId: ticket.runtime.activeBeadId,
      activeBeadIteration: ticket.runtime.activeBeadIteration,
      lastFailedBeadId: ticket.runtime.lastFailedBeadId,
      candidateCommitSha: ticket.runtime.candidateCommitSha,
      preSquashHead: ticket.runtime.preSquashHead,
      finalTestStatus: ticket.runtime.finalTestStatus,
      prNumber: ticket.runtime.prNumber,
      prUrl: ticket.runtime.prUrl,
      prState: ticket.runtime.prState,
      prHeadSha: ticket.runtime.prHeadSha,
      eta: ticket.runtime.eta,
    },
    availableActions: ticket.availableActions,
    beads: (ticket.runtime.beads ?? []).map((bead) => ({
      id: bead.id,
      title: bead.title,
      status: bead.status,
      iteration: bead.iteration,
      failedIterationNotes: bead.failedIterationNotes ?? [],
      userRetryNotes: bead.userRetryNotes ?? [],
      finalizationFailureNotes: bead.finalizationFailureNotes ?? [],
      startedAt: bead.startedAt ?? null,
      updatedAt: bead.updatedAt ?? null,
    })),
  }
}

export function syncTicketRuntimeProjection(ticketOrRef: PublicTicket | string): void {
  const ticket = typeof ticketOrRef === 'string' ? getTicketByRef(ticketOrRef) : ticketOrRef
  if (!ticket) return

  const statePath = getRuntimeStatePath(ticket)
  if (!statePath) return

  if (isTerminalWorkflowStatus(ticket.status)) {
    rmSync(statePath, { force: true })
    return
  }

  safeAtomicWrite(statePath, yaml.dump(buildRuntimeProjection(ticket), {
    noRefs: true,
    lineWidth: 120,
    sortKeys: false,
  }))
}

export function rebuildTicketRuntimeProjections(): number {
  const tickets = listTickets()
  for (const ticket of tickets) {
    syncTicketRuntimeProjection(ticket)
  }
  return tickets.length
}
