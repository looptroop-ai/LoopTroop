import { Database } from '../../db/sqliteShim'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Hono } from 'hono'
import { createFixtureRepoManager } from '../../test/fixtureRepo'
import { getProjectDbPath, normalizeFolderPath } from '../../storage/paths'
import packageJson from '../../../package.json'
import { removeTempDir } from '../../test/tempDir'

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

  it('migrates attached legacy project databases before startup reads them', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'looptroop-health-legacy-project-'))
    tempRoots.add(tempRoot)
    const configDir = join(tempRoot, 'config')
    const repoDir = repoManager.createRepo()
    const projectDbPath = getProjectDbPath(repoDir)

    mkdirSync(dirname(projectDbPath), { recursive: true })
    const legacyProjectDb = new Database(projectDbPath)
    legacyProjectDb.exec(`
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        shortname TEXT NOT NULL,
        icon TEXT DEFAULT '📁',
        color TEXT DEFAULT '#3b82f6',
        folder_path TEXT NOT NULL,
        profile_id INTEGER,
        council_members TEXT,
        max_iterations INTEGER,
        per_iteration_timeout INTEGER,
        council_response_timeout INTEGER,
        min_council_quorum INTEGER,
        interview_questions INTEGER,
        ticket_counter INTEGER DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL UNIQUE,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        priority INTEGER DEFAULT 3,
        status TEXT NOT NULL DEFAULT 'DRAFT',
        xstate_snapshot TEXT,
        branch_name TEXT,
        current_bead INTEGER,
        total_beads INTEGER,
        percent_complete REAL,
        error_message TEXT,
        locked_main_implementer TEXT,
        locked_council_members TEXT,
        started_at TEXT,
        planned_date TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE phase_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id INTEGER NOT NULL,
        phase TEXT NOT NULL,
        artifact_type TEXT,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE opencode_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ticket_id INTEGER,
        phase TEXT NOT NULL,
        member_id TEXT,
        bead_id TEXT,
        iteration INTEGER,
        state TEXT NOT NULL DEFAULT 'active',
        last_event_id TEXT,
        last_event_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `)
    legacyProjectDb.prepare(`
      INSERT INTO projects (name, shortname, folder_path)
      VALUES (?, ?, ?)
    `).run('Legacy Project', 'LEG', normalizeFolderPath(repoDir))
    legacyProjectDb.close()

    const seedApp = await loadHealthApp(configDir)
    seedApp.initializeDatabase()
    seedApp.sqlite.prepare(`
      INSERT INTO attached_projects (folder_path)
      VALUES (?)
    `).run(repoDir)
    await closeLoadedHealthApp(seedApp)

    activeApp = await loadHealthApp(configDir)
    activeApp.initializeDatabase()
    activeApp.initializeStartupState()

    const response = await activeApp.app.request('/api/health/startup')
    expect(response.status).toBe(200)

    const payload = await response.json() as {
      storage: {
        kind: string
        restoredProjectCount: number
        restoredProjects: Array<{ name: string; shortname: string; folderPath: string }>
      }
    }

    expect(payload.storage.kind).toBe('restored')
    expect(payload.storage.restoredProjectCount).toBe(1)
    expect(payload.storage.restoredProjects).toEqual([
      {
        name: 'Legacy Project',
        shortname: 'LEG',
        folderPath: normalizeFolderPath(repoDir),
      },
    ])

    const migratedProjectDb = new Database(projectDbPath, { readonly: true })
    const phaseArtifactColumns = migratedProjectDb.prepare('PRAGMA table_info(phase_artifacts)').all() as Array<{ name: string }>
    const sessionColumns = migratedProjectDb.prepare('PRAGMA table_info(opencode_sessions)').all() as Array<{ name: string }>
    const tables = migratedProjectDb.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'ticket_phase_attempts'
    `).all() as Array<{ name: string }>
    const artifactIndexes = migratedProjectDb.prepare('PRAGMA index_list(phase_artifacts)').all() as Array<{ name: string }>
    const sessionIndexes = migratedProjectDb.prepare('PRAGMA index_list(opencode_sessions)').all() as Array<{ name: string }>
    migratedProjectDb.close()

    expect(phaseArtifactColumns.map((column) => column.name)).toContain('phase_attempt')
    expect(phaseArtifactColumns.map((column) => column.name)).toContain('updated_at')
    expect(sessionColumns.map((column) => column.name)).toContain('phase_attempt')
    expect(sessionColumns.map((column) => column.name)).toContain('step')
    expect(tables).toEqual([{ name: 'ticket_phase_attempts' }])
    expect(artifactIndexes.map((index) => index.name)).toContain('idx_phase_artifacts_ticket_phase_attempt')
    expect(sessionIndexes.map((index) => index.name)).toContain('idx_sessions_ticket_phase_step')
  })
})
