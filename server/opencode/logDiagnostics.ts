import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import {
  extractModelErrorInfo,
  hasRichModelErrorInfo,
  summarizeModelErrorForLog,
  type ModelErrorInfo,
} from './errorDetails'

export const LOOPTROOP_OPENCODE_LOG_DIR = 'LOOPTROOP_OPENCODE_LOG_DIR'

const DEFAULT_MAX_LOG_FILES = 10
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024
const GENERIC_PROVIDER_ERROR = 'Provider returned error'
const TROUBLESHOOTING_HINT = 'No matching local OpenCode provider log was found. Set `LOOPTROOP_OPENCODE_LOG_DIR` for an external OpenCode server.'

export interface OpenCodeLogDiagnosticOptions {
  env?: Partial<Record<string, string | undefined>>
  logDirs?: string[]
  maxFiles?: number
  maxBytesPerFile?: number
  /** Read every candidate file, for the durable history projection only. */
  complete?: boolean
}

export interface OpenCodeErrorEnrichment {
  message: string
  details: ModelErrorInfo
  source: 'opencode_log' | 'troubleshooting_hint'
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function normalizeGenericMessage(value: string | undefined): string {
  return (value ?? '')
    .replace(/^Failed to prompt OpenCode session:\s*/i, '')
    .replace(/[.。]\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function isGenericProviderErrorMessage(value: string | undefined): boolean {
  return normalizeGenericMessage(value) === GENERIC_PROVIDER_ERROR.toLowerCase()
}

function defaultLogDir(env: Partial<Record<string, string | undefined>>): string {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()
  return join(home, '.local', 'share', 'opencode', 'log')
}

export function resolveOpenCodeLogDirs({
  env = process.env,
  logDirs,
}: Pick<OpenCodeLogDiagnosticOptions, 'env' | 'logDirs'> = {}): string[] {
  const configured = logDirs ?? [
    ...(env[LOOPTROOP_OPENCODE_LOG_DIR]?.trim() ? [env[LOOPTROOP_OPENCODE_LOG_DIR]!.trim()] : []),
    defaultLogDir(env),
  ]

  return Array.from(new Set(
    configured
      .map((dir) => dir.trim())
      .filter(Boolean)
      .map((dir) => resolve(dir)),
  ))
}

export interface OpenCodeNativeLogFile {
  path: string
  mtimeMs: number
  size: number
  /** The filesystem identity lets the history index distinguish rotation from append. */
  fileIdentity?: string
}

function readCandidateLogFiles(options: OpenCodeLogDiagnosticOptions): OpenCodeNativeLogFile[] {
  const maxFiles = options.complete ? Number.POSITIVE_INFINITY : options.maxFiles ?? DEFAULT_MAX_LOG_FILES
  const maxBytes = options.complete ? Number.POSITIVE_INFINITY : options.maxBytesPerFile ?? DEFAULT_MAX_LOG_BYTES
  const candidates: OpenCodeNativeLogFile[] = []

  for (const dir of resolveOpenCodeLogDirs(options)) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const filePath = join(dir, entry)
      let stat
      try {
        stat = statSync(filePath)
      } catch (error) {
        // Diagnostics are best effort, but complete history must never turn an
        // unreadable candidate into a successful, incomplete export.
        if (options.complete) throw error
        continue
      }
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) continue
      const fileIdentity = typeof stat.dev === 'number' && typeof stat.ino === 'number'
        ? `${stat.dev}:${stat.ino}`
        : undefined
      candidates.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, fileIdentity })
    }
  }

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs || (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .slice(0, maxFiles)
}

function readField(line: string, key: string): string | undefined {
  const match = line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))
  return match?.[1]
}

function extractBalancedJsonAfter(line: string, marker: string): string | undefined {
  const markerIndex = line.indexOf(marker)
  if (markerIndex < 0) return undefined
  const start = line.indexOf('{', markerIndex + marker.length)
  if (start < 0) return undefined

  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < line.length; index += 1) {
    const char = line[index]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return line.slice(start, index + 1)
    }
  }

  return undefined
}

function parseLogLineError(line: string, sessionId: string): ModelErrorInfo | undefined {
  if (!line.includes('service=llm') || !line.includes(`session.id=${sessionId}`)) return undefined

  const errorJson = extractBalancedJsonAfter(line, ' error=')
  if (!errorJson) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(errorJson)
  } catch {
    return undefined
  }

  const root = getRecord(parsed)
  const error = root?.error ?? parsed
  const info = extractModelErrorInfo(error)
  if (!info) return undefined
  if (
    (isGenericProviderErrorMessage(info.message) || isGenericProviderErrorMessage(info.responseErrorMessage))
    && !hasRichModelErrorInfo(info)
  ) {
    return undefined
  }

  return {
    ...info,
    providerId: info.providerId ?? cleanString(readField(line, 'providerID')),
    providerModelId: info.providerModelId ?? cleanString(readField(line, 'modelID')),
  }
}

function readLogfmtValue(line: string, key: string): string | undefined {
  const quotedMatch = line.match(new RegExp(`(?:^|\\s)${key}="((?:[^"\\\\]|\\\\.)*)"`) )
  if (quotedMatch) return (quotedMatch[1] ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return readField(line, key)
}

/** An ISO timestamp, or null when the value is missing or not a date. */
function readIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export interface OpenCodeNativeLogEntry {
  /**
   * Null when the line carried no usable time.
   *
   * Substituting `Date.now()` was worse than admitting ignorance: it invents
   * ordering data, and in the merged `channel=all` view it floats an entry from
   * hours ago above everything current.
   */
  timestamp: string | null
  type: 'debug'
  source: 'debug'
  audience: 'debug'
  kind: 'session'
  op: 'append'
  phase: string
  phaseAttempt: number
  status: string
  message: string
  content: string
  sessionId: string
  /** Stable opaque client identity derived from the native source location. */
  entryId?: string
  data: Record<string, unknown>
  /** Internal stable source location used by the paged history index. */
  nativeIdentity?: string
}

export interface OpenCodeNativeLogReadLocation {
  lineNumber: number
  byteOffset: number
  byteLength: number
  /** False means this is the current unterminated tail and may be replaced on append. */
  complete: boolean
}

export interface OpenCodeNativeLogReadStats {
  startOffset: number
  startLine: number
  bytesRead: number
  linesRead: number
  indexedOffset: number
  indexedLines: number
  tailOffset: number
  endedWithNewline: boolean
  entriesRead: number
}

export interface OpenCodeNativeLogReadOptions {
  /** Begin at an indexed byte boundary, or at the previous unterminated tail. */
  startOffset?: number
  /** Physical line number corresponding to startOffset. */
  startLine?: number
  /** Consume records without accumulating the complete file in memory. */
  onEntry?: (entry: OpenCodeNativeLogEntry, location: OpenCodeNativeLogReadLocation) => void
  stats?: OpenCodeNativeLogReadStats
}

function decorateNativeEntry(
  entry: OpenCodeNativeLogEntry,
  filePath: string,
  lineNumber: number,
  fileIdentity?: string,
): OpenCodeNativeLogEntry {
  const nativeIdentity = `${fileIdentity ? `${fileIdentity}:` : ''}${filePath}:${lineNumber}`
  entry.entryId = `native:${createHash('sha256').update(nativeIdentity).digest('hex')}`
  // Keep the source location out of the JSON response while giving the
  // projection a stable tie-breaker across concurrent page requests.
  Object.defineProperty(entry, 'nativeIdentity', {
    value: nativeIdentity,
    enumerable: false,
  })
  return entry
}

/** Candidate metadata is cheap; complete history owns the subsequent file reads. */
export function listOpenCodeNativeLogFiles(
  options: OpenCodeLogDiagnosticOptions = {},
): OpenCodeNativeLogFile[] {
  return readCandidateLogFiles({ ...options, complete: true })
}

/**
 * One native log line, or null when it belongs to another session.
 *
 * `timestampUnreadable` says the line carried a time this could not parse, so
 * the caller can count it without turning each one into its own warning.
 */
function parseNativeLogLine(
  line: string,
  sessionIdSet: Set<string>,
): { record: OpenCodeNativeLogEntry; timestampUnreadable: boolean } | null {
  const rawSessionId = readField(line, 'session.id')
  if (!rawSessionId || !sessionIdSet.has(rawSessionId)) return null

  // Read like every other field: a quoted timestamp read raw came back with its
  // quotes and threw on `new Date(...).toISOString()`.
  const time = readLogfmtValue(line, 'time')
  const level = readLogfmtValue(line, 'level') ?? 'INFO'
  const service = readField(line, 'service')
  const msg = readLogfmtValue(line, 'msg') ?? readLogfmtValue(line, 'message') ?? line.trim()

  const timestamp = readIsoTimestamp(time)
  const serviceTag = service ? `[opencode:${service}]` : '[opencode]'
  const content = `[DEBUG] [${level}] ${serviceTag} ${msg}`

  return {
    timestampUnreadable: Boolean(time) && timestamp === null,
    record: {
      timestamp,
      type: 'debug',
      source: 'debug',
      audience: 'debug',
      kind: 'session',
      op: 'append',
      phase: 'opencode_native',
      phaseAttempt: 1,
      status: 'opencode_native',
      message: content,
      content,
      sessionId: rawSessionId,
      data: { level, service: service ?? null, ocNativeLog: true },
    },
  }
}

export function readOpenCodeNativeLogs(
  sessionIds: string[],
  options: OpenCodeLogDiagnosticOptions = {},
): OpenCodeNativeLogEntry[] {
  if (sessionIds.length === 0) return []
  const sessionIdSet = new Set(sessionIds)
  const results: OpenCodeNativeLogEntry[] = []

  for (const candidate of readCandidateLogFiles(options)) {
    const filePath = candidate.path
    let content
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    let unreadableLines = 0
    for (const [lineNumber, line] of content.split('\n').entries()) {
      if (!line.trim()) continue
      // Per line, because one unreadable row used to abort the rest of the
      // file — and with it the merged log channel, which 500s on the throw.
      try {
        const entry = parseNativeLogLine(line, sessionIdSet)
        if (entry) {
          results.push(decorateNativeEntry(entry.record, filePath, lineNumber, candidate.fileIdentity))
          if (entry.timestampUnreadable) unreadableLines += 1
        }
      } catch {
        unreadableLines += 1
      }
    }
    if (unreadableLines > 0) {
      // Bounded: one line per file, not one per bad row.
      console.warn(`[opencode] Skipped or de-timestamped ${unreadableLines} unreadable line(s) in ${filePath}.`)
    }
  }

  return results
}

/**
 * Read a candidate (or its saved append/tail range) without blocking the event
 * loop on a large, unrelated native archive. The stream keeps file I/O off the
 * request stack; the periodic yield also lets other ticket routes run while
 * lines are parsed.
 * Errors deliberately propagate: complete history must not cache an empty
 * snapshot when a candidate was unreadable.
 */
export async function readOpenCodeNativeLogFile(
  file: OpenCodeNativeLogFile,
  sessionIds: string[],
  options: OpenCodeNativeLogReadOptions = {},
): Promise<OpenCodeNativeLogEntry[]> {
  const startOffset = Math.max(0, options.startOffset ?? 0)
  const startLine = Math.max(0, options.startLine ?? 0)
  const stats = options.stats
  if (stats) {
    stats.startOffset = startOffset
    stats.startLine = startLine
    stats.bytesRead = 0
    stats.linesRead = 0
    stats.indexedOffset = startOffset
    stats.indexedLines = startLine
    stats.tailOffset = startOffset
    stats.endedWithNewline = true
    stats.entriesRead = 0
  }
  if (sessionIds.length === 0) return []
  const sessionIdSet = new Set(sessionIds)
  const results: OpenCodeNativeLogEntry[] = []
  let unreadableLines = 0
  let lineNumber = startLine
  let carry = ''
  let carryOffset = startOffset
  let readOffset = startOffset
  let completedLines = 0
  const stream = createReadStream(file.path, { encoding: 'utf8', start: startOffset })
  const parseLine = (line: string, location: OpenCodeNativeLogReadLocation) => {
    const currentLine = lineNumber
    lineNumber += 1
    if (stats) stats.linesRead += 1
    if (!line.trim()) return
    let parsed: ReturnType<typeof parseNativeLogLine>
    try {
      parsed = parseNativeLogLine(line, sessionIdSet)
    } catch {
      unreadableLines += 1
      return
    }
    if (!parsed) return
    const decorated = decorateNativeEntry(parsed.record, file.path, currentLine, file.fileIdentity)
    if (stats) stats.entriesRead += 1
    // Index callbacks are part of the durable history transaction. Keep them
    // outside the parser-repair catch: SQLITE_FULL, a closed database, or any
    // other storage failure must abort the read so its provisional generation
    // and offset can be rolled back by the caller.
    if (options.onEntry) options.onEntry(decorated, { ...location, lineNumber: currentLine })
    else results.push(decorated)
    if (parsed.timestampUnreadable) unreadableLines += 1
  }

  for await (const chunk of stream) {
    const text = String(chunk)
    const chunkBytes = Buffer.byteLength(text)
    readOffset += chunkBytes
    carry += text
    let newline = carry.indexOf('\n')
    while (newline >= 0) {
      const line = carry.slice(0, newline)
      const consumed = Buffer.byteLength(carry.slice(0, newline + 1))
      parseLine(line, {
        lineNumber,
        byteOffset: carryOffset,
        byteLength: consumed,
        complete: true,
      })
      carry = carry.slice(newline + 1)
      carryOffset += consumed
      completedLines += 1
      newline = carry.indexOf('\n')
    }
    if (lineNumber > 0 && lineNumber % 500 === 0) {
      await new Promise<void>(resolveYield => setImmediate(resolveYield))
    }
  }
  if (carry.length > 0) {
    parseLine(carry, {
      lineNumber,
      byteOffset: carryOffset,
      byteLength: Buffer.byteLength(carry),
      complete: false,
    })
  }
  if (stats) {
    stats.bytesRead = readOffset - startOffset
    stats.indexedLines = startLine + completedLines
    stats.indexedOffset = carry.length > 0 ? carryOffset : readOffset
    stats.tailOffset = carry.length > 0 ? carryOffset : stats.indexedOffset
    stats.endedWithNewline = carry.length === 0
  }
  if (unreadableLines > 0) {
    console.warn(`[opencode] Skipped or de-timestamped ${unreadableLines} unreadable line(s) in ${file.path}.`)
  }
  return results
}

export function findOpenCodeLogErrorDetails(
  sessionId: string | undefined,
  options: OpenCodeLogDiagnosticOptions = {},
): ModelErrorInfo | undefined {
  if (!sessionId) return undefined

  for (const candidate of readCandidateLogFiles(options)) {
    const filePath = candidate.path
    let content
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    const lines = content.split('\n')
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const details = parseLogLineError(lines[index] ?? '', sessionId)
      if (details) return details
    }
  }

  return undefined
}

export function enrichGenericOpenCodeProviderError(
  error: unknown,
  sessionId: string | undefined,
  options: OpenCodeLogDiagnosticOptions = {},
): OpenCodeErrorEnrichment | null {
  const existingSummary = summarizeModelErrorForLog(error)
  if (!isGenericProviderErrorMessage(existingSummary.message) && !isGenericProviderErrorMessage(existingSummary.details?.message)) {
    return null
  }

  const logDetails = findOpenCodeLogErrorDetails(sessionId, options)
  if (logDetails) {
    const summary = summarizeModelErrorForLog(logDetails, existingSummary.message)
    return {
      source: 'opencode_log',
      message: summary.message,
      details: summary.details ?? logDetails,
    }
  }

  const fallbackMessage = `${GENERIC_PROVIDER_ERROR}. ${TROUBLESHOOTING_HINT}`
  return {
    source: 'troubleshooting_hint',
    message: fallbackMessage,
    details: {
      ...(existingSummary.details ?? { name: 'UnknownError' }),
      message: fallbackMessage,
      responseErrorMessage: fallbackMessage,
    },
  }
}
