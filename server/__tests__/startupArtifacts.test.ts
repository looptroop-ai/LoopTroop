import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAtomicTmpPath } from '../io/atomicWrite'
import { RecoveryBlockedError } from '../io/recovery'
import { makeTempDir, removeTempDir } from '../test/tempDir'

const startupFixture = vi.hoisted(() => ({
  tickets: [] as Array<{ id: string }>,
  paths: null as Record<string, string> | null,
  initializeDatabase: vi.fn(),
  createIndexes: vi.fn(),
  startWalCheckpoint: vi.fn(),
  initializeStartupState: vi.fn(() => ({ storage: { dbPath: 'scratch' } })),
  formatStartupStorageSummary: vi.fn(() => 'scratch'),
  hydrateAllTickets: vi.fn(() => 0),
  rebuildTicketRuntimeProjections: vi.fn(() => 0),
  health: null as {
    available: boolean
    protocol?: 'v1' | 'v2'
    version?: string
    failureKind?: 'authentication' | 'unsupported_protocol' | 'network' | 'model_discovery'
    error?: string
  } | null,
}))

vi.mock('../storage/tickets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/tickets')>()
  return {
    ...actual,
    listTickets: vi.fn(() => startupFixture.tickets),
    getTicketPaths: vi.fn(() => startupFixture.paths),
  }
})
vi.mock('../db/init', async (importOriginal) => ({
  ...await importOriginal<typeof import('../db/init')>(),
  initializeDatabase: startupFixture.initializeDatabase,
}))
vi.mock('../db/index', async (importOriginal) => ({
  ...await importOriginal<typeof import('../db/index')>(),
  startWalCheckpoint: startupFixture.startWalCheckpoint,
}))
vi.mock('../db/indexes', async (importOriginal) => ({
  ...await importOriginal<typeof import('../db/indexes')>(),
  createIndexes: startupFixture.createIndexes,
}))
vi.mock('../opencode/factory', () => ({
  getOpenCodeAdapter: () => ({ checkHealth: async () => startupFixture.health ?? { available: true } }),
}))
vi.mock('../storage/projects', async (importOriginal) => ({
  ...await importOriginal<typeof import('../storage/projects')>(),
  listProjects: vi.fn(() => []),
}))
vi.mock('../startupState', async (importOriginal) => ({
  ...await importOriginal<typeof import('../startupState')>(),
  initializeStartupState: startupFixture.initializeStartupState,
  formatStartupStorageSummary: startupFixture.formatStartupStorageSummary,
}))
vi.mock('../machines/persistence', async (importOriginal) => ({
  ...await importOriginal<typeof import('../machines/persistence')>(),
  hydrateAllTickets: startupFixture.hydrateAllTickets,
}))
vi.mock('../storage/ticketRuntimeProjection', () => ({
  rebuildTicketRuntimeProjections: startupFixture.rebuildTicketRuntimeProjections,
}))

const roots: string[] = []

afterEach(() => {
  delete process.env.LOOPTROOP_CONFIG_DIR
  startupFixture.tickets.length = 0
  startupFixture.paths = null
  startupFixture.initializeDatabase.mockClear()
  startupFixture.createIndexes.mockClear()
  startupFixture.startWalCheckpoint.mockClear()
  startupFixture.initializeStartupState.mockClear()
  startupFixture.formatStartupStorageSummary.mockClear()
  startupFixture.hydrateAllTickets.mockClear()
  startupFixture.rebuildTicketRuntimeProjections.mockClear()
  startupFixture.health = null
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) removeTempDir(root)
})

describe('startup artifact recovery', () => {
  it('recovers a known config artifact while preserving unrelated temp content', async () => {
    const configDir = makeTempDir('looptroop-startup-artifacts-')
    roots.push(configDir)
    process.env.LOOPTROOP_CONFIG_DIR = configDir
    const target = join(configDir, 'config.json')
    const temp = makeAtomicTmpPath(target)
    mkdirSync(dirname(temp), { recursive: true })
    writeFileSync(temp, '{"port":4310}')
    const unrelatedTarget = join(configDir, 'operator-notes.txt')
    const unrelatedTemp = makeAtomicTmpPath(unrelatedTarget)
    writeFileSync(unrelatedTemp, 'keep this user content')

    const { recoverTicketRuntimeArtifacts } = await import('../startup')
    const result = recoverTicketRuntimeArtifacts()

    expect(result.recoveredTmpFiles).toBe(1)
    expect(readFileSync(target, 'utf8')).toBe('{"port":4310}')
    expect(existsSync(temp)).toBe(false)
    expect(existsSync(unrelatedTemp)).toBe(true)
    expect(existsSync(unrelatedTarget)).toBe(false)
  }, 30_000)

  it('blocks real startup before projections or hydration on every boot with an unresolved generation', async () => {
    const configDir = makeTempDir('looptroop-startup-blocked-config-')
    const ticketDir = makeTempDir('looptroop-startup-blocked-ticket-')
    roots.push(configDir, ticketDir)
    process.env.LOOPTROOP_CONFIG_DIR = configDir

    const target = join(ticketDir, 'beads', 'feature', '.beads', 'issues.jsonl')
    const temp = makeAtomicTmpPath(target)
    mkdirSync(dirname(temp), { recursive: true })
    const complete = '{"id":"B-1","status":"done"}\n{"id":"B-2","status":"pending"}\n'
    writeFileSync(temp, complete)
    writeFileSync(target, '{"id":"B-1","status":"done"}\n')
    const source = lstatSync(temp)
    writeFileSync(`${temp}.recovery`, JSON.stringify({
      version: 1,
      targetPath: target,
      source: {
        dev: Number(source.dev),
        ino: Number(source.ino),
        size: Number(source.size),
        mtimeMs: Number(source.mtimeMs),
        birthtimeMs: Number(source.birthtimeMs),
      },
    }))

    startupFixture.tickets.push({ id: 'blocked-ticket' })
    startupFixture.paths = {
      projectRoot: ticketDir,
      worktreePath: ticketDir,
      ticketDir,
      executionLogPath: join(ticketDir, 'runtime', 'execution-log.jsonl'),
      debugLogPath: join(ticketDir, 'runtime', 'execution-log.debug.jsonl'),
      aiLogPath: join(ticketDir, 'runtime', 'execution-log.ai.jsonl'),
      executionSetupDir: join(ticketDir, 'runtime'),
      executionSetupProfilePath: join(ticketDir, 'runtime', 'execution-setup-profile.json'),
      baseBranch: 'main',
      beadsPath: target,
    }

    const { startupSequence } = await import('../startup')
    for (let boot = 0; boot < 2; boot += 1) {
      await expect(startupSequence()).rejects.toBeInstanceOf(RecoveryBlockedError)
      expect(readFileSync(target, 'utf8')).toBe('{"id":"B-1","status":"done"}\n')
      expect(readFileSync(temp, 'utf8')).toBe(complete)
      expect(existsSync(`${temp}.recovery`)).toBe(true)
      expect(startupFixture.startWalCheckpoint).not.toHaveBeenCalled()
      expect(startupFixture.rebuildTicketRuntimeProjections).not.toHaveBeenCalled()
      expect(startupFixture.hydrateAllTickets).not.toHaveBeenCalled()
    }
  }, 30_000)

  it('fails closed for an unresolved config generation before startup work continues', async () => {
    const configDir = makeTempDir('looptroop-startup-blocked-config-')
    roots.push(configDir)
    process.env.LOOPTROOP_CONFIG_DIR = configDir

    const target = join(configDir, 'config.json')
    const temp = makeAtomicTmpPath(target)
    const complete = '{"port":4310,"host":"127.0.0.1"}'
    mkdirSync(dirname(temp), { recursive: true })
    writeFileSync(temp, complete)
    writeFileSync(target, '{"port":4310}')
    const source = lstatSync(temp)
    writeFileSync(`${temp}.recovery`, JSON.stringify({
      version: 1,
      targetPath: target,
      source: {
        dev: Number(source.dev),
        ino: Number(source.ino),
        size: Number(source.size),
        mtimeMs: Number(source.mtimeMs),
        birthtimeMs: Number(source.birthtimeMs),
      },
    }))

    const { startupSequence } = await import('../startup')
    await expect(startupSequence()).rejects.toBeInstanceOf(RecoveryBlockedError)
    expect(readFileSync(target, 'utf8')).toBe('{"port":4310}')
    expect(readFileSync(temp, 'utf8')).toBe(complete)
    expect(existsSync(`${temp}.recovery`)).toBe(true)
    expect(startupFixture.startWalCheckpoint).not.toHaveBeenCalled()
    expect(startupFixture.rebuildTicketRuntimeProjections).not.toHaveBeenCalled()
    expect(startupFixture.hydrateAllTickets).not.toHaveBeenCalled()
  }, 30_000)

  it('warns for reachable OpenCode model discovery failures and prints protocol names once', async () => {
    const configDir = makeTempDir('looptroop-startup-opencode-health-')
    roots.push(configDir)
    process.env.LOOPTROOP_CONFIG_DIR = configDir
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { startupSequence } = await import('../startup')

    startupFixture.health = {
      available: true,
      protocol: 'v1',
      failureKind: 'model_discovery',
      error: 'OpenCode is reachable, but model discovery failed: provider configuration is missing',
    }
    await startupSequence()

    expect(warn).toHaveBeenCalledWith('[startup] OpenCode is reachable, but model discovery failed: provider configuration is missing')
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('OpenCode via v1 is reachable'))

    warn.mockClear()
    log.mockClear()
    startupFixture.health = { available: true, protocol: 'v2', version: '2.0.15' }
    await startupSequence()

    expect(log).toHaveBeenCalledWith('[startup] OpenCode via v2 is reachable (version: 2.0.15).')
  }, 30_000)
})
