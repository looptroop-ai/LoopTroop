import { createFixtureRepoManager } from './fixtureRepo'
import { initializeDatabase } from '../db/init'
import { sqlite } from '../db/index'
import { clearProjectDatabaseCache } from '../db/project'
import { attachProject } from '../storage/projects'
import { createTicket, getTicketPaths } from '../storage/tickets'
import { initializeTicket } from '../ticket/initialize'
import { TEST, makeTicketContextFromTicket } from './factories'

export function createTestRepoManager(prefix = 'test-') {
  return createFixtureRepoManager({
    templatePrefix: `looptroop-${prefix}`,
    files: { 'README.md': '# Test Repository\n' },
  })
}

export function resetTestDb() {
  clearProjectDatabaseCache()
  initializeDatabase()
  sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')
}

export function createUninitializedTestTicket(
  repoManager: ReturnType<typeof createTestRepoManager>,
  overrides: {
    projectName?: string
    shortname?: string
    title?: string
    description?: string
  } = {},
) {
  const repoDir = repoManager.createRepo()
  const project = attachProject({
    folderPath: repoDir,
    name: overrides.projectName ?? TEST.projectName,
    shortname: overrides.shortname ?? TEST.shortname,
  })
  const ticket = createTicket({
    projectId: project.id,
    title: overrides.title ?? 'Test ticket',
    description: overrides.description ?? 'Test description.',
  })

  const paths = getTicketPaths(ticket.id)
  if (!paths) throw new Error('Expected ticket paths after creation')

  return {
    ticket,
    context: makeTicketContextFromTicket(ticket),
    paths,
    repoDir,
    project,
  }
}

export async function createInitializedTestTicket(
  repoManager: ReturnType<typeof createTestRepoManager>,
  overrides: {
    projectName?: string
    shortname?: string
    title?: string
    description?: string
  } = {},
) {
  const setup = createUninitializedTestTicket(repoManager, overrides)

  await initializeTicket({
    projectFolder: setup.repoDir,
    externalId: setup.ticket.externalId,
  })

  const paths = getTicketPaths(setup.ticket.id)
  if (!paths) throw new Error('Expected ticket paths after initialization')

  return {
    ...setup,
    paths,
  }
}
