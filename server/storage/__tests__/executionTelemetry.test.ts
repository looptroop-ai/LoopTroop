import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from '../../db/schema'
import { beadExecutionMetrics } from '../../db/schema'
import {
  bucketForBeadCount,
  getThroughputSamples,
  getTicketBeadSamples,
} from '../executionTelemetry'

type ProjectDb = ReturnType<typeof makeDb>

/**
 * Builds an isolated in-memory project DB containing only the metrics table. The DDL mirrors the
 * `bead_execution_metrics` block in `server/db/project.ts`.
 */
function makeDb() {
  const sqlite = new Database(':memory:')
  sqlite.exec(`
    CREATE TABLE bead_execution_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id INTEGER NOT NULL,
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
  `)
  // @ts-expect-error Drizzle 1.0 RC removes `schema` from the config type but accepts it at runtime
  return drizzle({ client: sqlite, schema })
}

function insertMetric(
  db: ProjectDb,
  row: {
    ticketId: number
    sizeBucket: 'S' | 'M' | 'L'
    effortTier: string
    activeDurationMs: number
    iterations?: number
    completedAt: string
  },
) {
  db.insert(beadExecutionMetrics).values({
    ticketId: row.ticketId,
    beadId: `bead-${row.completedAt}`,
    sizeBucket: row.sizeBucket,
    effortTier: row.effortTier,
    iterations: row.iterations ?? 1,
    activeDurationMs: row.activeDurationMs,
    wallClockMs: null,
    completedAt: row.completedAt,
    schemaVersion: 1,
  }).run()
}

describe('bucketForBeadCount', () => {
  it('classifies by total bead count', () => {
    expect(bucketForBeadCount(1)).toBe('S')
    expect(bucketForBeadCount(5)).toBe('S')
    expect(bucketForBeadCount(6)).toBe('M')
    expect(bucketForBeadCount(12)).toBe('M')
    expect(bucketForBeadCount(13)).toBe('L')
    expect(bucketForBeadCount(40)).toBe('L')
  })
})

describe('getThroughputSamples', () => {
  it('prefers the (size + effort) tier when it has enough samples', () => {
    const db = makeDb()
    for (let i = 0; i < 5; i += 1) {
      insertMetric(db, { ticketId: 1, sizeBucket: 'M', effortTier: 'medium', activeDurationMs: 1000, completedAt: `2026-01-01T00:0${i}:00Z` })
    }
    // Noise in other tiers that must not be returned when the exact tier is rich enough.
    insertMetric(db, { ticketId: 1, sizeBucket: 'S', effortTier: 'high', activeDurationMs: 9999, completedAt: '2026-01-02T00:00:00Z' })

    const samples = getThroughputSamples(db, { effortTier: 'medium', sizeBucket: 'M', excludeTicketId: 99 })
    expect(samples).toHaveLength(5)
    expect(samples.every((s) => s.activeDurationMs === 1000)).toBe(true)
  })

  it('falls back to effort-only when the exact bucket is too small', () => {
    const db = makeDb()
    // Only 2 rows for (M, medium) — below the threshold.
    for (let i = 0; i < 2; i += 1) {
      insertMetric(db, { ticketId: 1, sizeBucket: 'M', effortTier: 'medium', activeDurationMs: 1000, completedAt: `2026-01-01T00:0${i}:00Z` })
    }
    // 5 more (S, medium) rows push the effort-only tier over the threshold.
    for (let i = 0; i < 5; i += 1) {
      insertMetric(db, { ticketId: 1, sizeBucket: 'S', effortTier: 'medium', activeDurationMs: 2000, completedAt: `2026-01-03T00:0${i}:00Z` })
    }

    const samples = getThroughputSamples(db, { effortTier: 'medium', sizeBucket: 'M', excludeTicketId: 99 })
    expect(samples).toHaveLength(7) // all 'medium' rows regardless of size
  })

  it('falls back to the broadest available set when no tier qualifies', () => {
    const db = makeDb()
    insertMetric(db, { ticketId: 1, sizeBucket: 'L', effortTier: 'low', activeDurationMs: 3000, completedAt: '2026-01-01T00:00:00Z' })
    insertMetric(db, { ticketId: 2, sizeBucket: 'S', effortTier: 'low', activeDurationMs: 3000, completedAt: '2026-01-01T00:01:00Z' })

    // Query a tier with no matches; should still return the two "any prior" rows.
    const samples = getThroughputSamples(db, { effortTier: 'high', sizeBucket: 'M', excludeTicketId: 99 })
    expect(samples).toHaveLength(2)
  })

  it('always excludes the current ticket', () => {
    const db = makeDb()
    for (let i = 0; i < 6; i += 1) {
      insertMetric(db, { ticketId: 7, sizeBucket: 'M', effortTier: 'medium', activeDurationMs: 1000, completedAt: `2026-01-01T00:0${i}:00Z` })
    }

    const samples = getThroughputSamples(db, { effortTier: 'medium', sizeBucket: 'M', excludeTicketId: 7 })
    expect(samples).toHaveLength(0)
  })
})

describe('getTicketBeadSamples', () => {
  it('returns this ticket rows ordered oldest -> newest', () => {
    const db = makeDb()
    insertMetric(db, { ticketId: 3, sizeBucket: 'S', effortTier: 'medium', activeDurationMs: 300, completedAt: '2026-01-01T00:03:00Z' })
    insertMetric(db, { ticketId: 3, sizeBucket: 'S', effortTier: 'medium', activeDurationMs: 100, completedAt: '2026-01-01T00:01:00Z' })
    insertMetric(db, { ticketId: 3, sizeBucket: 'S', effortTier: 'medium', activeDurationMs: 200, completedAt: '2026-01-01T00:02:00Z' })
    insertMetric(db, { ticketId: 4, sizeBucket: 'S', effortTier: 'medium', activeDurationMs: 999, completedAt: '2026-01-01T00:04:00Z' })

    const samples = getTicketBeadSamples(db, 3)
    expect(samples.map((s) => s.activeDurationMs)).toEqual([100, 200, 300])
  })
})
