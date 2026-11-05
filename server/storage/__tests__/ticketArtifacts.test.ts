import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { broadcaster } from '../../sse/broadcaster'
import { createInitializedTestTicket, createTestRepoManager, resetTestDb } from '../../test/integration'
import { createHash } from 'node:crypto'
import {
  compareAndSetLatestPhaseArtifact,
  forgetArtifactManifestFields,
  getLatestPhaseArtifact,
  insertPhaseArtifact,
  listArtifactManifest,
  listPhaseArtifacts,
  toArtifactManifestEntry,
  upsertLatestPhaseArtifact,
} from '../ticketArtifacts'
import { archiveActivePhaseAttempts, ensureActivePhaseAttempt } from '../ticketPhaseAttempts'

const repoManager = createTestRepoManager('ticket-artifact-cas')

describe('ticket artifact compare-and-set', () => {
  beforeEach(() => resetTestDb())

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('never serves a write the fields of an equal-length write from the same millisecond', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    const open = JSON.stringify({ status: 'open' })
    const done = JSON.stringify({ status: 'done' })
    expect(open.length).toBe(done.length)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    try {
      upsertLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', open)
      expect(listArtifactManifest(ticket.id, { types: ['interview_session'] })[0]?.contentSha256).toBe(sha(open))

      // Same row, same timestamp, same length: only the bytes differ.
      const broadcast = vi.spyOn(broadcaster, 'broadcast').mockClear()
      expect(compareAndSetLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', open, done)).toBe(true)
      expect(broadcast).toHaveBeenCalledWith(ticket.id, 'artifact_change', expect.objectContaining({
        artifact: expect.objectContaining({ contentSha256: sha(done), preview: { status: 'done' } }),
      }))
      const [entry] = listArtifactManifest(ticket.id, { types: ['interview_session'] })
      expect(entry).toMatchObject({ contentSha256: sha(done), preview: { status: 'done' } })
      broadcast.mockRestore()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists artifacts oldest first, whatever their types', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    // Types out of alphabetical order, so a type-ordered index read would show.
    for (const type of ['zeta_report', 'alpha_report', 'mid_report']) {
      insertPhaseArtifact(ticket.id, { phase: 'CODING', artifactType: type, content: '{}' })
    }
    const ids = (artifacts: Array<{ id: number }>) => artifacts.map((artifact) => artifact.id)
    const all = listPhaseArtifacts(ticket.id)
    expect(ids(all)).toEqual([...ids(all)].sort((left, right) => left - right))
    expect(all.map((artifact) => artifact.artifactType)).toEqual(['zeta_report', 'alpha_report', 'mid_report'])
    const typed = listArtifactManifest(ticket.id, { types: ['mid_report', 'zeta_report'] })
    expect(typed.map((artifact) => artifact.artifactType)).toEqual(['zeta_report', 'mid_report'])
  })

  it('updates only the expected latest content and keeps artifact broadcasts', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const first = JSON.stringify({ revision: 1 })
    const second = JSON.stringify({ revision: 2 })
    const stale = JSON.stringify({ revision: 3 })
    upsertLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', first)

    const broadcast = vi.spyOn(broadcaster, 'broadcast').mockClear()
    expect(compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      first,
      second,
    )).toBe(true)
    expect(getLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS')?.content).toBe(second)
    expect(broadcast).toHaveBeenCalledWith(ticket.id, 'artifact_change', expect.objectContaining({
      artifactType: 'interview_session',
    }))

    broadcast.mockClear()
    expect(compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      first,
      stale,
    )).toBe(false)
    expect(getLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS')?.content).toBe(second)
    expect(broadcast).not.toHaveBeenCalled()
    broadcast.mockRestore()
  })

  it('keeps archived phase attempts read-only', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    ensureActivePhaseAttempt(ticket.id, 'WAITING_INTERVIEW_ANSWERS')
    const first = JSON.stringify({ revision: 1 })
    upsertLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', first, 1)
    archiveActivePhaseAttempts(ticket.id, ['WAITING_INTERVIEW_ANSWERS'], 'test archive')

    expect(() => compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      first,
      JSON.stringify({ revision: 2 }),
      1,
    )).toThrow(/Archived WAITING_INTERVIEW_ANSWERS attempt 1 is read-only/)
  })

  it('does not update a historical matching row when a newer row differs', async () => {
    const { ticket } = await createInitializedTestTicket(repoManager)
    const historical = JSON.stringify({ revision: 1 })
    const current = JSON.stringify({ revision: 2 })
    const replacement = JSON.stringify({ revision: 3 })
    upsertLatestPhaseArtifact(ticket.id, 'interview_session', 'WAITING_INTERVIEW_ANSWERS', historical)
    insertPhaseArtifact(ticket.id, {
      phase: 'WAITING_INTERVIEW_ANSWERS',
      artifactType: 'interview_session',
      content: current,
    })

    const broadcast = vi.spyOn(broadcaster, 'broadcast').mockClear()
    expect(compareAndSetLatestPhaseArtifact(
      ticket.id,
      'interview_session',
      'WAITING_INTERVIEW_ANSWERS',
      historical,
      replacement,
    )).toBe(false)
    expect(listPhaseArtifacts(ticket.id, {
      phase: 'WAITING_INTERVIEW_ANSWERS',
    }).map((artifact) => artifact.content)).toEqual([historical, current])
    expect(broadcast).not.toHaveBeenCalled()
    broadcast.mockRestore()
  })
})

describe('artifact manifest entries', () => {
  const row = {
    id: 7,
    ticketId: 1,
    phase: 'WAITING_PRD_APPROVAL',
    phaseAttempt: 1,
    artifactType: 'prd',
    content: '{"title":"First"}',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  it('hashes and previews an unchanged artifact version once', () => {
    const parse = vi.spyOn(JSON, 'parse')
    try {
      const first = toArtifactManifestEntry('1:CACHE-1', row)
      const second = toArtifactManifestEntry('1:CACHE-1', row)
      expect(second).toEqual(first)
      expect(first).toMatchObject({ contentByteCount: 17, preview: { title: 'First' } })
      expect(parse.mock.calls.filter(([text]) => text === row.content)).toHaveLength(1)
    } finally {
      parse.mockRestore()
    }
  })

  it('computes a new version again', () => {
    const first = toArtifactManifestEntry('1:CACHE-2', row)
    const updated = toArtifactManifestEntry('1:CACHE-2', { ...row, content: '{"title":"Second"}', updatedAt: '2026-01-01T00:00:01.000Z' })
    expect(updated.preview).toEqual({ title: 'Second' })
    expect(updated.contentSha256).not.toBe(first.contentSha256)
  })

  it('recomputes an artifact whose cached fields were forgotten', () => {
    toArtifactManifestEntry('1:CACHE-4', row)
    // A rollback restoring the same id, timestamp and length with other bytes.
    const restored = { ...row, content: row.content.replace('First', 'Fir5t') }
    expect(restored.content.length).toBe(row.content.length)
    expect(toArtifactManifestEntry('1:CACHE-4', restored).preview).toEqual({ title: 'First' })
    forgetArtifactManifestFields('1:CACHE-4', row.id)
    expect(toArtifactManifestEntry('1:CACHE-4', restored).preview).toEqual({ title: 'Fir5t' })
  })

  it('gives every caller its own preview object', () => {
    const first = toArtifactManifestEntry('1:CACHE-3', row)
    first.preview.title = 'changed by a caller'
    expect(toArtifactManifestEntry('1:CACHE-3', row).preview).toEqual({ title: 'First' })
  })
})
