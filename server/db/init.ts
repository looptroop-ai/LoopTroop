import { sqlite, APP_STORAGE_BOOT_FACTS } from './index'
import { PROFILE_DEFAULTS } from './defaults'
import { logIfVerbose } from '../runtime'
import {
  APP_MIGRATABLE_FROM,
  APP_SCHEMA_VERSION,
  assertSchemaCompatible,
  shouldStampAfterInit,
  writeUserVersion,
} from './schemaVersion'

function ensureColumn(table: string, column: string, definition: string) {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  if (columns.some((entry) => entry.name === column)) return
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}

function listColumns(table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>)
    .flatMap((entry) => typeof entry.name === 'string' ? [entry.name] : [])
}

function selectLegacyProfileColumn(columns: Set<string>, column: string): string {
  return columns.has(column) ? column : 'NULL'
}

function selectLegacyProfileValue(columns: Set<string>, column: string, defaultValue: number): string {
  if (!columns.has(column)) return String(defaultValue)
  return `COALESCE(${column}, ${defaultValue})`
}

function selectLegacyProfileExpression(columns: Set<string>, column: string, defaultSql: string): string {
  if (!columns.has(column)) return defaultSql
  return `COALESCE(${column}, ${defaultSql})`
}

function migrateLegacyProfilesTable() {
  const columns = listColumns('profiles')
  if (columns.length === 0) return

  const hasLegacyProfileFields = ['username', 'icon', 'background'].some((column) => columns.includes(column))
  if (!hasLegacyProfileFields) return
  const columnSet = new Set(columns)

  const migrate = sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE profiles_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        main_implementer TEXT,
        manual_qa_enabled INTEGER NOT NULL DEFAULT 0,
        git_hook_policy TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.gitHookPolicy}',
        ignore_mode TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.ignoreMode}',
        council_members TEXT,
        min_council_quorum INTEGER DEFAULT ${PROFILE_DEFAULTS.minCouncilQuorum},
        per_iteration_timeout INTEGER DEFAULT ${PROFILE_DEFAULTS.perIterationTimeout},
        execution_setup_timeout INTEGER DEFAULT ${PROFILE_DEFAULTS.executionSetupTimeout},
        council_response_timeout INTEGER DEFAULT ${PROFILE_DEFAULTS.councilResponseTimeout},
        interview_questions INTEGER DEFAULT ${PROFILE_DEFAULTS.interviewQuestions},
        coverage_follow_up_budget_percent INTEGER DEFAULT ${PROFILE_DEFAULTS.coverageFollowUpBudgetPercent},
        max_coverage_passes INTEGER DEFAULT ${PROFILE_DEFAULTS.maxCoveragePasses},
        max_prd_coverage_passes INTEGER DEFAULT ${PROFILE_DEFAULTS.maxPrdCoveragePasses},
        max_beads_coverage_passes INTEGER DEFAULT ${PROFILE_DEFAULTS.maxBeadsCoveragePasses},
        structured_retry_count INTEGER DEFAULT ${PROFILE_DEFAULTS.structuredRetryCount},
        max_iterations INTEGER DEFAULT ${PROFILE_DEFAULTS.maxIterations},
        opencode_retry_limit INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeRetryLimit},
        opencode_retry_delay INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeRetryDelay},
        opencode_steps INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeSteps},
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      INSERT INTO profiles_next (
        id,
        main_implementer,
        manual_qa_enabled,
        git_hook_policy,
        ignore_mode,
        council_members,
        min_council_quorum,
        per_iteration_timeout,
        execution_setup_timeout,
        council_response_timeout,
        interview_questions,
        coverage_follow_up_budget_percent,
        max_coverage_passes,
        max_prd_coverage_passes,
        max_beads_coverage_passes,
        structured_retry_count,
        max_iterations,
        opencode_retry_limit,
        opencode_retry_delay,
        opencode_steps,
        created_at,
        updated_at
      )
      SELECT
        id,
        ${selectLegacyProfileColumn(columnSet, 'main_implementer')},
        ${selectLegacyProfileValue(columnSet, 'manual_qa_enabled', 0)},
        ${selectLegacyProfileExpression(columnSet, 'git_hook_policy', `'${PROFILE_DEFAULTS.gitHookPolicy}'`)},
        ${selectLegacyProfileExpression(columnSet, 'ignore_mode', `'${PROFILE_DEFAULTS.ignoreMode}'`)},
        ${selectLegacyProfileColumn(columnSet, 'council_members')},
        ${selectLegacyProfileValue(columnSet, 'min_council_quorum', PROFILE_DEFAULTS.minCouncilQuorum)},
        ${selectLegacyProfileValue(columnSet, 'per_iteration_timeout', PROFILE_DEFAULTS.perIterationTimeout)},
        ${selectLegacyProfileValue(columnSet, 'execution_setup_timeout', PROFILE_DEFAULTS.executionSetupTimeout)},
        ${selectLegacyProfileValue(columnSet, 'council_response_timeout', PROFILE_DEFAULTS.councilResponseTimeout)},
        ${selectLegacyProfileValue(columnSet, 'interview_questions', PROFILE_DEFAULTS.interviewQuestions)},
        ${selectLegacyProfileValue(columnSet, 'coverage_follow_up_budget_percent', PROFILE_DEFAULTS.coverageFollowUpBudgetPercent)},
        ${selectLegacyProfileValue(columnSet, 'max_coverage_passes', PROFILE_DEFAULTS.maxCoveragePasses)},
        ${selectLegacyProfileValue(columnSet, 'max_prd_coverage_passes', PROFILE_DEFAULTS.maxPrdCoveragePasses)},
        ${selectLegacyProfileValue(columnSet, 'max_beads_coverage_passes', PROFILE_DEFAULTS.maxBeadsCoveragePasses)},
        ${selectLegacyProfileValue(columnSet, 'structured_retry_count', PROFILE_DEFAULTS.structuredRetryCount)},
        ${selectLegacyProfileValue(columnSet, 'max_iterations', PROFILE_DEFAULTS.maxIterations)},
        ${selectLegacyProfileValue(columnSet, 'opencode_retry_limit', PROFILE_DEFAULTS.opencodeRetryLimit)},
        ${selectLegacyProfileValue(columnSet, 'opencode_retry_delay', PROFILE_DEFAULTS.opencodeRetryDelay)},
        ${selectLegacyProfileValue(columnSet, 'opencode_steps', PROFILE_DEFAULTS.opencodeSteps)},
        ${selectLegacyProfileExpression(columnSet, 'created_at', "datetime('now')")},
        ${selectLegacyProfileExpression(columnSet, 'updated_at', "datetime('now')")}
      FROM profiles;

      DROP TABLE profiles;
      ALTER TABLE profiles_next RENAME TO profiles;
    `)
  })

  migrate()
}

export function initializeDatabase() {
  // Classify before any DDL runs: migrateLegacyProfilesTable() below drops and
  // recreates `profiles`, so an incompatible database must be refused first.
  const compatibility = assertSchemaCompatible({
    store: sqlite,
    databaseLabel: 'app database',
    databasePath: APP_STORAGE_BOOT_FACTS.dbPath,
    expected: APP_SCHEMA_VERSION,
    migratableFrom: APP_MIGRATABLE_FROM,
    onNotice: (message) => console.warn(message),
  })

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      main_implementer TEXT,
      manual_qa_enabled INTEGER NOT NULL DEFAULT 0,
      git_hook_policy TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.gitHookPolicy}',
      ignore_mode TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.ignoreMode}',
      council_members TEXT,
      min_council_quorum INTEGER DEFAULT ${PROFILE_DEFAULTS.minCouncilQuorum},
      per_iteration_timeout INTEGER DEFAULT ${PROFILE_DEFAULTS.perIterationTimeout},
      execution_setup_timeout INTEGER DEFAULT ${PROFILE_DEFAULTS.executionSetupTimeout},
      council_response_timeout INTEGER DEFAULT ${PROFILE_DEFAULTS.councilResponseTimeout},
      interview_questions INTEGER DEFAULT ${PROFILE_DEFAULTS.interviewQuestions},
      coverage_follow_up_budget_percent INTEGER DEFAULT ${PROFILE_DEFAULTS.coverageFollowUpBudgetPercent},
      max_coverage_passes INTEGER DEFAULT ${PROFILE_DEFAULTS.maxCoveragePasses},
      max_prd_coverage_passes INTEGER DEFAULT ${PROFILE_DEFAULTS.maxPrdCoveragePasses},
      max_beads_coverage_passes INTEGER DEFAULT ${PROFILE_DEFAULTS.maxBeadsCoveragePasses},
      structured_retry_count INTEGER DEFAULT ${PROFILE_DEFAULTS.structuredRetryCount},
      max_iterations INTEGER DEFAULT ${PROFILE_DEFAULTS.maxIterations},
      opencode_retry_limit INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeRetryLimit},
      opencode_retry_delay INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeRetryDelay},
      opencode_steps INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeSteps},
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attached_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `)

  migrateLegacyProfilesTable()
  ensureColumn('profiles', 'coverage_follow_up_budget_percent', `INTEGER DEFAULT ${PROFILE_DEFAULTS.coverageFollowUpBudgetPercent}`)
  ensureColumn('profiles', 'manual_qa_enabled', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn('profiles', 'git_hook_policy', `TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.gitHookPolicy}'`)
  ensureColumn('profiles', 'ignore_mode', `TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.ignoreMode}'`)
  ensureColumn('profiles', 'max_coverage_passes', `INTEGER DEFAULT ${PROFILE_DEFAULTS.maxCoveragePasses}`)
  ensureColumn('profiles', 'max_prd_coverage_passes', `INTEGER DEFAULT ${PROFILE_DEFAULTS.maxPrdCoveragePasses}`)
  ensureColumn('profiles', 'max_beads_coverage_passes', `INTEGER DEFAULT ${PROFILE_DEFAULTS.maxBeadsCoveragePasses}`)
  ensureColumn('profiles', 'structured_retry_count', `INTEGER DEFAULT ${PROFILE_DEFAULTS.structuredRetryCount}`)
  ensureColumn('profiles', 'execution_setup_timeout', `INTEGER DEFAULT ${PROFILE_DEFAULTS.executionSetupTimeout}`)
  ensureColumn('profiles', 'opencode_retry_limit', `INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeRetryLimit}`)
  ensureColumn('profiles', 'opencode_retry_delay', `INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeRetryDelay}`)
  ensureColumn('profiles', 'opencode_steps', `INTEGER DEFAULT ${PROFILE_DEFAULTS.opencodeSteps}`)
  ensureColumn('profiles', 'main_implementer_variant', 'TEXT')
  ensureColumn('profiles', 'council_member_variants', 'TEXT')
  ensureColumn('profiles', 'tool_input_max_chars', `INTEGER DEFAULT ${PROFILE_DEFAULTS.toolInputMaxChars}`)
  ensureColumn('profiles', 'tool_output_max_chars', `INTEGER DEFAULT ${PROFILE_DEFAULTS.toolOutputMaxChars}`)
  ensureColumn('profiles', 'tool_error_max_chars', `INTEGER DEFAULT ${PROFILE_DEFAULTS.toolErrorMaxChars}`)

  sqlite.exec(`
    UPDATE profiles
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
  `)

  // Stamp after all DDL: the database is now at the current schema version.
  if (shouldStampAfterInit(compatibility)) {
    writeUserVersion(sqlite, APP_SCHEMA_VERSION)
  }

  logIfVerbose('[db] App database initialized')
}
