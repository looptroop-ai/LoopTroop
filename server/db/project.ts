import { Database } from './sqliteShim'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { existsSync } from 'fs'
import * as schema from './schema'
import { ensureProjectStorageDirs, getProjectDbPath } from '../storage/paths'
import { secureFile } from '../lib/appConfigDir'
import { SQLITE_BUSY_TIMEOUT_MS } from '../lib/constants'
import {
  PROJECT_MIGRATABLE_FROM,
  PROJECT_SCHEMA_VERSION,
  assertSchemaCompatible,
  shouldStampAfterInit,
  writeUserVersion,
  type SchemaCompatibility,
} from './schemaVersion'

interface ProjectDatabase {
  sqlite: Database
  db: ReturnType<typeof drizzle>
}

const MAX_PROJECT_CACHE_SIZE = 50
const projectDbCache = new Map<string, ProjectDatabase>()

function closeCachedProjectDatabase(projectRoot: string): boolean {
  const cached = projectDbCache.get(projectRoot)
  if (!cached) return false

  cached.sqlite.close()
  projectDbCache.delete(projectRoot)
  return true
}

function ensureColumn(
  sqlite: Database,
  table: string,
  column: string,
  definition: string,
) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  if (columns.some((entry) => entry.name === column)) return
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

function initializeProjectSqlite(sqlite: Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      shortname TEXT NOT NULL,
      icon TEXT DEFAULT '📁',
      color TEXT DEFAULT '#3b82f6',
      folder_path TEXT NOT NULL,
      profile_id INTEGER,
      council_members TEXT,
      manual_qa_override INTEGER,
      ai_questions_override INTEGER,
      ai_question_window_override INTEGER,
      git_hook_policy TEXT,
      max_iterations INTEGER,
      per_iteration_timeout INTEGER,
      execution_setup_timeout INTEGER,
      council_response_timeout INTEGER,
      min_council_quorum INTEGER,
      interview_questions INTEGER,
      ignore_mode TEXT,
      ticket_counter INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
      cancel_reason TEXT,
      manual_qa_override INTEGER,
      ai_questions_override INTEGER,
      ai_question_window_override INTEGER,
      locked_main_implementer TEXT,
      locked_main_implementer_variant TEXT,
      locked_council_members TEXT,
      locked_council_member_variants TEXT,
      locked_interview_questions INTEGER,
      locked_coverage_follow_up_budget_percent INTEGER,
      locked_max_coverage_passes INTEGER,
      locked_max_prd_coverage_passes INTEGER,
      locked_max_beads_coverage_passes INTEGER,
      locked_structured_retry_count INTEGER,
      locked_manual_qa_enabled INTEGER,
      locked_manual_qa_source TEXT,
      locked_ai_questions_enabled INTEGER,
      locked_ai_questions_source TEXT,
      locked_ai_question_window INTEGER,
      locked_ai_question_window_source TEXT,
      locked_git_hook_policy TEXT,
      locked_git_hook_policy_source TEXT,
      workflow_revision INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      planned_date TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_project_id ON tickets(project_id);

    CREATE TABLE IF NOT EXISTS phase_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      phase_attempt INTEGER NOT NULL DEFAULT 1,
      artifact_type TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_phase_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      archived_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    );

    CREATE TABLE IF NOT EXISTS manual_qa_operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      checklist_hash TEXT NOT NULL,
      draft_revision INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'staged',
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS manual_qa_improvement_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin_id TEXT NOT NULL UNIQUE,
      destination_ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      action_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS opencode_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      phase TEXT NOT NULL,
      phase_attempt INTEGER DEFAULT 1,
      member_id TEXT,
      bead_id TEXT,
      iteration INTEGER,
      step TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      last_event_id TEXT,
      last_event_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      previous_status TEXT,
      new_status TEXT NOT NULL,
      reason TEXT,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ticket_error_occurrences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      occurrence_number INTEGER NOT NULL,
      blocked_from_status TEXT NOT NULL,
      error_message TEXT,
      error_codes TEXT,
      diagnostic_details TEXT,
      occurred_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT,
      resolution_status TEXT,
      resumed_to_status TEXT
    );

    CREATE TABLE IF NOT EXISTS bead_execution_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      bead_id TEXT NOT NULL,
      size_bucket TEXT NOT NULL,
      effort_tier TEXT NOT NULL,
      iterations INTEGER NOT NULL DEFAULT 1,
      active_duration_ms INTEGER NOT NULL,
      wall_clock_ms INTEGER,
      completed_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost_usd REAL
    );

    CREATE TABLE IF NOT EXISTS ticket_ai_turn_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      phase TEXT NOT NULL,
      phase_attempt INTEGER NOT NULL DEFAULT 1,
      session_id TEXT NOT NULL,
      assistant_message_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      variant TEXT,
      agent TEXT,
      finish_reason TEXT,
      started_at TEXT,
      completed_at TEXT,
      duration_ms INTEGER,
      cost_usd REAL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      schema_version INTEGER NOT NULL DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_project_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_project_tickets_external_id ON tickets(external_id);
    CREATE INDEX IF NOT EXISTS idx_phase_artifacts_ticket ON phase_artifacts(ticket_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_qa_operations_ticket_action
      ON manual_qa_operations(ticket_id, action_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_ticket_phase ON opencode_sessions(ticket_id, phase, state);
    CREATE INDEX IF NOT EXISTS idx_opencode_sessions_session_id ON opencode_sessions(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_error_occurrences_ticket_sequence
      ON ticket_error_occurrences(ticket_id, occurrence_number);
    CREATE INDEX IF NOT EXISTS idx_ticket_error_occurrences_open
      ON ticket_error_occurrences(ticket_id, resolved_at, occurrence_number);
    CREATE INDEX IF NOT EXISTS idx_bead_metrics_bucket
      ON bead_execution_metrics(size_bucket, effort_tier, completed_at);
    CREATE INDEX IF NOT EXISTS idx_bead_metrics_ticket
      ON bead_execution_metrics(ticket_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_turn_metrics_message
      ON ticket_ai_turn_metrics(ticket_id, session_id, assistant_message_id);
    CREATE INDEX IF NOT EXISTS idx_ai_turn_metrics_scope
      ON ticket_ai_turn_metrics(ticket_id, phase, phase_attempt, model_id);
    CREATE INDEX IF NOT EXISTS idx_ai_turn_metrics_lifecycle
      ON ticket_ai_turn_metrics(ticket_id, model_id, updated_at);
  `)

  ensureColumn(sqlite, 'tickets', 'locked_interview_questions', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_coverage_follow_up_budget_percent', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_max_coverage_passes', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_max_prd_coverage_passes', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_max_beads_coverage_passes', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_structured_retry_count', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'manual_qa_override', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'cancel_reason', 'TEXT')
  ensureColumn(sqlite, 'tickets', 'locked_manual_qa_enabled', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_manual_qa_source', 'TEXT')
  ensureColumn(sqlite, 'tickets', 'ai_questions_override', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'ai_question_window_override', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_ai_questions_enabled', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_ai_questions_source', 'TEXT')
  ensureColumn(sqlite, 'tickets', 'locked_ai_question_window', 'INTEGER')
  ensureColumn(sqlite, 'tickets', 'locked_ai_question_window_source', 'TEXT')
  ensureColumn(sqlite, 'tickets', 'locked_git_hook_policy', 'TEXT')
  ensureColumn(sqlite, 'tickets', 'locked_git_hook_policy_source', 'TEXT')
  ensureColumn(sqlite, 'tickets', 'workflow_revision', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(sqlite, 'tickets', 'locked_main_implementer_variant', 'TEXT')
  ensureColumn(sqlite, 'tickets', 'locked_council_member_variants', 'TEXT')
  ensureColumn(sqlite, 'opencode_sessions', 'phase_attempt', 'INTEGER DEFAULT 1')
  ensureColumn(sqlite, 'opencode_sessions', 'step', 'TEXT')
  ensureColumn(sqlite, 'ticket_error_occurrences', 'diagnostic_details', 'TEXT')
  ensureColumn(sqlite, 'projects', 'execution_setup_timeout', 'INTEGER')
  ensureColumn(sqlite, 'projects', 'manual_qa_override', 'INTEGER')
  ensureColumn(sqlite, 'projects', 'ai_questions_override', 'INTEGER')
  ensureColumn(sqlite, 'projects', 'ai_question_window_override', 'INTEGER')
  ensureColumn(sqlite, 'projects', 'git_hook_policy', 'TEXT')
  ensureColumn(sqlite, 'projects', 'ignore_mode', 'TEXT')
  ensureColumn(sqlite, 'phase_artifacts', 'phase_attempt', 'INTEGER NOT NULL DEFAULT 1')
  ensureColumn(sqlite, 'phase_artifacts', 'updated_at', 'TEXT')

  sqlite.exec(`
    UPDATE projects
    SET git_hook_policy = CASE git_hook_policy
      WHEN 'validate_explicitly' THEN 'validate_advisory'
      WHEN 'ignore_internal_only' THEN 'observe_only'
      WHEN 'use_on_internal_commits' THEN 'use_native_hooks'
      ELSE git_hook_policy
    END
    WHERE git_hook_policy IN (
      'validate_explicitly',
      'ignore_internal_only',
      'use_on_internal_commits'
    );

    UPDATE phase_artifacts
    SET phase_attempt = COALESCE(phase_attempt, 1)
    WHERE phase_attempt IS NULL;

    UPDATE phase_artifacts
    SET updated_at = COALESCE(updated_at, created_at)
    WHERE updated_at IS NULL;
  `)

  sqlite.exec(`
    CREATE INDEX IF NOT EXISTS idx_phase_artifacts_ticket_phase_attempt
      ON phase_artifacts(ticket_id, phase, phase_attempt);
    CREATE INDEX IF NOT EXISTS idx_ticket_phase_attempts_ticket_phase
      ON ticket_phase_attempts(ticket_id, phase, state, attempt_number);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_phase_attempts_unique
      ON ticket_phase_attempts(ticket_id, phase, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_sessions_ticket_phase_step
      ON opencode_sessions(ticket_id, phase, phase_attempt, member_id, bead_id, iteration, step, state);
  `)
}

function cleanupProjectForeignKeyOrphans(sqlite: Database) {
  sqlite.exec(`
    DELETE FROM phase_artifacts
    WHERE ticket_id NOT IN (SELECT id FROM tickets)
      OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects));

    DELETE FROM ticket_phase_attempts
    WHERE ticket_id NOT IN (SELECT id FROM tickets)
      OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects));

    DELETE FROM manual_qa_operations
    WHERE ticket_id NOT IN (SELECT id FROM tickets)
      OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects));

    UPDATE opencode_sessions
    SET ticket_id = NULL
    WHERE ticket_id IS NOT NULL
      AND (
        ticket_id NOT IN (SELECT id FROM tickets)
        OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects))
      );

    DELETE FROM ticket_status_history
    WHERE ticket_id NOT IN (SELECT id FROM tickets)
      OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects));

    DELETE FROM ticket_error_occurrences
    WHERE ticket_id NOT IN (SELECT id FROM tickets)
      OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects));

    DELETE FROM bead_execution_metrics
    WHERE ticket_id NOT IN (SELECT id FROM tickets)
      OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects));

    DELETE FROM ticket_ai_turn_metrics
    WHERE ticket_id NOT IN (SELECT id FROM tickets)
      OR ticket_id IN (SELECT id FROM tickets WHERE project_id NOT IN (SELECT id FROM projects));

    DELETE FROM tickets
    WHERE project_id NOT IN (SELECT id FROM projects);
  `)
}

export function getProjectDatabase(projectRoot: string): ProjectDatabase {
  const dbPath = getProjectDbPath(projectRoot)
  const cached = projectDbCache.get(projectRoot)
  if (cached) {
    if (existsSync(dbPath)) return cached
    closeCachedProjectDatabase(projectRoot)
  }

  // Evict oldest entries if cache exceeds max size
  if (projectDbCache.size >= MAX_PROJECT_CACHE_SIZE) {
    const oldestKey = projectDbCache.keys().next().value
    if (oldestKey !== undefined) {
      closeCachedProjectDatabase(oldestKey)
    }
  }

  ensureProjectStorageDirs(projectRoot)
  const sqlite = new Database(dbPath)
  // Carries OpenCode session ownership and ticket state, so restrict it even
  // though it lives inside the user's own repository.
  secureFile(dbPath)
  sqlite.pragma('journal_mode=WAL')
  sqlite.pragma('locking_mode=NORMAL')
  sqlite.pragma('synchronous=NORMAL')
  sqlite.pragma(`busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`)

  // Classify before any DDL: cleanupProjectForeignKeyOrphans below deletes
  // rows, so an incompatible database must be refused before we reach it.
  let compatibility: SchemaCompatibility
  try {
    compatibility = assertSchemaCompatible({
      store: sqlite,
      databaseLabel: 'project database',
      databasePath: dbPath,
      expected: PROJECT_SCHEMA_VERSION,
      migratableFrom: PROJECT_MIGRATABLE_FROM,
      onNotice: (message) => console.warn(message),
    })
  } catch (error) {
    sqlite.close()
    throw error
  }

  initializeProjectSqlite(sqlite)
  cleanupProjectForeignKeyOrphans(sqlite)
  sqlite.pragma('foreign_keys=ON')

  // Stamp after DDL: project DBs use PRAGMA user_version (no new table needed).
  if (shouldStampAfterInit(compatibility)) {
    writeUserVersion(sqlite, PROJECT_SCHEMA_VERSION)
  }

  const projectDb: ProjectDatabase = {
    sqlite,
    // @ts-expect-error Drizzle 1.0 RC removes `schema` from the config type but accepts it at runtime
    db: drizzle({ client: sqlite.client, schema }),
  }
  projectDbCache.set(projectRoot, projectDb)
  return projectDb
}

export function getExistingProjectDatabase(projectRoot: string): ProjectDatabase | null {
  const dbPath = getProjectDbPath(projectRoot)
  if (!existsSync(dbPath)) {
    closeCachedProjectDatabase(projectRoot)
    return null
  }

  const cached = projectDbCache.get(projectRoot)
  if (cached) return cached
  return getProjectDatabase(projectRoot)
}

export function closeProjectDatabase(projectRoot: string): boolean {
  return closeCachedProjectDatabase(projectRoot)
}

export function clearProjectDatabaseCache() {
  for (const projectRoot of [...projectDbCache.keys()]) {
    closeCachedProjectDatabase(projectRoot)
  }
}
