import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../../test/integration'
import { getTicketPaths } from '../../../storage/tickets'
import { loadTicketDirContext } from '../ticketDirContext'
import type { TicketContext } from '../../../machines/types'

const repoManager = createTestRepoManager('ticket-dir-context-')

/**
 * What every phase calls before it does anything.
 *
 * The seventh module PR-13 split out of `helpers.ts`, and the one its handover
 * list left without tests. Both of its failure paths say "workspace not
 * initialized" and are the first thing a phase hits when a ticket's directory
 * is missing, so what they name is what an operator has to work from.
 */
describe('loadTicketDirContext', () => {
  beforeEach(() => {
    resetTestDb()
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('returns the worktree, the ticket directory and the stored ticket', async () => {
    const { context } = await createInitializedTestTicket(repoManager, { title: 'Dir context' })
    const paths = getTicketPaths(context.ticketId)!

    const loaded = loadTicketDirContext(context)

    expect(loaded.worktreePath).toBe(paths.worktreePath)
    expect(loaded.ticketDir).toBe(paths.ticketDir)
    // The stored local ticket, not the public ref-shaped one.
    expect(loaded.ticket.title).toBe('Dir context')
  })

  it('reads the relevant-files scan when the ticket has one', async () => {
    const { context } = await createInitializedTestTicket(repoManager, { title: 'With relevant files' })
    const paths = getTicketPaths(context.ticketId)!
    writeFileSync(join(paths.ticketDir, 'relevant-files.yaml'), 'files:\n  - path: src/app.ts\n', 'utf-8')

    expect(loadTicketDirContext(context).relevantFiles).toContain('src/app.ts')
  })

  it('leaves the scan undefined rather than empty when there is none', async () => {
    // A phase decides whether to prompt with it by whether it is there at all,
    // so an empty string and an absent file are different answers.
    const { context } = await createInitializedTestTicket(repoManager, { title: 'No relevant files' })

    expect(loadTicketDirContext(context).relevantFiles).toBeUndefined()
  })

  it('names the ticket when its workspace is not in the database', () => {
    const context = { ticketId: '1:GONE-1', externalId: 'GONE-1' } as TicketContext

    // The external id, not the internal one: it is what the operator sees.
    expect(() => loadTicketDirContext(context)).toThrow(/missing ticket context for GONE-1/)
  })

  it('names the ticket when its workspace has been removed from disk', async () => {
    const { context } = await createInitializedTestTicket(repoManager, { title: 'Deleted dir' })
    const paths = getTicketPaths(context.ticketId)!
    // The whole worktree, not just `.ticket`: resolving a ticket's base branch
    // writes its metadata back whenever the worktree is still there, so
    // deleting `.ticket` alone is undone by the next read of these paths.
    rmSync(paths.worktreePath, { recursive: true, force: true })
    expect(existsSync(paths.ticketDir)).toBe(false)

    // A different failure from the one above, and worth telling apart: the
    // ticket is known, its files are not there.
    expect(() => loadTicketDirContext(context)).toThrow(/missing ticket directory for/)
  })
})
