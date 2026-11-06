import { Database } from '../../db/sqliteShim'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { getProjectDbPath, normalizeFolderPath } from '../../storage/paths'
import packageJson from '../../../package.json'
import { removeTempDir } from '../../test/tempDir'

const { checkHealth } = vi.hoisted(() => ({ checkHealth: vi.fn() }))

vi.mock('../../opencode/factory', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../opencode/factory')>(),
  getOpenCodeAdapter: () => ({ checkHealth }),
}))

const repoManager = createFixtureRepoManager({
  templatePrefix: 'looptroop-health-route-',
  files: {
    'README.md': '# LoopTroop Health Route Test\n',
  },
})

interface LoadedHealthApp {
  app: Hono
  sqlite: Database
  initializeDatabase: () => void
  initializeStartupState: () => unknown
  resetStartupStateForTests: () => void
  closeDatabase: () => void
  clearProjectDatabaseCache: () => void
  attachProject: (input: {
    folderPath: string
    name: string
    shortname: string
  }) => unknown
}

const tempRoots = new Set<string>()
let activeApp: LoadedHealthApp | null = null

async function loadHealthApp(configDir: string): Promise<LoadedHealthApp> {
  process.env.LOOPTROOP_CONFIG_DIR = configDir
  delete process.env.LOOPTROOP_APP_DB_PATH
  vi.resetModules()

  const [
    { health },
    { initializeStartupState, resetStartupStateForTests },
    { initializeDatabase },
    { sqlite, closeDatabase },
    { clearProjectDatabaseCache },
    { attachProject },
  ] = await Promise.all([
    import('../health'),
    import('../../startupState'),
    import('../../db/init'),
    import('../../db/index'),
    import('../../db/project'),
    import('../../storage/projects'),
  ])

  const app = new Hono()
  app.route('/api', health)

  return {
    app,
    sqlite,
    initializeDatabase,
    initializeStartupState,
    resetStartupStateForTests,
    closeDatabase,
    clearProjectDatabaseCache,
    attachProject,
  }
}

async function closeLoadedHealthApp(instance: LoadedHealthApp | null) {
  if (!instance) return
  instance.resetStartupStateForTests()
  instance.clearProjectDatabaseCache()
  instance.closeDatabase()
}

describe('health startup routes', () => {
  afterEach(async () => {
    await closeLoadedHealthApp(activeApp)
    activeApp = null
    delete process.env.LOOPTROOP_CONFIG_DIR
    delete process.env.LOOPTROOP_APP_DB_PATH
    vi.resetModules()

    for (const root of tempRoots) {
      removeTempDir(root)
    }
    tempRoots.clear()
  })

  afterAll(() => {
    repoManager.cleanup()
  })

  it('reports the current and latest release with installation-aware update steps', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-update-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')
    mkdirSync(configDir, { recursive: true })
    const checkedAt = new Date().toISOString()
    writeFileSync(join(configDir, 'update-check.json'), `${JSON.stringify({
      lastAttemptAt: checkedAt,
      lastCheckedAt: checkedAt,
      latestVersion: '9.0.0',
      release: {
        version: '9.0.0',
        name: 'LoopTroop 9.0.0',
        url: 'https://github.com/looptroop-ai/LoopTroop/releases/tag/v9.0.0',
        publishedAt: checkedAt,
        notes: 'A future test release.',
      },
    }, null, 2)}\n`)

    activeApp = await loadHealthApp(configDir)
    const response = await activeApp.app.request('/api/health/update')
    expect(response.status).toBe(200)
    const payload = await response.json() as {
      currentVersion: string
      latestVersion: string
      updateAvailable: boolean
      installChannel: string
      upgradeCommand: string
      postUpgradeCommand?: string
      release: { notes: string }
    }

    expect(payload.currentVersion).toBe(packageJson.version)
    expect(payload.latestVersion).toBe('9.0.0')
    expect(payload.updateAvailable).toBe(true)
    expect(payload.installChannel).toBe('source')
    expect(payload.upgradeCommand).toBe('git pull && npm install && npm run build')
    expect(payload.postUpgradeCommand).toBe('looptroop restart')
    expect(payload.release.notes).toBe('A future test release.')
  })

  it('reports fresh startup state when the app db did not exist before boot', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-fresh-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')

    activeApp = await loadHealthApp(configDir)
    activeApp.initializeDatabase()
    activeApp.initializeStartupState()

    const response = await activeApp.app.request('/api/health/startup')
    expect(response.status).toBe(200)

    const payload = await response.json() as {
      storage: {
        kind: string
        source: string
        profileRestored: boolean
        restoredProjectCount: number
        restoredProjects: Array<{ name: string; shortname: string; folderPath: string }>
      }
      ui: { restoreNotice: { shouldShow: boolean; dismissedAt: string | null } }
    }

    expect(payload.storage.kind).toBe('fresh')
    expect(payload.storage.source).toBe('LOOPTROOP_CONFIG_DIR')
    expect(payload.storage.profileRestored).toBe(false)
    expect(payload.storage.restoredProjectCount).toBe(0)
    expect(payload.storage.restoredProjects).toEqual([])
    expect(payload.ui.restoreNotice).toEqual({
      shouldShow: false,
      dismissedAt: null,
    })
  })

  it('reports empty_existing when the app db existed before boot with no saved state', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-empty-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')
    mkdirSync(configDir, { recursive: true })
    new Database(join(configDir, 'app.sqlite')).close()

    activeApp = await loadHealthApp(configDir)
    activeApp.initializeDatabase()
    activeApp.initializeStartupState()

    const response = await activeApp.app.request('/api/health/startup')
    expect(response.status).toBe(200)

    const payload = await response.json() as {
      storage: {
        kind: string
        profileRestored: boolean
        restoredProjectCount: number
        restoredProjects: Array<{ name: string; shortname: string; folderPath: string }>
      }
      ui: { restoreNotice: { shouldShow: boolean } }
    }

    expect(payload.storage.kind).toBe('empty_existing')
    expect(payload.storage.profileRestored).toBe(false)
    expect(payload.storage.restoredProjectCount).toBe(0)
    expect(payload.storage.restoredProjects).toEqual([])
    expect(payload.ui.restoreNotice.shouldShow).toBe(false)
  })

  it('reports restored startup state, keeps the boot snapshot stable, and persists notice dismissal', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-restored-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')
    const repoDir = repoManager.createRepo()

    const seedApp = await loadHealthApp(configDir)
    seedApp.initializeDatabase()
    seedApp.attachProject({
      folderPath: repoDir,
      name: 'Restored Project',
      shortname: 'RST',
    })
    seedApp.sqlite.exec(`
      INSERT INTO profiles (main_implementer, council_members)
      VALUES ('openai/gpt-5.4', '[]');
    `)
    await closeLoadedHealthApp(seedApp)

    activeApp = await loadHealthApp(configDir)
    activeApp.initializeDatabase()
    activeApp.initializeStartupState()

    const initialResponse = await activeApp.app.request('/api/health/startup')
    expect(initialResponse.status).toBe(200)
    const initialPayload = await initialResponse.json() as {
      storage: {
        kind: string
        profileRestored: boolean
        restoredProjectCount: number
        restoredProjects: Array<{ name: string; shortname: string; folderPath: string }>
      }
      ui: { restoreNotice: { shouldShow: boolean; dismissedAt: string | null } }
    }

    expect(initialPayload.storage.kind).toBe('restored')
    expect(initialPayload.storage.profileRestored).toBe(true)
    expect(initialPayload.storage.restoredProjectCount).toBe(1)
    expect(initialPayload.storage.restoredProjects).toEqual([
      {
        name: 'Restored Project',
        shortname: 'RST',
        folderPath: normalizeFolderPath(repoDir),
      },
    ])
    expect(initialPayload.ui.restoreNotice.shouldShow).toBe(true)
    expect(initialPayload.ui.restoreNotice.dismissedAt).toBeNull()

    activeApp.sqlite.exec('DELETE FROM attached_projects; DELETE FROM profiles;')

    const snapshotAfterMutation = await activeApp.app.request('/api/health/startup')
    const mutatedPayload = await snapshotAfterMutation.json() as {
      storage: {
        kind: string
        profileRestored: boolean
        restoredProjectCount: number
      }
    }

    expect(mutatedPayload.storage.kind).toBe('restored')
    expect(mutatedPayload.storage.profileRestored).toBe(true)
    expect(mutatedPayload.storage.restoredProjectCount).toBe(1)

    const dismissResponse = await activeApp.app.request('/api/health/startup/restore-notice/dismiss', {
      method: 'POST',
    })
    expect(dismissResponse.status).toBe(200)
    const dismissPayload = await dismissResponse.json() as {
      success: boolean
      dismissedAt: string | null
    }

    expect(dismissPayload.success).toBe(true)
    expect(dismissPayload.dismissedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)

    const afterDismissResponse = await activeApp.app.request('/api/health/startup')
    const afterDismissPayload = await afterDismissResponse.json() as {
      ui: { restoreNotice: { shouldShow: boolean; dismissedAt: string | null } }
    }

    expect(afterDismissPayload.ui.restoreNotice.shouldShow).toBe(false)
    expect(afterDismissPayload.ui.restoreNotice.dismissedAt).toBe(dismissPayload.dismissedAt)
  })

  it('refuses an older app database without changing its file', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-older-app-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')
    mkdirSync(configDir, { recursive: true })
    const appDbPath = join(configDir, 'app.sqlite')
    const seed = new Database(appDbPath)
    seed.exec('CREATE TABLE profiles (id INTEGER PRIMARY KEY)')
    seed.pragma('user_version = 2')
    seed.close()
    if (process.platform !== 'win32') chmodSync(appDbPath, 0o644)

    activeApp = await loadHealthApp(configDir)
    expect(() => activeApp!.initializeDatabase()).toThrow(/created by an older version of LoopTroop/)

    const reopened = new Database(appDbPath, { readonly: true })
    try {
      // Neither switched to WAL (a header write) nor stamped.
      expect(reopened.pragma('journal_mode')).toEqual([{ journal_mode: 'delete' }])
      expect(reopened.pragma('user_version')).toEqual([{ user_version: 2 }])
    } finally {
      reopened.close()
    }
    expect(existsSync(`${appDbPath}-wal`)).toBe(false)
    if (process.platform !== 'win32') expect(statSync(appDbPath).mode & 0o777).toBe(0o644)
  })

  it('leaves an app database whose first start failed before the stamp retryable', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-fresh-app-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')

    activeApp = await loadHealthApp(configDir)
    const schemaVersion = await import('../../db/schemaVersion')
    const stamp = vi.spyOn(schemaVersion, 'writeUserVersion').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    try {
      expect(() => activeApp!.initializeDatabase()).toThrow('disk full')
    } finally {
      stamp.mockRestore()
    }

    // Rolled back with the tables: the next start sees a fresh file and stamps it.
    activeApp!.initializeDatabase()
    expect(activeApp!.sqlite.pragma('user_version')).toEqual([{ user_version: schemaVersion.APP_SCHEMA_VERSION }])
  })

  it('stops startup with reset steps when an attached project database is from an older version', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-older-project-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')
    const repoDir = repoManager.createRepo()
    const projectDbPath = getProjectDbPath(repoDir)

    // Tables but no stamped version: what every build before schema versioning wrote.
    mkdirSync(dirname(projectDbPath), { recursive: true })
    const olderProjectDb = new Database(projectDbPath)
    olderProjectDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        shortname TEXT NOT NULL,
        folder_path TEXT NOT NULL
      );
    `)
    olderProjectDb.prepare('INSERT INTO projects (name, shortname, folder_path) VALUES (?, ?, ?)')
      .run('Older Project', 'OLD', normalizeFolderPath(repoDir))
    olderProjectDb.close()

    const seedApp = await loadHealthApp(configDir)
    seedApp.initializeDatabase()
    seedApp.sqlite.prepare(`
      INSERT INTO attached_projects (folder_path)
      VALUES (?)
    `).run(repoDir)
    await closeLoadedHealthApp(seedApp)

    activeApp = await loadHealthApp(configDir)
    activeApp.initializeDatabase()
    let refusal: unknown
    try {
      activeApp.initializeStartupState()
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(Error)
    const message = (refusal as Error).message
    expect(message).toContain(projectDbPath)
    expect(message).toContain('created by an older version of LoopTroop')
    expect(message).toContain('git worktree prune')

    // Refused before any statement ran: nothing was added to the file.
    const untouched = new Database(projectDbPath, { readonly: true })
    const tables = untouched.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
    const version = untouched.pragma('user_version') as Array<{ user_version: number }>
    untouched.close()
    expect(tables.map((table) => table.name)).toEqual(['projects'])
    expect(version[0]?.user_version).toBe(0)
  })
})

describe('OpenCode health route', () => {
  afterEach(() => {
    checkHealth.mockReset()
    vi.unstubAllEnvs()
  })

  async function requestOpenCodeHealth(request?: Request) {
    const { health } = await import('../health')
    const app = new Hono()
    app.route('/api', health)
    return (await app.request(request ?? '/api/health/opencode')).json()
  }

  it('forwards cancellation and preserves the health payload without a model catalog', async () => {
    checkHealth.mockResolvedValueOnce({ available: true, protocol: 'v1', version: 'test-version' })
    const request = new Request('http://localhost/api/health/opencode')

    const payload = await requestOpenCodeHealth(request)

    expect(checkHealth).toHaveBeenCalledWith(request.signal)
    expect(payload).toEqual({ status: 'ok', protocol: 'v1', version: 'test-version', models: [] })
  })

  it('words a refusal by what was sent, not by an environment the supervisor fills in itself', async () => {
    // The setup notice shows this advice. One sentence telling everyone to set
    // OPENCODE_PASSWORD was wrong for a v1 server and for a wrong password.
    vi.stubEnv('OPENCODE_PASSWORD', 'generated-by-the-supervisor')
    checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401', credentialsSent: false })
    const none = await requestOpenCodeHealth()
    expect(none).toEqual({
      status: 'unavailable',
      models: [],
      failureKind: 'authentication',
      error: 'HTTP 401',
      credentialsSent: false,
      advice: expect.stringMatching(/^OpenCode requires a password, and none is configured\. Set OPENCODE_PASSWORD/),
    })

    vi.stubEnv('OPENCODE_PASSWORD', '')
    vi.stubEnv('OPENCODE_SERVER_PASSWORD', '')
    checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401', credentialsSent: true })
    const rejected = await requestOpenCodeHealth()
    expect(rejected).toMatchObject({ failureKind: 'authentication', credentialsSent: true })
    expect(rejected.advice).toMatch(/^OpenCode rejected the configured credentials\./)
    expect(rejected.advice).toContain('OPENCODE_SERVER_PASSWORD and OPENCODE_SERVER_USERNAME for v1')

    // A result that does not say falls back to the environment, as the model
    // screen and the interview phase do.
    checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'authentication', error: 'HTTP 401' })
    const unsaid = await requestOpenCodeHealth()
    expect(unsaid).toMatchObject({ credentialsSent: false, advice: none.advice })
  })

  it('adds no sign-in advice to a server that is simply not answering', async () => {
    checkHealth.mockResolvedValueOnce({ available: false, failureKind: 'network', error: 'connection refused' })
    const payload = await requestOpenCodeHealth()
    expect(payload).toEqual({ status: 'unavailable', models: [], failureKind: 'network', error: 'connection refused' })
  })
})
