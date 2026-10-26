import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_VERSION } from '../../lib/appVersion'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const mocks = vi.hoisted(() => ({
  getTicketByRef: vi.fn(),
  getTicketContext: vi.fn(),
  getTicketPaths: vi.fn(),
  listTickets: vi.fn(),
  listProjects: vi.fn(),
  listPhaseArtifacts: vi.fn(),
  listPhaseAttempts: vi.fn(),
  queryLogPage: vi.fn(),
  opendir: vi.fn(),
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, opendir: mocks.opendir }
})

vi.mock('../../storage/ticketQueries', () => ({
  getTicketByRef: mocks.getTicketByRef,
  getTicketContext: mocks.getTicketContext,
  getTicketPaths: mocks.getTicketPaths,
  listTickets: mocks.listTickets,
}))
vi.mock('../../storage/projects', () => ({ listProjects: mocks.listProjects }))
vi.mock('../../storage/ticketArtifacts', () => ({ listPhaseArtifacts: mocks.listPhaseArtifacts }))
vi.mock('../../storage/ticketPhaseAttempts', () => ({ listPhaseAttempts: mocks.listPhaseAttempts }))
vi.mock('../../log/projection', () => ({
  queryLogPage: mocks.queryLogPage,
  isHistoricalLogCursorExpiredError: (error: unknown) => (
    !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'LOG_CURSOR_EXPIRED'
  ),
}))

type EvidenceFunction = typeof import('../evidence').prepareAssistantEvidence
type FixtureTicket = Record<string, unknown> & { id: string; projectId: number }

const temporaryRoots: string[] = []
let prepareAssistantEvidence: EvidenceFunction
let ticketMap: Map<string, FixtureTicket>
let contextMap: Map<string, Record<string, unknown>>
let fetchMock: ReturnType<typeof vi.fn>

function makeTicket(id: string, projectId: number, fields: Record<string, unknown> = {}): FixtureTicket {
  return {
    id,
    projectId,
    title: `Ticket ${id}`,
    description: 'Implement the saved request.',
    status: 'CODING',
    priority: 2,
    branchName: 'feature/example',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    startedAt: '2026-01-01T01:00:00.000Z',
    plannedDate: null,
    currentBead: 1,
    totalBeads: 1,
    percentComplete: 0,
    errorMessage: null,
    cancelReason: null,
    errorOccurrences: [{ errorMessage: 'Authorization: Bearer abcdef0123456789', occurrenceNumber: 1 }],
    lockedMainImplementer: 'provider/model',
    lockedMainImplementerVariant: null,
    lockedCouncilMembers: ['provider/model'],
    lockedCouncilMemberVariants: null,
    lockedInterviewQuestions: 3,
    lockedCoverageFollowUpBudgetPercent: 10,
    lockedMaxCoveragePasses: 2,
    lockedMaxPrdCoveragePasses: 2,
    lockedMaxBeadsCoveragePasses: 2,
    lockedStructuredRetryCount: 1,
    effectiveManualQaEnabled: false,
    effectiveAiQuestionsEnabled: true,
    effectiveAiQuestionWindow: 60_000,
    effectiveGitHookPolicy: 'default',
    runtime: {
      maxIterations: 5,
      perIterationTimeoutMs: 60_000,
      executionSetupTimeoutMs: 30_000,
      beads: [{
        id: 'B-1', title: 'Implement', status: 'in_progress', iteration: 1,
        targetFiles: ['src/main.zig'], failedIterationNotes: [], userRetryNotes: [], finalizationFailureNotes: [],
      }],
      completedBeads: 0,
      iterationCount: 1,
      activeBeadId: 'B-1',
      activeBeadIteration: 1,
      lastFailedBeadId: null,
      finalTestStatus: 'pending',
      prNumber: null,
      prUrl: null,
      prState: null,
    },
    ...fields,
  }
}

async function fixture(): Promise<{ root: string; cwd: string; projectRoot: string }> {
  const root = makeTempDir('looptroop-assistant-evidence-')
  temporaryRoots.push(root)
  const cwd = join(root, 'context')
  const projectRoot = join(root, 'project')
  await Promise.all([mkdir(cwd), mkdir(projectRoot)])
  return { root, cwd, projectRoot }
}

function attachTicket(ticket: FixtureTicket, projectRoot: string, worktreePath?: string): void {
  ticketMap.set(ticket.id, ticket)
  contextMap.set(ticket.id, {
    ticketRef: ticket.id,
    projectId: ticket.projectId,
    projectRoot,
    localProject: { id: ticket.projectId, name: `Project ${ticket.projectId}`, shortname: `P${ticket.projectId}` },
  })
  if (worktreePath) mocks.getTicketPaths.mockReturnValue({ worktreePath })
}

function installOfflineFetch(): void {
  fetchMock = vi.fn(async () => { throw new Error('offline') })
  vi.stubGlobal('fetch', fetchMock)
}

beforeEach(async () => {
  vi.resetAllMocks()
  vi.resetModules()
  const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const originalOpendir = actualFsPromises.opendir.bind(actualFsPromises)
  mocks.opendir.mockImplementation((...args: Parameters<typeof actualFsPromises.opendir>) => originalOpendir(...args))
  ticketMap = new Map()
  contextMap = new Map()
  mocks.getTicketByRef.mockImplementation((id: string) => ticketMap.get(id))
  mocks.getTicketContext.mockImplementation((id: string) => contextMap.get(id))
  mocks.getTicketPaths.mockReturnValue(undefined)
  mocks.listTickets.mockReturnValue([])
  mocks.listProjects.mockReturnValue([])
  mocks.listPhaseArtifacts.mockReturnValue([])
  mocks.listPhaseAttempts.mockReturnValue([])
  mocks.queryLogPage.mockImplementation(async () => ({ entries: [], hasOlder: false, olderCursor: null }))
  installOfflineFetch()
  prepareAssistantEvidence = (await import('../evidence')).prepareAssistantEvidence
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of temporaryRoots.splice(0)) removeTempDir(root)
})

describe('assistant evidence workspace', () => {
  it('writes one validated ticket, all paged log views, archived planning, sanitized source, and a safe worktree copy', async () => {
    const { cwd, projectRoot } = await fixture()
    await mkdir(join(projectRoot, 'src'), { recursive: true })
    await writeFile(join(projectRoot, 'src', 'root-only.zig'), 'attached checkout')
    await writeFile(join(projectRoot, '.env'), 'password=env-secret')
    await writeFile(join(projectRoot, '.git'), 'repository metadata')
    await writeFile(join(projectRoot, 'secrets.json'), 'token=private-secret')

    const worktreePath = join(projectRoot, '.looptroop', 'worktrees', 'T-1')
    await mkdir(join(worktreePath, 'src'), { recursive: true })
    await writeFile(join(worktreePath, '.git'), 'gitdir: private')
    await writeFile(join(worktreePath, '.env.local'), 'password=worktree-secret')
    await writeFile(join(worktreePath, 'src', 'main.zig'), 'Authorization: Bearer abcdefghijklmnop')
    const outside = join(cwd, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'escape.zig'), 'external-secret')
    await symlink(outside, join(worktreePath, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    const ticket = makeTicket('7:T-1', 7, {
      description: 'Authorization: Bearer abcdefghijklmnop',
    })
    attachTicket(ticket, projectRoot, worktreePath)
    mocks.listPhaseAttempts.mockImplementation((_id: string, phase: string) => phase === 'DRAFTING_PRD'
      ? [
          { phase, attemptNumber: 1, state: 'archived', archivedReason: 'retry' },
          { phase, attemptNumber: 2, state: 'active', archivedReason: null },
        ]
      : [])
    mocks.listPhaseArtifacts.mockImplementation((_id: string, options: { phase: string; phaseAttempt: number }) => (
      options.phase === 'DRAFTING_PRD'
        ? [{ phase: options.phase, phaseAttempt: options.phaseAttempt, content: `plan-${options.phaseAttempt}` }]
        : []
    ))
    mocks.queryLogPage.mockImplementation(async (_id: string, query: { view: string; before?: string }) => {
      if (query.view === 'system') return query.before
        ? { entries: [{ phase: 'CODING', phaseAttempt: 1, content: 'old log', api_key: 'older-secret' }], hasOlder: false, olderCursor: null }
        : { entries: [{ phase: 'CODING', phaseAttempt: 2, content: 'new log' }], hasOlder: true, olderCursor: 'older-page' }
      if (query.view === 'debug') return {
        entries: [{ phase: 'CODING', phaseAttempt: 2, content: 'native OpenCode entry' }], hasOlder: false, olderCursor: null,
      }
      return { entries: [], hasOlder: false, olderCursor: null }
    })

    const { prompt, permission } = await prepareAssistantEvidence(
      { mode: 'tickets', ticketId: ticket.id }, cwd, undefined, 'inspect https://untrusted.example/worktree',
    )
    const evidence = join(cwd, 'evidence')
    const manifest = JSON.parse(await readFile(join(evidence, 'manifest.json'), 'utf8'))
    const ticketFolder = manifest.tickets[0].folder as string
    const ticketFile = JSON.parse(await readFile(join(evidence, manifest.tickets[0].path), 'utf8'))
    const projectIndex = await readFile(join(evidence, manifest.projects[0].sourceIndex), 'utf8')
    const sourceDir = join(evidence, 'projects', '7', 'source')
    const files = await readdir(join(sourceDir, 'src'))

    expect(manifest.scope).toEqual({ kind: 'ticket', ticketId: ticket.id })
    expect(manifest.officialDocs.unavailable).toHaveLength(25)
    expect(manifest.installedSource.status).toBe('unavailable')
    expect(manifest.tickets).toHaveLength(1)
    expect(manifest.projects).toMatchObject([{ id: 7, sourceKind: 'ticket worktree' }])
    expect(existsSync(join(sourceDir, 'src', 'root-only.zig'))).toBe(false)
    expect(files).toContain('main.zig')
    expect(files).not.toContain('linked')
    expect(await readFile(join(sourceDir, 'src', 'main.zig'), 'utf8')).not.toContain('abcdefghijklmnop')
    expect(projectIndex).toContain('symlink')
    expect(projectIndex).toContain('secret_path')
    expect(existsSync(join(sourceDir, '.env.local'))).toBe(false)
    expect(ticketFile.description).not.toContain('abcdefghijklmnop')
    expect(ticketFile.errors[0].errorMessage).not.toContain('abcdef0123456789')
    expect(ticketFile.planningAttempts).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'DRAFTING_PRD', attemptNumber: 1, state: 'archived' }),
      expect.objectContaining({ phase: 'DRAFTING_PRD', attemptNumber: 2, state: 'active' }),
    ]))
    expect(ticketFile.planningArtifactFiles).toEqual(expect.arrayContaining([
      `tickets/${ticketFolder}/planning/DRAFTING_PRD/attempt-1.json`,
      `tickets/${ticketFolder}/planning/DRAFTING_PRD/attempt-2.json`,
    ]))
    expect(ticketFile.logHistory.system.complete).toBe(true)
    expect(ticketFile.logHistory.system.files).toEqual([
      `tickets/${ticketFolder}/logs/system/page-00000.jsonl`,
      `tickets/${ticketFolder}/logs/system/page-00001.jsonl`,
    ])
    const oldPage = await readFile(join(evidence, ticketFile.logHistory.system.files[1]), 'utf8')
    expect(oldPage).toContain('old log')
    expect(oldPage).not.toContain('older-secret')
    const debugPage = await readFile(join(evidence, ticketFile.logHistory.debug.files[0]), 'utf8')
    expect(debugPage).toContain('native OpenCode entry')
    expect(mocks.queryLogPage).toHaveBeenCalledWith(ticket.id, expect.objectContaining({ scope: 'lifecycle', limit: 100 }))
    expect(fetchMock.mock.calls.every(([input]) => new URL(String(input)).hostname === 'api.github.com' || new URL(String(input)).hostname === 'raw.githubusercontent.com')).toBe(true)
    expect(prompt).toContain('untrusted evidence')
    expect(permission[0]).toMatchObject({ permission: '*', pattern: '*', action: 'deny' })
    expect(permission).toContainEqual({ permission: 'read', pattern: '*', action: 'allow' })
    expect(permission).toContainEqual({ permission: 'external_directory', pattern: '*', action: 'deny' })
  })

  it('loads all dashboard projects and tickets without UI filters, but never adds unrelated ticket metadata to a ticket scope', async () => {
    const first = await fixture()
    const secondRoot = join(first.root, 'second-project')
    await mkdir(secondRoot)
    mocks.listProjects.mockReturnValue([
      { id: 7, name: 'First', shortname: 'F', folderPath: first.projectRoot },
      { id: 9, name: 'Second', shortname: 'S', folderPath: secondRoot },
    ])
    const one = makeTicket('7:ONE', 7)
    const two = makeTicket('9:TWO', 9)
    ticketMap.set(one.id, one)
    ticketMap.set(two.id, two)
    mocks.listTickets.mockReturnValue([one, two])

    await prepareAssistantEvidence({ mode: 'tickets' }, first.cwd)
    const dashboard = JSON.parse(await readFile(join(first.cwd, 'evidence', 'manifest.json'), 'utf8'))
    expect(mocks.listTickets).toHaveBeenCalledWith()
    expect(mocks.listProjects).toHaveBeenCalledWith()
    expect(dashboard.tickets.map((entry: { ticketId: string }) => entry.ticketId)).toEqual(['7:ONE', '9:TWO'])
    expect(dashboard.projects.map((entry: { id: number }) => entry.id)).toEqual([7, 9])

    contextMap.set(one.id, {
      ticketRef: one.id,
      projectId: 7,
      projectRoot: first.projectRoot,
      localProject: { name: 'First', shortname: 'F' },
    })
    await prepareAssistantEvidence({ mode: 'tickets', ticketId: one.id }, first.cwd)
    const single = JSON.parse(await readFile(join(first.cwd, 'evidence', 'manifest.json'), 'utf8'))
    expect(single.tickets.map((entry: { ticketId: string }) => entry.ticketId)).toEqual(['7:ONE'])
    expect(single.projects.map((entry: { id: number }) => entry.id)).toEqual([7])
  })

  it('uses current website main docs and caches only immutable installed-version source', async () => {
    const { cwd } = await fixture()
    const entries = [
      { path: 'README.md', type: 'blob', size: 20 },
      { path: 'CHANGELOG.md', type: 'blob', size: 20 },
      { path: 'server/ticket/history.zig', type: 'blob', size: 20 },
      { path: 'server/auth/config.ts', type: 'blob', size: 20 },
    ]
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.hostname === 'api.github.com') return new Response(JSON.stringify({ tree: entries, truncated: false }))
      if (url.hostname === 'raw.githubusercontent.com' && url.pathname.includes('/LoopTroop-Website/main/')) {
        return new Response(`current docs ${url.pathname}`)
      }
      return new Response(`release source ${url.pathname}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    await prepareAssistantEvidence({ mode: 'help' }, cwd, undefined, 'ticket history behavior')
    const firstCount = fetchMock.mock.calls.length
    const firstManifest = JSON.parse(await readFile(join(cwd, 'evidence', 'manifest.json'), 'utf8'))
    expect(firstManifest.officialDocs.branch).toBe('main')
    expect(Object.values(firstManifest.officialDocs.links).every((url: unknown) => String(url).includes('/LoopTroop-Website/blob/main/docs/'))).toBe(true)
    expect(firstManifest.installedSource.tag).toBe(`v${APP_VERSION}`)
    expect(firstManifest.installedSource.includedPaths).toContain('server/ticket/history.zig')
    expect(await readFile(join(cwd, 'evidence', 'official-docs', 'configuration.md'), 'utf8')).toContain('current docs')
    expect(mocks.listProjects).not.toHaveBeenCalled()
    expect(mocks.listTickets).not.toHaveBeenCalled()

    await prepareAssistantEvidence({ mode: 'help' }, cwd, undefined, 'ticket history behavior')
    const urls = fetchMock.mock.calls.slice(firstCount).map(([input]) => new URL(String(input)))
    expect(urls).toHaveLength(Object.keys(firstManifest.officialDocs.links).length)
    expect(urls.every(url => url.pathname.includes('/LoopTroop-Website/main/docs/'))).toBe(true)
    expect(urls.some(url => url.pathname.includes(`/LoopTroop/v${APP_VERSION}/`))).toBe(false)
  })

  it('bounds project snapshots by total bytes and per-file size', async () => {
    const { cwd, projectRoot } = await fixture()
    const ticket = makeTicket('7:BUDGET', 7)
    attachTicket(ticket, projectRoot)
    const secondProjectRoot = join(cwd, 'second-project')
    await mkdir(secondProjectRoot)
    const secondTicket = makeTicket('8:SECOND', 8)
    mocks.listProjects.mockReturnValue([
      { id: 7, name: 'First', shortname: 'F', folderPath: projectRoot },
      { id: 8, name: 'Second', shortname: 'S', folderPath: secondProjectRoot },
    ])
    mocks.listTickets.mockReturnValue([ticket, secondTicket])
    const sourceChunk = 'x'.repeat(512 * 1024)
    await Promise.all(Array.from({ length: 25 }, (_, index) => (
      writeFile(join(projectRoot, `file-${String(index).padStart(2, '0')}.zig`), sourceChunk)
    )))
    await writeFile(join(projectRoot, 'oversized.zig'), `${sourceChunk}x`)
    await writeFile(join(secondProjectRoot, 'project.zig'), 'second project source')

    await prepareAssistantEvidence({ mode: 'tickets' }, cwd)
    const manifest = JSON.parse(await readFile(join(cwd, 'evidence', 'manifest.json'), 'utf8'))
    const firstProject = manifest.projects.find((project: { id: number }) => project.id === 7)
    const secondProject = manifest.projects.find((project: { id: number }) => project.id === 8)
    expect(firstProject.copiedBytes).toBe(12 * 1024 * 1024)
    expect(firstProject.copiedFileCount).toBe(24)
    expect(firstProject.omissions.scope_file_or_byte_limit).toBeGreaterThan(0)
    expect(secondProject.copiedFileCount).toBe(1)
    expect(await readFile(join(cwd, 'evidence', 'projects', '8', 'source', 'project.zig'), 'utf8')).toBe('second project source')
    expect(manifest.coverage.localSourceBudget.perProject).toMatchObject({ files: 1200, bytes: 12 * 1024 * 1024, entriesWalked: 50000 })
    expect(manifest.coverage.localSourceBudget.total).toMatchObject({ files: 25, bytes: 12 * 1024 * 1024 + 21 })
    expect(manifest.coverage.localSourceBudget.total.entriesWalked).toBe(
      manifest.projects.reduce((total: number, project: { entriesWalked: number }) => total + project.entriesWalked, 0),
    )

    const oversizedProject = join(cwd, 'small-project')
    await mkdir(oversizedProject)
    await writeFile(join(oversizedProject, 'oversized.zig'), `${sourceChunk}x`)
    await writeFile(join(oversizedProject, 'kept.zig'), 'small source')
    const oversizedTicket = makeTicket('8:OVERSIZED', 8)
    attachTicket(oversizedTicket, oversizedProject)
    await prepareAssistantEvidence({ mode: 'tickets', ticketId: oversizedTicket.id }, cwd)
    const secondManifest = JSON.parse(await readFile(join(cwd, 'evidence', 'manifest.json'), 'utf8'))
    expect(secondManifest.projects[0].copiedFileCount).toBe(1)
    expect(secondManifest.projects[0].omissions.per_file_size_limit).toBe(1)
    expect(secondManifest.projects[0].limit).toContain('512 KiB per file')
  })

  it('does not traverse a queued directory replaced with an external symlink', async () => {
    const { root, cwd, projectRoot } = await fixture()
    const queuedDirectory = join(projectRoot, 'queued')
    const outside = join(root, 'outside')
    await mkdir(queuedDirectory)
    await mkdir(outside)
    await writeFile(join(queuedDirectory, 'ordinary.zig'), 'in-project source')
    await writeFile(join(outside, 'ordinary.zig'), 'external ordinary-name secret')
    const ticket = makeTicket('7:SWAP', 7)
    attachTicket(ticket, projectRoot)

    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const originalOpendir = actualFsPromises.opendir.bind(actualFsPromises)
    mocks.opendir.mockImplementation(async (path: Parameters<typeof actualFsPromises.opendir>[0], options: Parameters<typeof actualFsPromises.opendir>[1]) => {
      const directory = await originalOpendir(path, options)
      if (String(path) !== projectRoot) return directory
      return {
        close: () => directory.close(),
        async *[Symbol.asyncIterator]() {
          for await (const entry of directory) yield entry
          await rm(queuedDirectory, { recursive: true, force: true })
          await symlink(outside, queuedDirectory, process.platform === 'win32' ? 'junction' : 'dir')
        },
      } as Awaited<ReturnType<typeof actualFsPromises.opendir>>
    })

    await prepareAssistantEvidence({ mode: 'tickets', ticketId: ticket.id }, cwd)
    const evidence = join(cwd, 'evidence')
    const manifest = JSON.parse(await readFile(join(evidence, 'manifest.json'), 'utf8'))
    const sourceFiles: string[] = []
    async function collectFiles(path: string): Promise<void> {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const child = join(path, entry.name)
        if (entry.isDirectory()) await collectFiles(child)
        else sourceFiles.push(await readFile(child, 'utf8'))
      }
    }
    await collectFiles(evidence)

    expect(mocks.opendir.mock.calls.some(([path]) => String(path) === projectRoot)).toBe(true)
    expect(existsSync(queuedDirectory)).toBe(true)
    expect(sourceFiles.join('\n')).not.toContain('external ordinary-name secret')
    expect(sourceFiles).not.toContain('in-project source')
    expect(manifest.projects[0].omissions.symlink).toBe(1)
  })

  it('stops copying source entries promptly when evidence preparation is aborted', async () => {
    const { cwd, projectRoot } = await fixture()
    await Promise.all(Array.from({ length: 20 }, (_, index) => (
      writeFile(join(projectRoot, `source-${index}.zig`), `source ${index}`)
    )))
    const ticket = makeTicket('7:CANCEL', 7)
    attachTicket(ticket, projectRoot)
    const controller = new AbortController()
    const actualFsPromises = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const originalOpendir = actualFsPromises.opendir.bind(actualFsPromises)
    mocks.opendir.mockImplementation(async (
      path: Parameters<typeof actualFsPromises.opendir>[0],
      options: Parameters<typeof actualFsPromises.opendir>[1],
    ) => {
      const directory = await originalOpendir(path, options)
      if (String(path) !== projectRoot) return directory
      return {
        close: () => directory.close(),
        async *[Symbol.asyncIterator]() {
          let yielded = 0
          for await (const entry of directory) {
            if (yielded++ === 1) controller.abort(new Error('snapshot cancelled'))
            yield entry
          }
        },
      } as Awaited<ReturnType<typeof actualFsPromises.opendir>>
    })

    await expect(prepareAssistantEvidence({ mode: 'tickets', ticketId: ticket.id }, cwd, controller.signal))
      .rejects.toThrow('snapshot cancelled')

    expect(mocks.opendir.mock.calls.filter(([path]) => String(path) === projectRoot)).toHaveLength(1)
    expect(existsSync(join(cwd, 'evidence', 'manifest.json'))).toBe(false)
    const sourceDirectory = join(cwd, 'evidence', 'projects', '7', 'source')
    const copiedFiles = existsSync(sourceDirectory) ? await readdir(sourceDirectory) : []
    expect(copiedFiles.length).toBeLessThanOrEqual(1)
  })

  it('marks history incomplete when a ticket projection is unavailable and rejects invalid scopes before writing', async () => {
    const { cwd, projectRoot } = await fixture()
    const ticket = makeTicket('7:MISSING', 7)
    attachTicket(ticket, projectRoot)
    mocks.queryLogPage.mockResolvedValue(null)

    await expect(prepareAssistantEvidence({ mode: 'help', ticketId: ticket.id }, cwd)).rejects.toThrow('Help scope cannot include a ticket id')
    await expect(prepareAssistantEvidence({ mode: 'tickets', ticketId: 'not-a-ticket-ref' }, cwd)).rejects.toThrow('Ticket scope requires a valid ticket id')
    expect(existsSync(join(cwd, 'evidence'))).toBe(false)

    await prepareAssistantEvidence({ mode: 'tickets', ticketId: ticket.id }, cwd)
    const manifest = JSON.parse(await readFile(join(cwd, 'evidence', 'manifest.json'), 'utf8'))
    expect(Object.values(manifest.tickets[0].logs).every((view: { complete: boolean }) => !view.complete)).toBe(true)
    expect(manifest.coverage.gaps).toEqual(expect.arrayContaining([
      expect.objectContaining({ area: `logs: ${ticket.id}/system`, detail: 'ticket history projection is unavailable' }),
    ]))
  })
})
