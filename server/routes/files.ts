import { Hono } from 'hono'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as readline from 'node:readline'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { getTicketByRef, getTicketPaths } from '../storage/tickets'
import { resolvePhaseAttempt } from '../storage/ticketPhaseAttempts'
import { safeAtomicWrite } from '../io/atomicWrite'
import { foldPersistedLogEntries } from '../log/readDedupe'
import { normalizePersistedLogEntry } from '../log/view'
import { handlePutInterview, handlePutPrd } from './ticketHandlers'
import { contentSha256 } from '../lib/contentHash'
import { readOpenCodeNativeLogs } from '../opencode/logDiagnostics'
import { getErrorMessage } from '@shared/typeGuards'

const filesRouter = new Hono()

const VALID_FILES = ['interview', 'prd'] as const
type ValidFile = typeof VALID_FILES[number]
type LogChannel = 'normal' | 'debug' | 'ai' | 'all'

function isValidFile(file: string): file is ValidFile {
  return VALID_FILES.includes(file as ValidFile)
}

function resolveTicketFilePath(ticketId: string, file: ValidFile): string | null {
  const paths = getTicketPaths(ticketId)
  if (!paths) return null
  return path.join(paths.ticketDir, `${file}.yaml`)
}

function normalizeLogChannel(channel?: string): LogChannel {
  if (channel === 'debug' || channel === 'ai' || channel === 'all') return channel
  return 'normal'
}

/**
 * The route's view of a persisted row.
 *
 * One canonical normaliser, shared with the durable projection index, so a row
 * cannot be classified one way when it is indexed and another when it is read
 * back. The endpoints fill in `audience` and `kind` where a row omits them;
 * the index stores them absent.
 */
function normalizeLogEntry(entry: unknown): Record<string, unknown> | null {
  return normalizePersistedLogEntry(entry, { audienceAndKind: 'infer' })
}

function getEntryPhaseAttempt(entry: Record<string, unknown>): number | null {
  const phaseAttempt = typeof entry.phaseAttempt === 'number' && Number.isFinite(entry.phaseAttempt)
    ? entry.phaseAttempt
    : Number(entry.phaseAttempt)
  return Number.isFinite(phaseAttempt) ? phaseAttempt : null
}

function logEntryMatchesFilters(
  entry: Record<string, unknown>,
  filters: {
    status?: string
    phase?: string
    phaseAttempt?: number
  },
): boolean {
  if (filters.status && entry.status !== filters.status) return false
  if (filters.phase && entry.phase !== filters.phase) return false
  if (typeof filters.phaseAttempt === 'number' && Number.isFinite(filters.phaseAttempt)) {
    const entryPhaseAttempt = getEntryPhaseAttempt(entry)
    if (!Number.isFinite(entryPhaseAttempt) || entryPhaseAttempt !== filters.phaseAttempt) return false
  }
  return true
}

async function extractTicketSessionIds(logPath: string): Promise<string[]> {
  const ids = new Set<string>()
  try {
    await fs.promises.access(logPath)
  } catch {
    return []
  }
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string' && parsed.sessionId.trim()) {
        ids.add(parsed.sessionId.trim())
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return Array.from(ids)
}

/**
 * Orders a merged log view by time.
 *
 * A row whose timestamp could not be read has no place on the timeline, so it
 * goes to the end rather than being treated as epoch zero — which would float
 * it above every dated row in the view.
 */
function sortByTimestamp(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  const dated: { entry: Record<string, unknown>; at: number }[] = []
  const undated: Record<string, unknown>[] = []
  for (const entry of entries) {
    const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN
    if (Number.isFinite(at)) dated.push({ entry, at })
    else undated.push(entry)
  }
  dated.sort((a, b) => a.at - b.at)
  return [...dated.map((row) => row.entry), ...undated]
}

async function readLogFileEntries(logPath: string, filters: {
  status?: string
  phase?: string
  phaseAttempt?: number
}): Promise<Record<string, unknown>[]> {
  try {
    await fs.promises.access(logPath)
  } catch {
    return []
  }
  const entries: Record<string, unknown>[] = []
  const rl = readline.createInterface({
    input: fs.createReadStream(logPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const normalized = normalizeLogEntry(JSON.parse(line))
      if (normalized && logEntryMatchesFilters(normalized, filters)) {
        entries.push(normalized)
      }
    } catch {
      // Skip malformed lines.
    }
  }
  return entries
}

filesRouter.get('/files/:ticketId/logs', async (c) => {
  const ticketId = c.req.param('ticketId')
  const ticket = getTicketByRef(ticketId)
  if (!ticket) return c.json({ error: 'Ticket not found' }, 404)

  const paths = getTicketPaths(ticketId)
  if (!paths) return c.json({ error: 'Ticket not found' }, 404)
  const channel = normalizeLogChannel(c.req.query('channel'))

  const statusFilter = c.req.query('status')
  const phaseFilter = c.req.query('phase')
  const phaseAttemptFilterRaw = c.req.query('phaseAttempt')
  const phaseAttemptFilter = phaseAttemptFilterRaw != null ? Number(phaseAttemptFilterRaw) : undefined
  if (phaseAttemptFilter !== undefined && !Number.isFinite(phaseAttemptFilter)) {
    return c.json({ error: 'Invalid phaseAttempt parameter: must be a number' }, 400)
  }
  const filters = {
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(phaseFilter ? { phase: phaseFilter } : {}),
    ...(typeof phaseAttemptFilter === 'number' && Number.isFinite(phaseAttemptFilter) ? { phaseAttempt: phaseAttemptFilter } : {}),
  }

  if (channel === 'all') {
    const [normalEntries, debugEntries, aiEntries] = await Promise.all([
      readLogFileEntries(paths.executionLogPath, filters),
      readLogFileEntries(paths.debugLogPath, filters),
      readLogFileEntries(paths.aiLogPath, filters),
    ])
    const sessionIds = await extractTicketSessionIds(paths.aiLogPath)
    // Native rows go through the same normalise-and-filter path as the files
    // beside them. Appended raw, a request scoped to one phase or attempt still
    // came back carrying every native row for the ticket's sessions.
    const ocNativeEntries = readOpenCodeNativeLogs(sessionIds)
      .flatMap((entry) => {
        const normalized = normalizeLogEntry(entry)
        return normalized && logEntryMatchesFilters(normalized, filters) ? [normalized] : []
      })
    const allEntries = [...normalEntries, ...debugEntries, ...aiEntries, ...ocNativeEntries]
    return c.json(sortByTimestamp(foldPersistedLogEntries(allEntries)))
  }

  const logPath = channel === 'debug'
    ? paths.debugLogPath
    : channel === 'ai'
      ? paths.aiLogPath
      : paths.executionLogPath

  // Kept ahead of the read: a ticket with no log file at all answers with an
  // empty list rather than the synthetic "status is active" row below.
  try {
    await fs.promises.access(logPath)
  } catch {
    return c.json([])
  }

  const entries = await readLogFileEntries(logPath, filters)
  const foldedEntries = sortByTimestamp(foldPersistedLogEntries(entries))

  const isAuxiliaryChannel = channel === 'debug' || channel === 'ai'
  const hasCurrentStatusEntry = foldedEntries.some(entry => entry.status === ticket.status)
  const currentPhaseAttempt = !isAuxiliaryChannel && !hasCurrentStatusEntry ? resolvePhaseAttempt(ticketId, ticket.status) : null
  const syntheticMatchesFilters = logEntryMatchesFilters({
    phase: ticket.status,
    phaseAttempt: currentPhaseAttempt ?? 1,
    status: ticket.status,
  }, filters)
  if (!isAuxiliaryChannel && !hasCurrentStatusEntry && syntheticMatchesFilters) {
    const nowIso = new Date().toISOString()
    foldedEntries.push({
      timestamp: ticket.updatedAt ?? nowIso,
      type: 'info',
      phase: ticket.status,
      phaseAttempt: currentPhaseAttempt ?? 1,
      status: ticket.status,
      source: 'system',
      message: `[SYS] Status ${ticket.status} is active. Older runs may not have generated status-scoped logs yet.`,
      content: `[SYS] Status ${ticket.status} is active. Older runs may not have generated status-scoped logs yet.`,
      data: { synthetic: true },
      audience: 'all',
      kind: 'milestone',
      op: 'append',
    })
  }
  return c.json(foldedEntries)
})

filesRouter.get('/files/:ticketId/:file', async (c) => {
  const ticketId = c.req.param('ticketId')
  const file = c.req.param('file')

  if (!isValidFile(file)) {
    return c.json({ error: `Invalid file type. Must be one of: ${VALID_FILES.join(', ')}` }, 400)
  }

  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  const filePath = resolveTicketFilePath(ticketId, file)
  if (!filePath) return c.json({ error: 'Ticket not found' }, 404)

  try {
    await fs.promises.access(filePath)
  } catch {
    return c.json({ content: '', exists: false })
  }

  const content = await fs.promises.readFile(filePath, 'utf-8')
  return c.json({ content, exists: true, contentSha256: contentSha256(content) })
})

filesRouter.put('/files/:ticketId/:file', async (c) => {
  const ticketId = c.req.param('ticketId')
  const file = c.req.param('file')

  if (!isValidFile(file)) {
    return c.json({ error: `Invalid file type. Must be one of: ${VALID_FILES.join(', ')}` }, 400)
  }

  if (!getTicketByRef(ticketId)) return c.json({ error: 'Ticket not found' }, 404)
  const filePath = resolveTicketFilePath(ticketId, file)
  if (!filePath) return c.json({ error: 'Ticket not found' }, 404)

  if (file === 'interview') {
    return handlePutInterview(c)
  }

  if (file === 'prd') {
    return handlePutPrd(c)
  }

  const body = await c.req.json()
  if (typeof body.content !== 'string') {
    return c.json({ error: 'Request body must include a "content" string field' }, 400)
  }

  try {
    safeAtomicWrite(filePath, body.content)
  } catch {
    return c.json({ error: 'Failed to write file' }, 500)
  }

  return c.json({ success: true })
})

const execFileAsync = promisify(execFile)

async function revealFolderInExplorer(targetPath: string) {
  let resolvedPath = path.resolve(targetPath)
  try {
    const stats = await fs.promises.stat(resolvedPath)
    if (!stats.isDirectory()) {
      resolvedPath = path.dirname(resolvedPath)
    }
  } catch {
    // If the path doesn't exist, try its parent
    resolvedPath = path.dirname(resolvedPath)
  }

  const isWsl = process.platform === 'linux' && (
    !!process.env.WSL_DISTRO_NAME ||
    !!process.env.WSL_INTEROP ||
    await fs.promises.readFile('/proc/version', 'utf8').then(v => v.toLowerCase().includes('microsoft')).catch(() => false)
  )

  if (isWsl) {
    try {
      const { stdout } = await execFileAsync('wslpath', ['-w', resolvedPath])
      const winPath = stdout.trim()
      await execFileAsync('powershell.exe', ['-NoProfile', '-Command', `Invoke-Item '${winPath.replace(/'/g, "''")}'`])
    } catch {
      await execFileAsync('explorer.exe', [resolvedPath])
    }
  } else if (process.platform === 'win32') {
    await execFileAsync('explorer.exe', [resolvedPath])
  } else if (process.platform === 'darwin') {
    await execFileAsync('open', [resolvedPath])
  } else {
    await execFileAsync('xdg-open', [resolvedPath])
  }
}

filesRouter.post('/files/open-path', async (c) => {
  try {
    const body = await c.req.json()
    if (!body || typeof body.path !== 'string' || !body.path.trim()) {
      return c.json({ error: 'A valid "path" parameter is required.' }, 400)
    }
    await revealFolderInExplorer(body.path.trim())
    return c.json({ success: true })
  } catch (err) {
    const message = getErrorMessage(err)
    return c.json({ error: 'Failed to open path', details: message }, 500)
  }
})

export { filesRouter }
