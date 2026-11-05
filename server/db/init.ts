import { sqlite, APP_STORAGE_BOOT_FACTS, closeDatabase } from './index'
import { PROFILE_DEFAULTS } from './defaults'
import { logIfVerbose } from '../runtime'
import {
  APP_DATABASE_LABEL,
  APP_SCHEMA_VERSION,
  appDatabaseResetInstructions,
  assertSchemaCompatible,
  shouldStampAfterInit,
  writeUserVersion,
} from './schemaVersion'

export function initializeDatabase() {
  // Classify before any DDL runs: a database from another version is refused
  // with its tables and data as they were.
  let compatibility: ReturnType<typeof assertSchemaCompatible>
  try {
    compatibility = assertSchemaCompatible({
      store: sqlite,
      databaseLabel: APP_DATABASE_LABEL,
      databasePath: APP_STORAGE_BOOT_FACTS.dbPath,
      expected: APP_SCHEMA_VERSION,
      resetInstructions: appDatabaseResetInstructions(APP_STORAGE_BOOT_FACTS.dbPath),
    })
  } catch (error) {
    closeDatabase()
    throw error
  }

  // One transaction with the stamp, as in project.ts: an interrupted first start
  // must leave a fresh database, not tables with no version.
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        main_implementer TEXT,
        main_implementer_variant TEXT,
        chat_model TEXT,
        chat_model_variant TEXT,
        save_chat_sessions INTEGER NOT NULL DEFAULT ${PROFILE_DEFAULTS.saveChatSessions ? 1 : 0},
        council_members TEXT,
        council_member_variants TEXT,
        manual_qa_enabled INTEGER NOT NULL DEFAULT ${PROFILE_DEFAULTS.manualQaEnabled ? 1 : 0},
        ai_questions_enabled INTEGER NOT NULL DEFAULT ${PROFILE_DEFAULTS.aiQuestionsEnabled ? 1 : 0},
        ai_question_window INTEGER DEFAULT ${PROFILE_DEFAULTS.aiQuestionWindow},
        git_hook_policy TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.gitHookPolicy}',
        ignore_mode TEXT NOT NULL DEFAULT '${PROFILE_DEFAULTS.ignoreMode}',
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
        tool_input_max_chars INTEGER DEFAULT ${PROFILE_DEFAULTS.toolInputMaxChars},
        tool_output_max_chars INTEGER DEFAULT ${PROFILE_DEFAULTS.toolOutputMaxChars},
        tool_error_max_chars INTEGER DEFAULT ${PROFILE_DEFAULTS.toolErrorMaxChars},
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
    if (shouldStampAfterInit(compatibility)) writeUserVersion(sqlite, APP_SCHEMA_VERSION)
  })()

  logIfVerbose('[db] App database initialized')
}
