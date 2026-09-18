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

const approvalArrays = {
  acceptanceCriteria: ['The bead is complete.'],
  tests: ['Run the focused test.'],
  targetFiles: ['src/example.ts'],
}

describe('contained bead approval document', () => {
  it('atomically stamps the document while retaining the reviewed hash and updated snapshot', () => {
    const { beadsPath } = fixture()
    const content = JSON.stringify({ id: 'one', title: 'A bead', ...approvalArrays, testCommands: [], testCommandReason: 'Manual verification.' }) + '\n'
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

  it('canonicalises aliased fields and derives the inverse dependency edge', () => {
    const { beadsPath } = fixture()
    const content = [
      {
        id: 'root', title: 'Root', status: 'pending', priority: 1,
        ...approvalArrays,
        testCommands: [{ mode: 'shell', shell: 'posix', script: 'npm test' }],
        dependencies: { blocked_by: [], blocks: ['stale'] },
      },
      {
        id: 'child', title: 'Child', status: 'pending', priority: 2,
        ...approvalArrays,
        test_commands: [{ mode: 'shell', shell: 'posix', script: 'npm test' }],
        dependencies: { blockedBy: ['root'] },
        dependency_metadata: { keep: true },
      },
    ].map((bead) => JSON.stringify(bead)).join('\n') + '\n'
    writeFileSync(beadsPath, content)

    approveBeadsDocument('1:DEMO-1', contentSha256(content))

    const approved = readFileSync(beadsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(approved[1]).toMatchObject({
      testCommands: expect.anything(),
      dependencies: { blocked_by: ['root'], blocks: [] },
      dependency_metadata: { keep: true },
    })
    expect(approved[1]).not.toHaveProperty('test_commands')
    expect(approved[0]!.dependencies).toEqual({ blocked_by: [], blocks: ['child'] })
  })

  it('rejects invalid priority, legacy command text, and dependency graph errors before writing', () => {
    const { beadsPath } = fixture()
    const invalid = JSON.stringify({
      id: 'one', title: 'A bead', status: 'pending', priority: 'high',
      ...approvalArrays,
      testCommands: ['npm test'],
      dependencies: { blocked_by: ['missing'], blocks: [] },
    }) + '\n'
    writeFileSync(beadsPath, invalid)

    expect(() => approveBeadsDocument('1:DEMO-1', contentSha256(invalid))).toThrow(/priority|testCommands|dependency/i)
    expect(readFileSync(beadsPath, 'utf8')).toBe(invalid)
    expect(writeTicketFile).not.toHaveBeenCalled()
  })

  it('rejects an executable bead that omits prompt-required arrays', () => {
    const { beadsPath } = fixture()
    const content = JSON.stringify({
      id: 'one', title: 'A bead', status: 'pending', priority: 1,
      testCommands: [{ mode: 'shell', shell: 'posix', script: 'npm test' }],
      dependencies: { blocked_by: [], blocks: [] },
    }) + '\n'
    writeFileSync(beadsPath, content)

    expect(() => approveBeadsDocument('1:DEMO-1', contentSha256(content))).toThrow(/acceptanceCriteria list/)
    expect(readFileSync(beadsPath, 'utf8')).toBe(content)
    expect(writeTicketFile).not.toHaveBeenCalled()
  })

  it('rejects duplicate IDs before writing an approval stamp', () => {
    const { beadsPath } = fixture()
    const content = [
      { id: 'one', title: 'One', status: 'pending', priority: 1, ...approvalArrays, testCommands: [], testCommandReason: 'Manual check.', dependencies: { blocked_by: [], blocks: [] } },
      { id: 'one', title: 'Again', status: 'pending', priority: 2, ...approvalArrays, testCommands: [], testCommandReason: 'Manual check.', dependencies: { blocked_by: [], blocks: [] } },
    ].map((bead) => JSON.stringify(bead)).join('\n') + '\n'
    writeFileSync(beadsPath, content)

    expect(() => approveBeadsDocument('1:DEMO-1', contentSha256(content))).toThrow(/line 2.*duplicate id "one".*line 1/)
    expect(writeTicketFile).not.toHaveBeenCalled()
  })

  it('rejects an unknown stored status without rewriting the tracker', () => {
    const { beadsPath } = fixture()
    const content = JSON.stringify({ id: 'one', title: 'One', status: 'todo', ...approvalArrays, testCommands: [], testCommandReason: 'Manual check.' }) + '\n'
    writeFileSync(beadsPath, content)
    expect(() => approveBeadsDocument('1:DEMO-1', contentSha256(content))).toThrow(/unrecognised status "todo"/)
    expect(readFileSync(beadsPath, 'utf8')).toBe(content)
    expect(writeTicketFile).not.toHaveBeenCalled()
  })

  it('rejects a circular dependency graph before writing', () => {
    const { beadsPath } = fixture()
    const content = [
      {
        id: 'one', title: 'One', status: 'pending', priority: 1,
        ...approvalArrays,
        testCommands: [{ mode: 'shell', shell: 'posix', script: 'npm test' }],
        dependencies: { blocked_by: ['two'], blocks: [] },
      },
      {
        id: 'two', title: 'Two', status: 'pending', priority: 2,
        ...approvalArrays,
        testCommands: [{ mode: 'shell', shell: 'posix', script: 'npm test' }],
        dependencies: { blocked_by: ['one'], blocks: [] },
      },
    ].map((bead) => JSON.stringify(bead)).join('\n') + '\n'
    writeFileSync(beadsPath, content)

    expect(() => approveBeadsDocument('1:DEMO-1', contentSha256(content))).toThrow(/Circular dependency/)
    expect(readFileSync(beadsPath, 'utf8')).toBe(content)
    expect(writeTicketFile).not.toHaveBeenCalled()
  })

  it('returns a typed validation error when the tracker is missing', () => {
    fixture()

    expect(() => approveBeadsDocument('1:DEMO-1', 'a'.repeat(64))).toThrow(/Beads artifact not found/)
    expect(writeTicketFile).not.toHaveBeenCalled()
  })
})
