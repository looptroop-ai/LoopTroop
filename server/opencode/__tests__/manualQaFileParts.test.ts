import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import { OpenCodeV1Transport } from '../v1Transport'
import type { PromptPart } from '../types'
import { getTicketContext, getTicketPaths, readTicketFile } from '../../storage/tickets'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { readManualQaText } from '../../phases/manualQa/storage'
import * as runtime from '../../runtime'

vi.mock('../../storage/tickets', () => ({
  getTicketPaths: vi.fn(),
  readTicketFile: vi.fn(),
  getTicketContext: vi.fn(),
  getLatestPhaseArtifact: vi.fn(),
  listPhaseArtifacts: vi.fn(),
  listPhaseAttempts: vi.fn(),
}))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

interface AdapterPartitionProbe {
  loadTicketState(ticketId: string): Promise<Record<string, unknown>>
  loadQaEvidenceFileParts(ticketId: string, beadId: string): Promise<PromptPart[]>
}

interface PromptPartitionProbe {
  partitionPromptParts(parts: PromptPart[], fallbackSystem?: string, includeImageFiles?: boolean): {
    systemText: string
    promptParts: Array<{ type: string; text?: string; mime?: string; filename?: string; url?: string }>
  }
}

function probe(adapter: OpenCodeSDKAdapter): AdapterPartitionProbe {
  return adapter as unknown as AdapterPartitionProbe
}

function promptPartitionProbe(): PromptPartitionProbe {
  return new OpenCodeV1Transport('http://127.0.0.1:9', {} as never) as unknown as PromptPartitionProbe
}

describe('OpenCode Manual QA file parts', () => {
  it('does not warn about beads that have not been generated yet', async () => {
    const ticketDir = makeTempDir('adapter-missing-beads-')
    roots.push(ticketDir)
    const warn = vi.spyOn(runtime, 'warnIfVerbose')
    vi.mocked(getTicketContext).mockReturnValue({ localTicket: { title: 'Draft' } } as NonNullable<ReturnType<typeof getTicketContext>>)
    vi.mocked(getTicketPaths).mockReturnValue({ ticketDir, beadsPath: join(ticketDir, 'beads.jsonl') } as NonNullable<ReturnType<typeof getTicketPaths>>)
    vi.mocked(readTicketFile).mockReturnValue(null)
    await probe(new OpenCodeSDKAdapter('http://127.0.0.1:9')).loadTicketState('1:DEMO-1')
    expect(warn).not.toHaveBeenCalled()
  })

  it('assembles formatted bead guidance, test requirements, QA origin, and retry notes', async () => {
    const ticketDir = makeTempDir('adapter-bead-context-')
    roots.push(ticketDir)
    const beadsPath = join(ticketDir, 'beads.jsonl')
    writeFileSync(beadsPath, JSON.stringify({
      id: 'bead-context',
      status: 'pending',
      title: 'Preserve adapter context',
      description: 'Keep the prompt grounded in approved bead details.',
      prdRefs: ['EPIC-1 / US-1'],
      contextGuidance: {
        patterns: ['Keep changes local'],
        anti_patterns: ['Avoid global state'],
      },
      acceptanceCriteria: ['The prompt includes every approved requirement.'],
      tests: ['Run the focused adapter tests.'],
      testCommands: [{ mode: 'shell', shell: 'posix', script: 'npm test', cwd: '.', env: {} }],
      dependencies: { blocked_by: ['bead-previous'], blocks: ['bead-next'] },
      targetFiles: ['server/opencode/adapter.ts'],
      failedIterationNotes: [{ timestamp: '2025-01-01T00:00:00.000Z', iteration: 1, errorCode: 'E_TEST', content: 'The focused test failed.' }],
      userRetryNotes: [{ timestamp: '2025-01-02T00:00:00.000Z', iteration: 2, content: 'Keep the change narrowly scoped.' }],
      finalizationFailureNotes: [{ timestamp: '2025-01-03T00:00:00.000Z', iteration: 2, content: 'Finalization did not complete.' }],
      qaOrigin: {
        schemaVersion: 1,
        actionId: 'action-1',
        sourceTicketId: 'source-ticket',
        sourceTicketExternalId: 'DEMO-1',
        version: 3,
        modelId: null,
        modelSupportsImages: null,
        createdFromManualQaAt: '2025-01-04T00:00:00.000Z',
        imageDelivery: 'attached',
        sourceItems: [{
          itemId: 'qa-item',
          lineageId: 'lineage-1',
          behavior: 'The session preserves the project directory.',
          observation: 'The context listed the wrong working tree.',
          expectedResult: 'The context uses the trusted working tree.',
          evidence: [{
            id: 'evidence-1',
            originalName: 'notes.txt',
            mediaType: 'text/plain',
            size: 12,
            sha256: 'a'.repeat(64),
            relativePath: 'manual-qa/v3/evidence/qa-item/notes.txt',
          }],
          links: [
            { id: 'link-1', url: 'https://example.test/spec', label: 'Approved spec' },
            { id: 'link-2', url: 'https://example.test/issue' },
          ],
        }, {
          itemId: 'qa-item-without-evidence',
          lineageId: 'lineage-2',
          behavior: 'No attachment is available.',
          observation: 'The source item has no evidence files.',
          expectedResult: 'The text origin still appears in context.',
          evidence: [],
          links: [],
        }],
      },
    }) + '\n')
    vi.mocked(getTicketContext).mockReturnValue({
      ticketRef: '1:DEMO-1',
      projectId: 1,
      localTicket: { title: 'Adapter context ticket', description: 'The original ticket description.' },
    } as NonNullable<ReturnType<typeof getTicketContext>>)
    vi.mocked(getTicketPaths).mockReturnValue({ ticketDir, beadsPath } as NonNullable<ReturnType<typeof getTicketPaths>>)
    vi.mocked(readTicketFile).mockReturnValue(null)

    const parts = await new OpenCodeSDKAdapter('http://127.0.0.1:9').assembleBeadContext('1:DEMO-1', 'bead-context')
    const beadData = parts.find((part) => part.source === 'bead_data')?.content ?? ''
    const notes = parts.filter((part) => part.source === 'bead_note').map((part) => part.content)

    expect(beadData).toContain('Patterns:\n- Keep changes local\nAnti-patterns:\n- Avoid global state')
    expect(beadData).toContain('- The prompt includes every approved requirement.')
    expect(beadData).toContain('- server/opencode/adapter.ts')
    expect(beadData).toContain('- npm test')
    expect(beadData).toContain('- bead-previous')
    expect(beadData).toContain('Manual QA Fix Origin\nRound: v3')
    expect(beadData).toContain('Evidence: notes.txt (text/plain, sha256 ')
    expect(beadData).toContain('Evidence link: Approved spec: https://example.test/spec')
    expect(beadData).toContain('Evidence link: https://example.test/issue')
    expect(beadData).toContain('Item qa-item-without-evidence: No attachment is available.')
    expect(beadData).toContain('  Evidence: none')
    expect(notes).toEqual(expect.arrayContaining([
      expect.stringContaining('Error code: E_TEST\nThe focused test failed.'),
      expect.stringContaining('Keep the change narrowly scoped.'),
      expect.stringContaining('Finalization did not complete.'),
    ]))
  })

  it('uses the no-guidance, no-target, no-dependency, and no-evidence fallbacks', async () => {
    const ticketDir = makeTempDir('adapter-minimal-bead-context-')
    roots.push(ticketDir)
    const beadsPath = join(ticketDir, 'beads.jsonl')
    writeFileSync(beadsPath, JSON.stringify({
      id: 'minimal',
      status: 'pending',
      title: 'Minimal bead',
      description: 'No optional guidance is provided.',
      acceptanceCriteria: [],
      tests: [],
      testCommands: [],
      targetFiles: [],
    }) + '\n')
    vi.mocked(getTicketContext).mockReturnValue(undefined)
    vi.mocked(getTicketPaths).mockReturnValue({ ticketDir, beadsPath } as NonNullable<ReturnType<typeof getTicketPaths>>)
    vi.mocked(readTicketFile).mockReturnValue(null)

    const parts = await new OpenCodeSDKAdapter('http://127.0.0.1:9').assembleBeadContext('minimal-ticket', 'minimal')
    const beadData = parts.find((part) => part.source === 'bead_data')?.content ?? ''

    expect(beadData).toContain('No additional guidance provided.')
    expect(beadData).toContain('- No target files listed.')
    expect(beadData).toContain('## Dependencies (blocked by)\n- None')
    expect(beadData).not.toContain('Manual QA Fix Origin')
    expect(parts.filter((part) => part.source === 'bead_note')).toEqual([])
  })

  it('assembles no bead context when the ticket has no stored directory', async () => {
    vi.mocked(getTicketContext).mockReturnValue(undefined)
    vi.mocked(getTicketPaths).mockReturnValue(undefined)

    await expect(new OpenCodeSDKAdapter('http://127.0.0.1:9').assembleBeadContext('missing-ticket', 'missing-bead'))
      .resolves.toEqual([])
  })

  it.each(['interview.yaml', 'prd.yaml', 'runtime/execution-setup-profile.json', 'beads.jsonl'])('rejects linked %s before loading model context', async (file) => {
    const ticketDir = makeTempDir('adapter-context-')
    const outside = makeTempDir('adapter-context-outside-')
    roots.push(ticketDir, outside)
    mkdirSync(join(ticketDir, 'runtime'))
    const beadsPath = join(ticketDir, 'beads.jsonl')
    vi.mocked(getTicketPaths).mockReturnValue({ ticketDir, beadsPath } as NonNullable<ReturnType<typeof getTicketPaths>>)
    vi.mocked(readTicketFile).mockImplementation((_ticketId, relativePath) => readManualQaText(ticketDir, join(ticketDir, relativePath)))
    symlinkSync(outside, join(ticketDir, file), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(probe(new OpenCodeSDKAdapter('http://127.0.0.1:9')).loadTicketState('1:DEMO-1'))
      .rejects.toThrow('escapes root')
  })

  it.skipIf(process.platform === 'win32')('keeps contained ordinary artifact links in model context', async () => {
    const ticketDir = makeTempDir('adapter-contained-context-')
    roots.push(ticketDir)
    writeFileSync(join(ticketDir, 'accepted-interview.yaml'), 'accepted interview')
    symlinkSync(join(ticketDir, 'accepted-interview.yaml'), join(ticketDir, 'interview.yaml'))
    vi.mocked(getTicketPaths).mockReturnValue({ ticketDir, beadsPath: join(ticketDir, 'beads.jsonl') } as NonNullable<ReturnType<typeof getTicketPaths>>)
    vi.mocked(readTicketFile).mockImplementation((_ticketId, relativePath) => readManualQaText(ticketDir, join(ticketDir, relativePath)))
    expect(await probe(new OpenCodeSDKAdapter('http://127.0.0.1:9')).loadTicketState('1:DEMO-1'))
      .toMatchObject({ interview: 'accepted interview' })
  })

  it.each(['outside', 'inside'])('rejects a %s linked evidence ancestor before attaching its URL', async (kind) => {
    const ticketDir = makeTempDir('manual-qa-file-parts-')
    const outside = makeTempDir('manual-qa-file-parts-outside-')
    roots.push(ticketDir, outside)
    const itemDir = join(ticketDir, 'manual-qa', 'v1', 'evidence', 'item-one')
    mkdirSync(itemDir, { recursive: true })
    writeFileSync(join(itemDir, 'screen.png'), 'image')
    const beadsPath = join(ticketDir, 'beads.jsonl')
    writeFileSync(beadsPath, JSON.stringify({
      id: 'qa-fix', status: 'pending',
      qaOrigin: {
        version: 1, imageDelivery: 'attached',
        sourceItems: [{ itemId: 'one', lineageId: 'lineage-one', behavior: 'Open the page', observation: 'The page opens.', expectedResult: 'The page is usable.', links: [], evidence: [{
          id: 'screen', mediaType: 'image/png', originalName: 'screen.png',
          relativePath: 'manual-qa/v1/evidence/item-one/screen.png', size: 5, sha256: '0'.repeat(64),
        }] }],
      },
    }) + '\n')
    vi.mocked(getTicketPaths).mockReturnValue({ ticketDir, beadsPath } as NonNullable<ReturnType<typeof getTicketPaths>>)
    const adapter = probe(new OpenCodeSDKAdapter('http://127.0.0.1:9'))
    expect(await adapter.loadQaEvidenceFileParts('1:DEMO-1', 'qa-fix')).toHaveLength(1)
    const target = kind === 'outside' ? outside : join(ticketDir, 'other-evidence')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'screen.png'), 'not the accepted evidence')
    rmSync(itemDir, { recursive: true })
    symlinkSync(target, itemDir, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(adapter.loadQaEvidenceFileParts('1:DEMO-1', 'qa-fix')).rejects.toThrow('missing or unsafe')
  })

  it('forwards every snapshotted image file part without an additional count cap', () => {
    const images: PromptPart[] = Array.from({ length: 40 }, (_, index) => ({
      type: 'file',
      content: '',
      source: `manual_qa_evidence:item:${index}`,
      mime: index % 2 === 0 ? 'image/png' : 'image/svg+xml',
      filename: `image-${index}.png`,
      url: `file:///contained/image-${index}.png`,
    }))
    const result = promptPartitionProbe().partitionPromptParts([
      { type: 'system', content: 'system' },
      { type: 'text', content: 'Manual QA evidence references' },
      ...images,
      { type: 'file', content: '', mime: 'application/pdf', filename: 'report.pdf', url: 'file:///contained/report.pdf' },
    ], undefined, true)

    expect(result.systemText).toBe('system')
    expect(result.promptParts.filter((part) => part.type === 'file')).toHaveLength(40)
    expect(result.promptParts.some((part) => part.filename === 'report.pdf')).toBe(false)
  })

  it('keeps references-only prompts text-only', () => {
    const result = promptPartitionProbe().partitionPromptParts([
      { type: 'text', content: 'Evidence: screen.png (references only)' },
      { type: 'file', content: '', mime: 'image/png', filename: 'screen.png', url: 'file:///contained/screen.png' },
    ], undefined, false)
    expect(result.promptParts).toEqual([{ type: 'text', text: 'Evidence: screen.png (references only)' }])
  })
})
