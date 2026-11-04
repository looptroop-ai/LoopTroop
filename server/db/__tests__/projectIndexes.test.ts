import { afterEach, describe, expect, it } from 'vitest'
import { clearProjectDatabaseCache, getProjectDatabase } from '../project'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

describe('project database indexes', () => {
  const roots: string[] = []
  afterEach(() => {
    clearProjectDatabaseCache()
    for (const root of roots.splice(0)) removeTempDir(root)
  })

  it('finds the latest artifact of a type for a ticket through the ticket+type index', () => {
    const root = makeTempDir('looptroop-project-indexes-')
    roots.push(root)
    const { sqlite } = getProjectDatabase(root)
    const plan = (sql: string) => (sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 'cleanup_report') as Array<{ detail: string }>)
      .map((row) => row.detail)
      .join(' | ')

    expect(plan('SELECT * FROM phase_artifacts WHERE ticket_id = ? AND artifact_type = ? ORDER BY id DESC LIMIT 1'))
      .toContain('USING INDEX idx_phase_artifacts_ticket_type (ticket_id=? AND artifact_type=?)')
    expect(plan('SELECT * FROM phase_artifacts WHERE ticket_id = ? AND artifact_type = ? ORDER BY id DESC LIMIT 1'))
      .not.toContain('TEMP B-TREE')
  })
})
