import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { basename } from 'node:path'
import { spawnProgram } from './tool-path.ts'

const MAX_DISPLAY_OCCUPANTS = 2
const MAX_COMMAND_LENGTH = 88

export type PortOccupantInfo = {
  pid: number | null
  ppid: number | null
  program: string | null
  command: string | null
  cwd: string | null
  source: 'lsof' | 'ss' | 'netstat' | 'powershell'
}

export type PortOccupantInspection = {
  port: number
  occupants: PortOccupantInfo[]
  rawSocketSnapshot: string | null
}

type PortInspectorDeps = {
  includeFallbackSnapshot: boolean
  readCwd: (pid: number) => string | null
  runCommand: (file: string, args: string[]) => string | null
  platform: NodeJS.Platform
}

function createDefaultDeps(): PortInspectorDeps {
  return {
    includeFallbackSnapshot: false,
    readCwd: (pid) => {
      if (process.platform !== 'linux') {
        return null
      }

      try {
        return realpathSync(`/proc/${pid}/cwd`)
      } catch {
        return null
      }
    },
    runCommand: (file, args) => {
      try {
        return execFileSync(spawnProgram(file), args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        }).trimEnd()
      } catch {
        return null
      }
    },
    platform: process.platform,
  }
}

function parseInteger(value: string | undefined) {
  if (!value) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function normalizeCommand(value: string | null | undefined) {
  return value?.trim().replace(/\s+/g, ' ') || null
}

function normalizeSocketSnapshot(output: string | null) {
  if (!output) return null

  const lines = output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)

  return lines.length > 1 ? lines.join('\n') : null
}

function combineSocketSnapshots(...snapshots: Array<string | null>) {
  const normalized = snapshots
    .map((snapshot) => normalizeSocketSnapshot(snapshot))
    .filter((snapshot): snapshot is string => Boolean(snapshot))

  return normalized.length > 0 ? normalized.join('\n') : null
}

function parseLsofOccupants(output: string | null): PortOccupantInfo[] {
  if (!output) return []

  const occupants: PortOccupantInfo[] = []

  for (const line of output.split('\n').slice(1)) {
    const trimmed = line.trim()
    if (!trimmed) continue

    const match = trimmed.match(/^(\S+)\s+(\d+)\s+/)
    if (!match) continue

    occupants.push({
      pid: parseInteger(match[2]),
      ppid: null,
      program: match[1] ?? null,
      command: match[1] ?? null,
      cwd: null,
      source: 'lsof',
    })
  }

  return occupants
}

function parseSsOccupants(output: string | null): PortOccupantInfo[] {
  if (!output) return []

  const occupants: PortOccupantInfo[] = []

  for (const line of output.split('\n')) {
    for (const match of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) {
      occupants.push({
        pid: parseInteger(match[2]),
        ppid: null,
        program: match[1] ?? null,
        command: match[1] ?? null,
        cwd: null,
        source: 'ss',
      })
    }
  }

  return occupants
}

function addressTokenHasPort(token: string, port: number) {
  const normalized = token.replace(/^\[/, '').replace(/\]$/, '')
  return normalized.endsWith(`:${port}`) || normalized.endsWith(`.${port}`)
}

function parseNetstatOccupants(output: string | null, port: number): PortOccupantInfo[] {
  if (!output) return []

  const occupants: PortOccupantInfo[] = []

  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!/^tcp/i.test(trimmed) || !/\bLISTEN(?:ING)?\b/i.test(trimmed)) continue

    const parts = trimmed.split(/\s+/)
    if (!parts.some((part) => addressTokenHasPort(part, port))) continue

    const pid = parseNetstatPid(parts.at(-1))
    if (!pid) continue

    occupants.push({
      pid,
      ppid: null,
      program: null,
      command: null,
      cwd: null,
      source: 'netstat',
    })
  }

  return occupants
}

function parseNetstatPid(value: string | undefined) {
  if (!value) return null
  return parseInteger(value) ?? parseInteger(value.match(/^(\d+)(?:\/|$)/)?.[1])
}

function getNetstatArgs(platform: NodeJS.Platform) {
  if (platform === 'win32') {
    return ['-ano', '-p', 'tcp']
  }

  if (platform === 'linux') {
    return ['-ltnp']
  }

  return ['-an', '-p', 'tcp']
}

function parseJsonRecords(output: string | null): Array<Record<string, unknown>> {
  if (!output) return []

  try {
    const parsed = JSON.parse(output) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    }
    return parsed && typeof parsed === 'object' ? [parsed as Record<string, unknown>] : []
  } catch {
    return []
  }
}

function parsePowerShellOccupants(output: string | null): PortOccupantInfo[] {
  return parseJsonRecords(output)
    .map((entry) => parseInteger(String(entry.OwningProcess ?? entry.ProcessId ?? '')))
    .filter((pid): pid is number => Boolean(pid))
    .map((pid) => ({
      pid,
      ppid: null,
      program: null,
      command: null,
      cwd: null,
      source: 'powershell' as const,
    }))
}

function dedupeByPid(occupants: PortOccupantInfo[]) {
  const unique = new Map<number, PortOccupantInfo>()

  for (const occupant of occupants) {
    if (!occupant.pid) continue
    if (!unique.has(occupant.pid)) {
      unique.set(occupant.pid, occupant)
    }
  }

  return [...unique.values()]
}

function enrichOccupant(occupant: PortOccupantInfo, deps: PortInspectorDeps): PortOccupantInfo {
  if (!occupant.pid) {
    return occupant
  }

  const psOutput = deps.runCommand('ps', ['-p', String(occupant.pid), '-o', 'pid=,ppid=,comm=,args='])
  const psLine = psOutput
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean)

  const match = psLine?.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
  const windowsProcess = match || deps.platform !== 'win32' ? null : parseJsonRecords(deps.runCommand('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId = ${occupant.pid}" | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
  ]))[0]
  const windowsCommand = typeof windowsProcess?.CommandLine === 'string'
    ? windowsProcess.CommandLine
    : typeof windowsProcess?.Name === 'string'
      ? windowsProcess.Name
      : null
  const windowsProgram = typeof windowsProcess?.Name === 'string' ? windowsProcess.Name : null

  return {
    pid: occupant.pid,
    ppid: parseInteger(match?.[2]) ?? parseInteger(String(windowsProcess?.ParentProcessId ?? '')) ?? occupant.ppid,
    program: match?.[3] ?? windowsProgram ?? occupant.program,
    command: normalizeCommand(match?.[4] ?? windowsCommand) ?? occupant.command,
    cwd: deps.readCwd(occupant.pid),
    source: occupant.source,
  }
}

function shortenMiddle(value: string, maxLength: number) {
  if (value.length <= maxLength) {
    return value
  }

  const segmentLength = Math.max(8, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, segmentLength)}...${value.slice(-segmentLength)}`
}

function compactCommand(command: string | null) {
  const normalized = normalizeCommand(command)
  if (!normalized) return null

  const match = normalized.match(/^(\S+)(.*)$/)
  if (!match) {
    return shortenMiddle(normalized, MAX_COMMAND_LENGTH)
  }

  const firstToken = match[1] ?? ''
  const rest = match[2] ?? ''
  const compactFirstToken = firstToken.includes('/') ? basename(firstToken) : firstToken

  return shortenMiddle(`${compactFirstToken}${rest}`, MAX_COMMAND_LENGTH)
}

function compactPath(cwd: string | null) {
  if (!cwd) return null

  const normalized = cwd.trim()
  return normalized || null
}

function inferProgramName(program: string | null | undefined, command: string | null | undefined) {
  if (program?.trim()) {
    return program.trim()
  }

  const normalizedCommand = normalizeCommand(command)
  if (!normalizedCommand) return null

  const firstToken = normalizedCommand.match(/^(\S+)/)?.[1]
  if (!firstToken) return null

  return firstToken.includes('/') ? basename(firstToken) : firstToken
}

export function inspectPortOccupants(
  port: number,
  providedDeps?: Partial<PortInspectorDeps>,
): PortOccupantInspection {
  const deps = {
    ...createDefaultDeps(),
    ...providedDeps,
  }

  const lsofOutput = deps.runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'])
  const ssOutput = deps.runCommand('ss', ['-ltnp', `( sport = :${port} )`])
  const lsofOccupants = parseLsofOccupants(lsofOutput)
  const ssOccupants = parseSsOccupants(ssOutput)
  const powerShellOutput = deps.platform === 'win32' && lsofOccupants.length === 0 && ssOccupants.length === 0
    ? deps.runCommand('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess | ConvertTo-Json -Compress`,
    ])
    : null
  const powerShellOccupants = parsePowerShellOccupants(powerShellOutput)
  const shouldTryNetstat =
    deps.includeFallbackSnapshot ||
    (lsofOccupants.length === 0 &&
      ssOccupants.length === 0 &&
      powerShellOccupants.length === 0)
  const netstatOutput = shouldTryNetstat ? deps.runCommand('netstat', getNetstatArgs(deps.platform)) : null
  const netstatOccupants = parseNetstatOccupants(netstatOutput, port)
  const rawSocketSnapshot = combineSocketSnapshots(ssOutput, netstatOutput)

  const occupants = dedupeByPid(
    lsofOccupants.length > 0
      ? lsofOccupants
      : ssOccupants.length > 0
        ? ssOccupants
        : powerShellOccupants.length > 0
          ? powerShellOccupants
          : netstatOccupants,
  ).map((occupant) => enrichOccupant(occupant, deps))

  return {
    port,
    occupants,
    rawSocketSnapshot,
  }
}

export function listPortOccupantPids(
  port: number,
  providedDeps?: Partial<PortInspectorDeps>,
) {
  return inspectPortOccupants(port, providedDeps)
    .occupants
    .map((occupant) => occupant.pid)
    .filter((pid): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 0)
}

type PortOccupantSummaryInput = {
  pid?: number | null
  program?: string | null
  command?: string | null
  cwd?: string | null
}

export function formatPortOccupantSummary(input: PortOccupantSummaryInput) {
  const pid = parseInteger(String(input.pid ?? ''))
  const program = inferProgramName(input.program ?? null, input.command ?? null)
  const compactedCommand = compactCommand(input.command ?? null)
  const compactedCwd = compactPath(input.cwd ?? null)
  const details: string[] = []

  if (pid) {
    details.push(`pid ${pid}`)
  }

  if (compactedCommand && compactedCommand !== program) {
    details.push(`cmd: ${compactedCommand}`)
  }

  if (compactedCwd) {
    details.push(`cwd: ${compactedCwd}`)
  }

  if (!program && pid) {
    return details.join(', ')
  }

  if (!program) {
    return null
  }

  if (details.length === 0) {
    return program
  }

  return `${program} (${details.join(', ')})`
}

export function formatPortOccupantLabel(occupants: readonly PortOccupantSummaryInput[]) {
  const formatted = occupants
    .map((occupant) => formatPortOccupantSummary(occupant))
    .filter((summary): summary is string => Boolean(summary))

  if (formatted.length === 0) {
    return null
  }

  const visible = formatted.slice(0, MAX_DISPLAY_OCCUPANTS)
  const remainder = formatted.length - visible.length
  const noun = formatted.length === 1 ? 'Occupant' : 'Occupants'
  const moreSuffix = remainder > 0 ? ` (+${remainder} more)` : ''

  return `${noun}: ${visible.join('; ')}${moreSuffix}.`
}

export function appendPortOccupantDetails(
  message: string,
  occupants: readonly PortOccupantSummaryInput[],
) {
  const label = formatPortOccupantLabel(occupants)
  return label ? `${message} ${label}` : message
}

export function describePortOccupants(
  port: number,
  inspection = inspectPortOccupants(port),
) {
  return appendPortOccupantDetails(
    `Port ${port} is in use by another process.`,
    inspection.occupants,
  )
}
