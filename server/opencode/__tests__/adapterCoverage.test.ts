import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TEST } from '../../test/factories'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { getLatestPhaseArtifact, getTicketContext, getTicketPaths, readTicketFile } from '../../storage/tickets'
import { OpenCodeSDKAdapter } from '../adapter'

vi.mock('../../storage/tickets', () => ({
  getTicketContext: vi.fn(),
  getTicketPaths: vi.fn(),
  getLatestPhaseArtifact: vi.fn(),
  readTicketFile: vi.fn(),
}))

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) removeTempDir(dir)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('OpenCode adapter remaining coverage', () => {
  it('keeps available context when an optional ticket artifact cannot be read', async () => {
    const ticketDir = makeTempDir('adapter-coverage-optional-artifact-')
    tempDirs.push(ticketDir)
    vi.mocked(getTicketContext).mockReturnValue({
      ticketRef: TEST.ticketId,
      projectId: TEST.projectId,
      localTicket: { title: 'Test ticket', description: 'Use the saved product requirements.' },
    } as NonNullable<ReturnType<typeof getTicketContext>>)
    vi.mocked(getTicketPaths).mockReturnValue({
      ticketDir,
      beadsPath: join(ticketDir, 'beads.jsonl'),
    } as NonNullable<ReturnType<typeof getTicketPaths>>)
    vi.mocked(getLatestPhaseArtifact).mockReturnValue(undefined)
    vi.mocked(readTicketFile).mockImplementation((_ticketId, file) => {
      if (file === 'interview.yaml' || file === 'runtime/execution-setup-profile.json') {
        throw new Error(`Cannot read ${file}`)
      }
      return file === 'prd.yaml' ? 'approved product requirements' : null
    })

    const parts = await new OpenCodeSDKAdapter().assembleCouncilContext(TEST.ticketId, 'beads_draft')

    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'ticket_details', content: expect.stringContaining('Test ticket') }),
      expect.objectContaining({ source: 'prd', content: 'approved product requirements' }),
    ]))
    expect(parts.some((part) => part.source === 'interview')).toBe(false)
  })

  it('treats an absent Manual QA bead manifest as no attached evidence', async () => {
    const ticketDir = makeTempDir('adapter-coverage-missing-manifest-')
    tempDirs.push(ticketDir)
    vi.mocked(getTicketPaths).mockReturnValue({
      ticketDir,
      beadsPath: join(ticketDir, 'beads.jsonl'),
    } as NonNullable<ReturnType<typeof getTicketPaths>>)

    await expect(new OpenCodeSDKAdapter().assembleBeadContext(TEST.ticketId, 'bead'))
      .resolves.toEqual([])
  })

  it('surfaces malformed authoritative Manual QA manifests with the bead context', async () => {
    const ticketDir = makeTempDir('adapter-coverage-malformed-manifest-')
    tempDirs.push(ticketDir)
    const beadsPath = join(ticketDir, 'beads.jsonl')
    writeFileSync(beadsPath, '{invalid json}\n')
    vi.mocked(getTicketPaths).mockReturnValue({
      ticketDir,
      beadsPath,
    } as NonNullable<ReturnType<typeof getTicketPaths>>)

    await expect(new OpenCodeSDKAdapter().assembleBeadContext(TEST.ticketId, 'bead'))
      .rejects.toThrow('Failed to load Manual QA evidence manifest for bead bead:')
  })
})
