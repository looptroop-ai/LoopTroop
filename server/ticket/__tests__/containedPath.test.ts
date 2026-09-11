import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir } from '../../test/tempDir'
import { resolveProjectTicketContainedPath, writeProjectTicketFile } from '../containedPath'
import { getTicketBeadsPath, readTicketMeta, writeTicketMeta } from '../metadata'
import { readFileNoFollowSync } from '../../io/readFile'

let scratch: string
let project: string
let ticketDir: string
beforeEach(() => {
  scratch = makeTempDir('looptroop-ticket-containment-')
  project = join(scratch, 'project')
  ticketDir = join(project, '.looptroop', 'worktrees', 'ABC-1', '.ticket')
  mkdirSync(project)
})
afterEach(() => rmSync(scratch, { recursive: true, force: true }))

describe('ticket file containment', () => {
  it('preserves missing metadata and creates nested metadata through the contained writer', () => {
    expect(readTicketMeta(project, 'ABC-1')).toEqual({})
    writeTicketMeta(project, 'ABC-1', { title: 'safe', baseBranch: 'feature/topic' })
    expect(readTicketMeta(project, 'ABC-1')).toEqual({ title: 'safe', baseBranch: 'feature/topic' })
    expect(getTicketBeadsPath(project, 'ABC-1', 'feature/topic'))
      .toBe(join(ticketDir, 'beads', 'feature', 'topic', '.beads', 'issues.jsonl'))
  })

  it('rejects ticket and branch traversal before normalizing the path', () => {
    for (const id of ['../outside', '..', 'ABC/../outside', 'C:\\outside', 'ABC\0']) {
      expect(() => writeTicketMeta(project, id, { title: 'unsafe' })).toThrow()
    }
    expect(() => getTicketBeadsPath(project, 'ABC-1', '../../../outside')).toThrow()
    expect(() => writeProjectTicketFile(project, 'ABC-1', '../other', 'unsafe')).toThrow()
    expect(() => resolveProjectTicketContainedPath(project, 'ABC-1', 'file\0', 'remove')).toThrow()
  })

  it('rejects a replaced worktrees directory before reading or creating metadata', () => {
    mkdirSync(join(project, '.looptroop'))
    symlinkSync(scratch, join(project, '.looptroop', 'worktrees'), 'junction')
    expect(() => readTicketMeta(project, 'ABC-1')).toThrow()
    expect(() => writeTicketMeta(project, 'ABC-1', { title: 'unsafe' })).toThrow()
  })

  it('rejects artifact links leaving the ticket even when they stay in the project', () => {
    mkdirSync(ticketDir, { recursive: true })
    const sibling = join(project, 'private')
    mkdirSync(sibling)
    writeFileSync(join(sibling, 'file'), 'do not change')
    symlinkSync(sibling, join(ticketDir, 'escape'), 'junction')
    expect(() => resolveProjectTicketContainedPath(project, 'ABC-1', 'escape/file')).toThrow()
    expect(() => writeProjectTicketFile(project, 'ABC-1', 'escape/file', 'unsafe')).toThrow()
    expect(readFileSync(join(sibling, 'file'), 'utf8')).toBe('do not change')
  })

  it('rejects a ticket directory link leaving its worktree for another project directory', () => {
    mkdirSync(join(ticketDir, '..'), { recursive: true })
    const privateDir = join(project, 'private')
    mkdirSync(privateDir)
    symlinkSync(privateDir, ticketDir, 'junction')
    expect(() => readTicketMeta(project, 'ABC-1')).toThrow('Ticket directory must stay within its worktree')
    expect(() => writeTicketMeta(project, 'ABC-1', { title: 'unsafe' })).toThrow()
  })

  it('supports contained links and a project reached through a symlink', () => {
    mkdirSync(join(ticketDir, 'real'), { recursive: true })
    symlinkSync(join(ticketDir, 'real'), join(ticketDir, 'alias'), 'junction')
    const projectAlias = join(scratch, 'project-alias')
    symlinkSync(project, projectAlias, 'junction')
    writeProjectTicketFile(projectAlias, 'ABC-1', 'alias/new/file', 'safe')
    expect(readFileSync(join(ticketDir, 'real', 'new', 'file'), 'utf8')).toBe('safe')
  })

  it('removes a final link without recursively deleting its destination', () => {
    writeProjectTicketFile(project, 'ABC-1', 'keep.txt', 'keep')
    const beads = join(ticketDir, 'beads')
    const destination = join(ticketDir, 'real')
    mkdirSync(destination)
    writeFileSync(join(destination, 'keep.txt'), 'keep destination')
    symlinkSync(destination, beads, 'junction')
    const entry = resolveProjectTicketContainedPath(project, 'ABC-1', 'beads', 'remove')
    expect(entry).toBe(beads)
    rmSync(entry, { recursive: true })
    expect(readFileSync(join(ticketDir, 'keep.txt'), 'utf8')).toBe('keep')
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('keep destination')
    expect(() => resolveProjectTicketContainedPath(project, 'ABC-1', '.', 'remove')).toThrow()
  })

  it.skipIf(process.platform === 'win32')('does not follow a final file replaced after resolution', () => {
    writeProjectTicketFile(project, 'ABC-1', 'file', 'safe')
    const file = resolveProjectTicketContainedPath(project, 'ABC-1', 'file')
    const outside = join(scratch, 'outside')
    writeFileSync(outside, 'private')
    rmSync(file)
    symlinkSync(outside, file)
    expect(() => readFileNoFollowSync(file)).toThrow()
  })
})
