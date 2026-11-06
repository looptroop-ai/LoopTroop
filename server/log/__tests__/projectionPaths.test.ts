import { afterEach, describe, expect, it } from 'vitest'
import { resolveTicketLogPath } from '../projection'
import { getTicketAiLogPath, getTicketDebugLogPath, getTicketExecutionLogPath } from '../../storage/paths'
import { makeTempDir, removeTempDir } from '../../test/tempDir'

describe('resolveTicketLogPath', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) removeTempDir(root)
  })

  it('resolves each channel to the same contained file as the full ticket paths', () => {
    const projectRoot = makeTempDir('looptroop-log-paths-')
    roots.push(projectRoot)
    const storage = { projectRoot, externalId: 'LOG-1' }

    expect(resolveTicketLogPath(storage, 'normal')).toBe(getTicketExecutionLogPath(projectRoot, 'LOG-1'))
    expect(resolveTicketLogPath(storage, 'debug')).toBe(getTicketDebugLogPath(projectRoot, 'LOG-1'))
    expect(resolveTicketLogPath(storage, 'ai')).toBe(getTicketAiLogPath(projectRoot, 'LOG-1'))
    expect(new Set(['normal', 'debug', 'ai'].map((channel) => resolveTicketLogPath(storage, channel as 'normal')))).toHaveProperty('size', 3)
  })
})
