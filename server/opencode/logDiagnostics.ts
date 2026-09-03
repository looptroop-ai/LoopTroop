import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
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

function readCandidateLogFiles(options: OpenCodeLogDiagnosticOptions): string[] {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_LOG_FILES
  const maxBytes = options.maxBytesPerFile ?? DEFAULT_MAX_LOG_BYTES
  const candidates: Array<{ path: string; mtimeMs: number }> = []

  for (const dir of resolveOpenCodeLogDirs(options)) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const filePath = join(dir, entry)
      let stat
      try {
        stat = statSync(filePath)
      } catch {
        continue
      }
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) continue
      candidates.push({ path: filePath, mtimeMs: stat.mtimeMs })
    }
  }

  return candidates
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, maxFiles)
    .map((candidate) => candidate.path)
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
  data: Record<string, unknown>
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

  for (const filePath of readCandidateLogFiles(options)) {
    let content
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    let unreadableLines = 0
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      // Per line, because one unreadable row used to abort the rest of the
      // file — and with it the merged log channel, which 500s on the throw.
      try {
        const entry = parseNativeLogLine(line, sessionIdSet)
        if (entry) {
          results.push(entry.record)
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

export function findOpenCodeLogErrorDetails(
  sessionId: string | undefined,
  options: OpenCodeLogDiagnosticOptions = {},
): ModelErrorInfo | undefined {
  if (!sessionId) return undefined

  for (const filePath of readCandidateLogFiles(options)) {
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
