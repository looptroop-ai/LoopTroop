import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { appendLogEvent } from '../../log/executionLog'
import { getCommandLogContext, withCommandLogging } from '../../log/commandLogger'
import { attachProject } from '../../storage/projects'
import { createTicket, getTicketPaths } from '../../storage/tickets'
import { TEST } from '../../test/factories'
import { createTestRepoManager, resetTestDb } from '../../test/integration'
import { TicketInitializationError, initializeTicket } from '../initialize'

let activeWorktreePath: string | null = null
let unsafeAppendCount = 0

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')

  return {
    ...actual,
    spawnSync: vi.fn((command: string, args: readonly string[], options?: Parameters<typeof actual.spawnSync>[2]) => {
      const result = actual.spawnSync(command, args, options)
      const ctx = getCommandLogContext()
      const targetRef = ctx?.externalId ? `refs/heads/${ctx.externalId}` : null

      if (
        ctx
        && activeWorktreePath
        && !existsSync(activeWorktreePath)
        && targetRef
        && args.includes('show-ref')
        && args.includes(targetRef)
      ) {
        unsafeAppendCount += 1
        ctx.emit(ctx.phase, 'info', `[CMD] $ git ${args.join(' ')}`)
      }

      return result
    }),
  }
})

const repoManager = createTestRepoManager('ticket-initialize-')

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  if (result.status !== 0 || result.error) {
    throw new Error(result.error?.message ?? result.stderr ?? `git ${args.join(' ')} failed`)
  }
  return result.stdout.trim()
}

describe('initializeTicket', () => {
  beforeEach(() => {
    resetTestDb()
    activeWorktreePath = null
    unsafeAppendCount = 0
  })

  afterAll(() => {
    resetTestDb()
    repoManager.cleanup()
  })

  it('materializes a reserved ticket skeleton when command logs are persisted during initialization', () => {
    const repoDir = repoManager.createRepo()
    const project = attachProject({
      folderPath: repoDir,
      name: TEST.projectName,
      shortname: TEST.shortname,
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Initialize with command logging',
      description: 'Regression coverage for worktree creation logging.',
    })
    const paths = getTicketPaths(ticket.id)
    if (!paths) throw new Error('Expected ticket paths before initialization')
    appendLogEvent(
      ticket.id,
      'info',
      'DRAFT',
      'Baseline log before initialization.',
      { timestamp: new Date().toISOString() },
      'system',
      'DRAFT',
    )

    activeWorktreePath = paths.worktreePath
    const init = withCommandLogging(
      ticket.id,
      ticket.externalId,
      'DRAFT',
      () => initializeTicket({
        projectFolder: repoDir,
        externalId: ticket.externalId,
      }),
      (phase, type, content) => {
        const timestamp = new Date().toISOString()
        appendLogEvent(
          ticket.id,
          type,
          phase,
          content,
          { timestamp },
          type === 'error' ? 'error' : 'system',
          phase,
        )
      },
    )
    activeWorktreePath = null

    expect(init.worktreePath).toBe(paths.worktreePath)
    expect(init.branchName).toBe(ticket.externalId)
    expect(existsSync(`${init.worktreePath}/.git`)).toBe(true)

    const branchResult = spawnSync('git', ['-C', init.worktreePath, 'branch', '--show-current'], {
      encoding: 'utf8',
    })
    expect(branchResult.status).toBe(0)
    expect(branchResult.stdout.trim()).toBe(ticket.externalId)

    expect(existsSync(paths.executionLogPath)).toBe(true)
    const persistedLog = readFileSync(paths.executionLogPath, 'utf8')
    expect(persistedLog).toContain('Baseline log before initialization.')
    expect(persistedLog).not.toContain('INIT_WORKTREE_CREATE_FAILED')
    expect(persistedLog).not.toContain('Ticket worktree is invalid after initialization')
    expect(unsafeAppendCount).toBe(0)
  })

  it('blocks worktree creation when the project already tracks LoopTroop runtime paths', () => {
    const repoDir = repoManager.createRepo()
    const trackedRuntimePath = resolve(repoDir, '.looptroop', 'worktrees', 'OLD-1')
    mkdirSync(resolve(repoDir, '.looptroop', 'worktrees'), { recursive: true })
    writeFileSync(trackedRuntimePath, 'tracked runtime data\n')
    git(repoDir, ['add', '-f', '.looptroop/worktrees/OLD-1'])
    git(repoDir, ['commit', '-m', 'Track old LoopTroop runtime data'])

    const project = attachProject({
      folderPath: repoDir,
      name: TEST.projectName,
      shortname: TEST.shortname,
    })
    const ticket = createTicket({
      projectId: project.id,
      title: 'Initialize with tracked runtime data',
      description: 'Regression coverage for tracked LoopTroop runtime paths.',
    })
    const paths = getTicketPaths(ticket.id)
    if (!paths) throw new Error('Expected ticket paths before initialization')

    let initError: unknown = null
    try {
      initializeTicket({
        projectFolder: repoDir,
        externalId: ticket.externalId,
      })
    } catch (err) {
      initError = err
    }

    expect(initError).toBeInstanceOf(TicketInitializationError)
    expect((initError as TicketInitializationError).code).toBe('INIT_LOOPTROOP_TRACKED')
    expect((initError as Error).message).toContain('git rm --cached -r .looptroop')
    expect((initError as Error).message).toContain('.looptroop/worktrees/OLD-1')
    expect(existsSync(resolve(paths.worktreePath, '.git'))).toBe(false)
    const branchResult = spawnSync('git', ['-C', repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${ticket.externalId}`], {
      encoding: 'utf8',
    })
    expect(branchResult.status).not.toBe(0)
  })
})
