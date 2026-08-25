import {  } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { closeProjectDatabase, getProjectDatabase } from '../../../db/project'
import { manualQaOperations, projects, tickets } from '../../../db/schema'
import { makeTempDir, removeTempDir } from '../../../test/tempDir'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeProjectDatabase(root)
    removeTempDir(root)
  }
})

describe('Manual QA database idempotency', () => {
  it('enforces one operation per ticket/action while retaining restart payload', () => {
    const root = makeTempDir('looptroop-manual-qa-db-')
    roots.push(root)
    const { db } = getProjectDatabase(root)
    const project = db.insert(projects).values({
      name: 'Manual QA',
      shortname: 'MQ',
      folderPath: root,
    }).returning().get()
    const ticket = db.insert(tickets).values({
      externalId: 'MQ-1',
      projectId: project.id,
      title: 'Manual QA operation',
      status: 'WAITING_MANUAL_QA',
    }).returning().get()
    const value = {
      ticketId: ticket.id,
      actionId: 'submit:one',
      version: 1,
      checklistHash: 'a'.repeat(64),
      draftRevision: 3,
      state: 'staged',
      payload: JSON.stringify({ state: 'staged' }),
    }
    db.insert(manualQaOperations).values(value).run()
    expect(() => db.insert(manualQaOperations).values(value).run()).toThrow()
    expect(db.select().from(manualQaOperations).all()).toMatchObject([{
      actionId: 'submit:one',
      version: 1,
      state: 'staged',
    }])
  })
})
