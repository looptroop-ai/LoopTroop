import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as jsYaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { manualQaPrdPath, readManualQaPrd, tryReadManualQaPrd } from '../prd'
import { deriveManualQaPrdCriteria } from '../coverage'

function ticketDirWith(prd: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'looptroop-manual-qa-prd-'))
  if (prd !== undefined) {
    writeFileSync(manualQaPrdPath(dir), jsYaml.dump(prd))
  }
  return dir
}

const validPrd = {
  schema_version: 1,
  artifact: 'prd',
  epics: [{
    id: 'EPIC-1',
    title: 'Preferences',
    user_stories: [{
      id: 'US-1',
      title: 'Save the selection',
      acceptance_criteria: ['Reloading preserves the selection.', 'Clearing resets it.'],
    }],
  }],
}

describe('readManualQaPrd', () => {
  it('reads the fields Manual QA needs and keeps the rest', () => {
    const prd = readManualQaPrd(ticketDirWith(validPrd))
    expect(prd.epics[0]?.user_stories[0]?.acceptance_criteria).toHaveLength(2)
  })

  it('feeds criteria derivation without a cast', () => {
    const criteria = deriveManualQaPrdCriteria(readManualQaPrd(ticketDirWith(validPrd)))
    expect(criteria.map((entry) => entry.ref)).toEqual(['EPIC-1/US-1/AC-1', 'EPIC-1/US-1/AC-2'])
  })

  it('throws when the PRD is missing', () => {
    expect(() => readManualQaPrd(ticketDirWith(undefined)))
      .toThrow('Approved PRD is required before Manual QA checklist generation.')
  })

  it('throws when an epic has no id', () => {
    expect(() => readManualQaPrd(ticketDirWith({ epics: [{ user_stories: [] }] }))).toThrow()
  })

  it('throws when acceptance criteria are not strings', () => {
    expect(() => readManualQaPrd(ticketDirWith({
      epics: [{ id: 'EPIC-1', user_stories: [{ id: 'US-1', acceptance_criteria: [{ text: 'nope' }] }] }],
    }))).toThrow()
  })
})

describe('tryReadManualQaPrd', () => {
  it('returns the PRD when it reads', () => {
    expect(tryReadManualQaPrd(ticketDirWith(validPrd))?.epics).toHaveLength(1)
  })

  it('returns null instead of throwing for a missing PRD', () => {
    expect(tryReadManualQaPrd(ticketDirWith(undefined))).toBeNull()
  })

  it('returns null for a malformed PRD', () => {
    expect(tryReadManualQaPrd(ticketDirWith({ epics: 'none' }))).toBeNull()
  })
})
