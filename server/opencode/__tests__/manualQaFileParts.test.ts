import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenCodeSDKAdapter } from '../adapter'
import type { PromptPart } from '../types'
import { getTicketPaths, readTicketFile } from '../../storage/tickets'
import { makeTempDir, removeTempDir } from '../../test/tempDir'
import { readManualQaText } from '../../phases/manualQa/storage'

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
})

interface AdapterPartitionProbe {
  loadTicketState(ticketId: string): Promise<Record<string, unknown>>
  loadQaEvidenceFileParts(ticketId: string, beadId: string): Promise<PromptPart[]>
  partitionPromptParts(parts: PromptPart[], fallbackSystem?: string, includeImageFiles?: boolean): {
    systemText: string
    promptParts: Array<{ type: string; text?: string; mime?: string; filename?: string; url?: string }>
  }
}

function probe(adapter: OpenCodeSDKAdapter): AdapterPartitionProbe {
  return adapter as unknown as AdapterPartitionProbe
}

describe('OpenCode Manual QA file parts', () => {
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
        sourceItems: [{ itemId: 'one', evidence: [{
          id: 'screen', mediaType: 'image/png', originalName: 'screen.png',
          relativePath: 'manual-qa/v1/evidence/item-one/screen.png',
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
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:9')
    const images: PromptPart[] = Array.from({ length: 40 }, (_, index) => ({
      type: 'file',
      content: '',
      source: `manual_qa_evidence:item:${index}`,
      mime: index % 2 === 0 ? 'image/png' : 'image/svg+xml',
      filename: `image-${index}.png`,
      url: `file:///contained/image-${index}.png`,
    }))
    const result = probe(adapter).partitionPromptParts([
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
    const adapter = new OpenCodeSDKAdapter('http://127.0.0.1:9')
    const result = probe(adapter).partitionPromptParts([
      { type: 'text', content: 'Evidence: screen.png (references only)' },
      { type: 'file', content: '', mime: 'image/png', filename: 'screen.png', url: 'file:///contained/screen.png' },
    ], undefined, false)
    expect(result.promptParts).toEqual([{ type: 'text', text: 'Evidence: screen.png (references only)' }])
  })
})
