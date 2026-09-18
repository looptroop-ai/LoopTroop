import { afterEach, describe, expect, it } from 'vitest'
import { getTableName } from 'drizzle-orm'
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { SQLInputValue } from 'node:sqlite'
import { getProjectDatabase, clearProjectDatabaseCache } from '../project'
import * as schema from '../schema'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

const ORPHAN_TICKET_ID = 999999

interface TicketForeignKey {
  table: string
  column: string
  onDelete: string | undefined
}

interface OrphanFixture {
  insertSql: string
  insertParams: unknown[]
  selectSql: string
  selectParams: unknown[]
  orphanColumn: string
}

/**
 * Keep this regression tied to schema.ts rather than a second hand-maintained
 * list. Adding a ticket foreign key without adding a fixture should fail the
 * test and force the initialization cleanup contract to be revisited.
 */
function ticketForeignKeys(): TicketForeignKey[] {
  return Object.values(schema).flatMap((candidate) => {
    try {
      const config = getTableConfig(candidate as SQLiteTable)
      return config.foreignKeys.flatMap((foreignKey) => {
        const reference = foreignKey.reference()
        const foreignColumn = reference.foreignColumns[0]
        const localColumn = reference.columns[0]
        const referencedTable = (foreignColumn as unknown as {
          table?: Parameters<typeof getTableName>[0]
        } | undefined)?.table
        if (!foreignColumn || !localColumn || !referencedTable || getTableName(referencedTable) !== 'tickets') return []
        return [{
          table: config.name,
          column: localColumn.name,
          onDelete: foreignKey.onDelete,
        }]
      })
    } catch {
      return []
    }
  })
}

const orphanFixtures: Record<string, OrphanFixture> = {
  phase_artifacts: {
    insertSql: `INSERT INTO phase_artifacts (ticket_id, phase, artifact_type, content) VALUES (?, ?, ?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 'CODING', 'orphan-fk', '{}'],
    selectSql: `SELECT ticket_id FROM phase_artifacts WHERE artifact_type = ?`,
    selectParams: ['orphan-fk'],
    orphanColumn: 'ticket_id',
  },
  manual_qa_operations: {
    insertSql: `INSERT INTO manual_qa_operations (ticket_id, action_id, version, checklist_hash, draft_revision, payload) VALUES (?, ?, ?, ?, ?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 'orphan-fk', 1, 'hash', 1, '{}'],
    selectSql: `SELECT ticket_id FROM manual_qa_operations WHERE action_id = ?`,
    selectParams: ['orphan-fk'],
    orphanColumn: 'ticket_id',
  },
  manual_qa_improvement_tickets: {
    insertSql: `INSERT INTO manual_qa_improvement_tickets (origin_id, destination_ticket_id, action_id) VALUES (?, ?, ?)`,
    insertParams: ['orphan-fk', ORPHAN_TICKET_ID, 'orphan-fk'],
    selectSql: `SELECT destination_ticket_id FROM manual_qa_improvement_tickets WHERE origin_id = ?`,
    selectParams: ['orphan-fk'],
    orphanColumn: 'destination_ticket_id',
  },
  ticket_phase_attempts: {
    insertSql: `INSERT INTO ticket_phase_attempts (ticket_id, phase, attempt_number) VALUES (?, ?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 'ORPHAN_FK', 999],
    selectSql: `SELECT ticket_id FROM ticket_phase_attempts WHERE phase = ?`,
    selectParams: ['ORPHAN_FK'],
    orphanColumn: 'ticket_id',
  },
  opencode_sessions: {
    insertSql: `INSERT INTO opencode_sessions (session_id, ticket_id, phase, state) VALUES (?, ?, ?, ?)`,
    insertParams: ['remote-session-orphan', ORPHAN_TICKET_ID, 'CODING', 'active'],
    selectSql: `SELECT ticket_id FROM opencode_sessions WHERE session_id = ?`,
    selectParams: ['remote-session-orphan'],
    orphanColumn: 'ticket_id',
  },
  ticket_status_history: {
    insertSql: `INSERT INTO ticket_status_history (ticket_id, new_status) VALUES (?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 'ORPHAN_FK'],
    selectSql: `SELECT ticket_id FROM ticket_status_history WHERE new_status = ?`,
    selectParams: ['ORPHAN_FK'],
    orphanColumn: 'ticket_id',
  },
  ticket_error_occurrences: {
    insertSql: `INSERT INTO ticket_error_occurrences (ticket_id, occurrence_number, blocked_from_status) VALUES (?, ?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 999, 'ORPHAN_FK'],
    selectSql: `SELECT ticket_id FROM ticket_error_occurrences WHERE occurrence_number = ?`,
    selectParams: [999],
    orphanColumn: 'ticket_id',
  },
  interview_batch_claims: {
    insertSql: `INSERT INTO interview_batch_claims (ticket_id, token, claimed_at, expires_at) VALUES (?, ?, ?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 'orphan-fk', '2020-01-01T00:00:00.000Z', '2020-01-01T00:01:00.000Z'],
    selectSql: `SELECT ticket_id FROM interview_batch_claims WHERE token = ?`,
    selectParams: ['orphan-fk'],
    orphanColumn: 'ticket_id',
  },
  question_waits: {
    insertSql: `INSERT INTO question_waits (ticket_id, started_at) VALUES (?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, '2020-01-01T00:00:00.000Z'],
    selectSql: `SELECT ticket_id FROM question_waits WHERE started_at = ?`,
    selectParams: ['2020-01-01T00:00:00.000Z'],
    orphanColumn: 'ticket_id',
  },
  bead_execution_metrics: {
    insertSql: `INSERT INTO bead_execution_metrics (ticket_id, bead_id, size_bucket, effort_tier, active_duration_ms, completed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 'orphan-fk', 'S', 'medium', 1, '2020-01-01T00:00:00.000Z'],
    selectSql: `SELECT ticket_id FROM bead_execution_metrics WHERE bead_id = ?`,
    selectParams: ['orphan-fk'],
    orphanColumn: 'ticket_id',
  },
  ticket_ai_turn_metrics: {
    insertSql: `INSERT INTO ticket_ai_turn_metrics (ticket_id, phase, session_id, assistant_message_id, model_id) VALUES (?, ?, ?, ?, ?)`,
    insertParams: [ORPHAN_TICKET_ID, 'CODING', 'orphan-fk', 'orphan-fk', 'model'],
    selectSql: `SELECT ticket_id FROM ticket_ai_turn_metrics WHERE assistant_message_id = ?`,
    selectParams: ['orphan-fk'],
    orphanColumn: 'ticket_id',
  },
}

describe('project database OpenCode session orphans', () => {
  let projectRoot: string | undefined

  afterEach(() => {
    clearProjectDatabaseCache()
    if (projectRoot) removeTempDir(projectRoot)
    projectRoot = undefined
  })

  it('cleans every ticket foreign-key orphan and detaches OpenCode sessions', () => {
    projectRoot = makeTempDir('looptroop-opencode-orphan-')
    const first = getProjectDatabase(projectRoot)
    const foreignKeys = ticketForeignKeys()
    const fixtureNames = Object.keys(orphanFixtures).sort()
    expect(foreignKeys.map((foreignKey) => foreignKey.table).sort()).toEqual(fixtureNames)

    first.sqlite.pragma('foreign_keys=OFF')
    for (const foreignKey of foreignKeys) {
      const fixture = orphanFixtures[foreignKey.table]!
      first.sqlite.prepare(fixture.insertSql).run(...fixture.insertParams as SQLInputValue[])
    }

    clearProjectDatabaseCache()
    const reopened = getProjectDatabase(projectRoot)
    for (const foreignKey of foreignKeys) {
      const fixture = orphanFixtures[foreignKey.table]!
      const rows = reopened.sqlite.prepare(fixture.selectSql).all(...fixture.selectParams as SQLInputValue[]) as Array<Record<string, unknown>>
      if (foreignKey.onDelete === 'set null') {
        expect(rows).toHaveLength(1)
        expect(rows[0]?.[fixture.orphanColumn]).toBeNull()
      } else {
        expect(rows).toHaveLength(0)
      }
    }
  })
})
