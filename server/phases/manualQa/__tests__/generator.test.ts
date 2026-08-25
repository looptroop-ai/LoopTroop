import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'
import type { TicketContext } from '../../../machines/types'
import type { PrdDocument } from '../../../structuredOutput/types'
import {
  buildGenerationPrompt,
  resolveManualQaGenerationArtifactRepairs,
  resolveManualQaGenerationVersion,
  restoreManualQaGenerationArtifacts,
} from '../generator'
import {
  getManualQaStoragePaths,
  persistManualQaChecklist,
  readManualQaCoverage,
  reserveManualQaVersion,
} from '../storage'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) removeTempDir(root)
})

function root() {
  const value = makeTempDir('looptroop-manual-qa-generator-')
  roots.push(value)
  return value
}

function persistChecklist(ticketDir: string) {
  persistManualQaChecklist(ticketDir, {
    schemaVersion: 1,
    artifact: 'manual_qa_checklist',
    ticketId: 'DEMO-1',
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: 'Verify the application behavior.',
    notApplicablePrdRefs: [],
    items: [{
      id: 'qa-v1-001',
      lineageId: 'lineage-001',
      priorItemIds: [],
      title: 'Application usability',
      source: 'prd',
      behavior: 'The application remains usable.',
      severity: 'required',
      recheckState: 'new',
      prerequisites: [],
      actions: ['Exercise the behavior.'],
      expectedResult: 'The behavior works.',
      watchNotes: [],
      beadRefs: [],
      prdRefs: [{ ref: 'EPIC-1/STORY-1/AC-1', coverage: 'full' }],
    }],
  })
}

describe('Manual QA generation context', () => {
  it('includes focused ticket, bead verification, and previous result context', () => {
    const prompt = buildGenerationPrompt({
      context: {
        externalId: 'DEMO-1',
        title: 'Persist filters',
      } as TicketContext,
      ticketDescription: 'Remember the selected filters between visits.',
      prd: { epics: [] } as unknown as PrdDocument,
      beads: [{
        id: 'DEMO-1.1',
        title: 'Persist selection',
        description: 'Store and restore the filter.',
        prdRefs: [],
        targetFiles: ['src/filter.ts'],
        acceptanceCriteria: ['Selection survives reload'],
        tests: ['Reload persistence regression'],
        labels: ['filters'],
        issueType: 'feature',
      }],
      finalTestReport: 'All automated tests passed.',
      previousQa: {
        checklist: { version: 1, items: [{ id: 'qa-v1-001', lineageId: 'filter-selection' }] },
        results: { results: [{ itemId: 'qa-v1-001', outcome: 'fail', observation: 'Reset after reload' }] },
      },
      diffMetadata: 'M src/filter.ts',
    })

    expect(prompt).toContain('Remember the selected filters between visits.')
    expect(prompt).toContain('Reload persistence regression')
    expect(prompt).toContain('"issueType": "feature"')
    expect(prompt).toContain('Reset after reload')
    expect(prompt).toContain('title: concise human-facing check title')
    expect(prompt).toContain('source: prd | bead | previous_qa | implementation_diff')
    expect(prompt).toContain('severity: required | optional')
    expect(prompt).toContain('recheck_state: new | pending_recheck | previously_passed')
    expect(prompt).toContain('not_applicable_prd_refs:')
    expect(prompt).toContain('Never use it to conceal a missing human check.')
    expect(prompt).toContain('Quote every YAML string containing #')
    expect(prompt).not.toContain('required: boolean')
  })

  it('reuses a reserved version after the checklist was persisted but the transition did not finish', () => {
    const ticketDir = root()
    reserveManualQaVersion(ticketDir, 'ticket-internal-id', 1, 'generation:one')
    persistChecklist(ticketDir)

    expect(resolveManualQaGenerationVersion(ticketDir)).toBe(1)
  })

  it('restores missing deterministic coverage without another checklist generation', () => {
    const ticketDir = root()
    reserveManualQaVersion(ticketDir, 'ticket-internal-id', 1, 'generation:one')
    persistChecklist(ticketDir)
    writeFileSync(join(ticketDir, 'prd.yaml'), [
      'epics:',
      '  - id: EPIC-1',
      '    user_stories:',
      '      - id: STORY-1',
      '        acceptance_criteria:',
      '          - The application remains usable.',
      '',
    ].join('\n'))
    expect(readManualQaCoverage(ticketDir, 1)).toBeNull()

    const restored = restoreManualQaGenerationArtifacts(ticketDir, 1)

    expect(restored?.coverage.coveredCount).toBe(1)
    expect(readManualQaCoverage(ticketDir, 1)?.coveredCount).toBe(1)
    expect(readFileSync(getManualQaStoragePaths(ticketDir, 1).coveragePath, 'utf8'))
      .toContain('criterionRef: EPIC-1/STORY-1/AC-1')
  })

  it('repairs a missing compact coverage artifact independently of an existing checklist artifact', () => {
    const existingChecklist = JSON.stringify({ version: 3, checklist: 'already persisted' })

    expect(resolveManualQaGenerationArtifactRepairs({
      checklistContent: existingChecklist,
      coverageContent: null,
      version: 3,
    })).toEqual({ checklist: false, coverage: true })
  })
})
