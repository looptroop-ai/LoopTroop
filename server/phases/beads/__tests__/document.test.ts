import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { approveBeadsDocument, upsertBeadsApprovalSnapshot } from '../document'
import { getTicketPaths, writeTicketFile } from '../../../storage/tickets'
import { upsertLatestPhaseArtifact } from '../../../storage/ticketArtifacts'
import { safeAtomicWriteWithin } from '../../../io/atomicWrite'
import { contentSha256 } from '../../../lib/contentHash'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'

vi.mock('../../../storage/tickets', () => ({ getTicketPaths: vi.fn(), writeTicketFile: vi.fn() }))
vi.mock('../../../storage/ticketArtifacts', () => ({ upsertLatestPhaseArtifact: vi.fn() }))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root)
  vi.clearAllMocks()
})

function fixture() {
  const ticketDir = makeTempDir('bead-approval-contained-')
  roots.push(ticketDir)
  const beadsPath = join(ticketDir, 'beads', 'issues.jsonl')
  mkdirSync(join(ticketDir, 'beads'))
  vi.mocked(getTicketPaths).mockReturnValue({ ticketDir, beadsPath } as NonNullable<ReturnType<typeof getTicketPaths>>)
  vi.mocked(writeTicketFile).mockImplementation((_ticketId, path, content) => safeAtomicWriteWithin(ticketDir, path, content))
  return { ticketDir, beadsPath }
}

describe('contained bead approval document', () => {
  it('atomically stamps the document while retaining the reviewed hash and updated snapshot', () => {
    const { beadsPath } = fixture()
    const content = JSON.stringify({ id: 'one', title: 'A bead', testCommands: [], testCommandReason: 'Manual verification.' }) + '\n'
    writeFileSync(beadsPath, content)
    const reviewedHash = contentSha256(content)
    const approved = approveBeadsDocument('1:DEMO-1', reviewedHash)
    expect(approved.contentSha256).toBe(reviewedHash)
    expect(writeTicketFile).toHaveBeenCalledWith('1:DEMO-1', expect.any(String), expect.any(String))
    const updated = readFileSync(beadsPath, 'utf8')
    expect(JSON.parse(updated).createdAt).toBe(approved.approvedAt)
    expect(upsertLatestPhaseArtifact).toHaveBeenCalledWith('1:DEMO-1', 'approval_snapshot:beads', 'WAITING_BEADS_APPROVAL', JSON.stringify({
      raw: updated, content_sha256: contentSha256(updated),
    }))
  })

  it('rejects a replaced final link before approving or snapshotting it', () => {
    const { beadsPath } = fixture()
    const outside = makeTempDir('bead-approval-outside-')
    roots.push(outside)
    symlinkSync(outside, beadsPath, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => approveBeadsDocument('1:DEMO-1', 'a'.repeat(64))).toThrow()
    expect(() => upsertBeadsApprovalSnapshot('1:DEMO-1')).toThrow()
    expect(writeTicketFile).not.toHaveBeenCalled()
    expect(upsertLatestPhaseArtifact).not.toHaveBeenCalled()
  })
})
