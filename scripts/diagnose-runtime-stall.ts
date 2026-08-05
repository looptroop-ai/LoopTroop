import { spawnSync } from 'node:child_process'
import { promises as dnsPromises } from 'node:dns'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { getErrorMessage } from '../shared/typeGuards'

interface CliOptions {
  backendPort?: number
  frontendPort?: number
  opencodeUrl?: string
  timeoutMs?: number
  sampleMs?: number
  trendMs?: number
  trendIntervalMs?: number
  ticketPath?: string
  noColor?: boolean
}

interface CommandResult {
  command: string
  shell?: string
  durationMs: number
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  error?: string
}

interface HttpProbeResult {
  label: string
  url: string
  durationMs: number
  ok: boolean
  status: number | null
  bodyPreview: string
  error?: string
}

interface FsLatencyProbe {
  label: string
  durationMs: number
  ok: boolean
  details: string
  error?: string
}

interface MountSnapshot {
  path: string
  target: string | null
  source: string | null
  fstype: string | null
  options: string | null
  error?: string
}

interface DiskUsageSnapshot {
  path: string
  filesystem: string | null
  totalKb: number | null
  usedKb: number | null
  availableKb: number | null
  usePercent: number | null
  mountedOn: string | null
  error?: string
}

interface InodeUsageSnapshot {
  path: string
  filesystem: string | null
  totalInodes: number | null
  usedInodes: number | null
  freeInodes: number | null
  usePercent: number | null
  mountedOn: string | null
  error?: string
}

interface PressureMetrics {
  avg10: number | null
  avg60: number | null
  avg300: number | null
  total: number | null
  raw: string
}

interface PressureSnapshot {
  path: string
  some: PressureMetrics | null
  full: PressureMetrics | null
  error?: string
}

interface ProcessIoSnapshot {
  pid: number
  values: Record<string, number>
  raw: string
  error?: string
}

interface ProcessRuntimeSnapshot {
  pid: number
  command: string | null
  state: string | null
  wchan: string | null
  cpuTicks: number | null
  rssKb: number | null
  numThreads: number | null
  fdCount: number | null
  readBytes: number | null
  writeBytes: number | null
  syscr: number | null
  syscw: number | null
  capturedAtMs: number
  error?: string
}

interface ProcessActivitySample {
  label: string
  pid: number | null
  durationMs: number
  cpuPercent: number | null
  rssKb: number | null
  numThreads: number | null
  fdCount: number | null
  fdCountDelta: number | null
  readBytesDelta: number | null
  writeBytesDelta: number | null
  syscrDelta: number | null
  syscwDelta: number | null
  state: string | null
  wchan: string | null
  command: string | null
  error?: string
}

interface SystemProcessUsage {
  pid: number
  command: string
  cpuPercent: number | null
  rssKb: number | null
  readBytesDelta: number | null
  writeBytesDelta: number | null
}

interface SystemProcessActivitySnapshot {
  durationMs: number
  processCount: number
  topCpu: SystemProcessUsage[]
  topRss: SystemProcessUsage[]
  topReadBytes: SystemProcessUsage[]
  topWriteBytes: SystemProcessUsage[]
}

interface SystemTrendUsageAggregate {
  key: string
  pid: number
  command: string
  samples: number
  firstSeenAt: string
  lastSeenAt: string
  peakCpuPercent: number | null
  peakRssKb: number | null
  totalReadBytes: number
  totalWriteBytes: number
}

interface TrendFileTarget {
  label: string
  path: string
}

interface TrendFileSample {
  label: string
  path: string
  exists: boolean
  sizeBytes: number | null
  sizeDeltaBytes: number | null
  modifiedAt: string | null
  error?: string
}

interface PressureTrendDelta {
  ioSomeUs: number | null
  ioFullUs: number | null
  memorySomeUs: number | null
  memoryFullUs: number | null
  cpuSomeUs: number | null
  cpuFullUs: number | null
}

interface PressureTrendTotals {
  ioSome: number | null
  ioFull: number | null
  memorySome: number | null
  memoryFull: number | null
  cpuSome: number | null
  cpuFull: number | null
}

interface RuntimeTrendSample {
  index: number
  at: string
  elapsedMs: number
  intervalMs: number
  loopDriftMs: number
  health: HttpProbeResult
  tickets: HttpProbeResult
  processActivities: ProcessActivitySample[]
  systemActivity: SystemProcessActivitySnapshot
  files: TrendFileSample[]
  pressureDelta: PressureTrendDelta
}

interface RuntimeTrendReport {
  enabled: boolean
  durationMs: number
  intervalMs: number
  samples: RuntimeTrendSample[]
}

interface TicketRuntimeTarget {
  inputPath: string
  resolvedInputPath: string
  ticketRootPath: string
  runtimePath: string
  worktreePath: string | null
  ticketId: string | null
  notes: string[]
}

interface ProcessRecord {
  pid: number
  ppid: number | null
  elapsed: string | null
  pcpu: number | null
  pmem: number | null
  rssKb: number | null
  args: string
}

interface ProcessMemorySnapshot {
  pid: number
  name: string | null
  state: string | null
  vmRssKb: number | null
  vmHwmKb: number | null
  vmSizeKb: number | null
  vmPeakKb: number | null
  threads: number | null
  fdSize: number | null
  voluntaryCtxtSwitches: number | null
  nonvoluntaryCtxtSwitches: number | null
  oomScore: number | null
  oomScoreAdj: number | null
  error?: string
}

interface RepeatedProbeSample {
  at: string
  healthOk: boolean
  healthStatus: number | null
  healthDurationMs: number
  healthError?: string
  ticketsOk: boolean
  ticketsStatus: number | null
  ticketsDurationMs: number
  ticketsError?: string
  processStat: string | null
  processWchan: string | null
}

interface SpawnLatencyBaseline {
  label: string
  result: CommandResult
}

interface AttachedProjectRow {
  id: number
  folderPath: string
  createdAt: string
  updatedAt: string
}

interface TicketRow {
  external_id: string
  status: string
  updated_at: string
}

interface ActiveSessionRow {
  session_id: string
  ticket_id: number | null
  phase: string
  member_id: string | null
  step: string | null
  updated_at: string
}

interface ProjectSnapshot {
  id: number
  folderPath: string
  resolvedFolderPath: string
  exists: boolean
  projectDbPath: string
  projectDbExists: boolean
  projectName: string | null
  shortname: string | null
  ticketCounter: number | null
  ticketCount: number
  activeSessionCount: number
  recentTickets: TicketRow[]
  latestNonTerminalTicketLog: TicketLogPreview | null
  activeSessions: ActiveSessionRow[]
  statusCounts: Array<{ status: string; count: number }>
  metaFilesChecked: number
  missingMetaFiles: number
  metaWithoutBaseBranch: number
  metaCheckDetails: string[]
  pathCheckDetails: string[]
  dbOpenMs: number
  dbQueryMs: number
  mount: MountSnapshot
  diskUsage: DiskUsageSnapshot
  inodeUsage: InodeUsageSnapshot
  latencyProbes: FsLatencyProbe[]
}

interface TicketLogPreview {
  externalId: string
  status: string
  logPath: string
  exists: boolean
  tailLines: string[]
  detail?: string
}

type Platform = 'linux' | 'wsl' | 'macos' | 'windows'

interface DnsProbeResult {
  hostname: string
  ok: boolean
  durationMs: number
  addresses: string[]
  error?: string
}

interface FdLimits {
  soft: number | null
  hard: number | null
  error?: string
}

interface TcpStats {
  established: number
  timeWait: number
  closeWait: number
  listen: number
  error?: string
}

interface SwapSnapshot {
  totalKb: number | null
  freeKb: number | null
  usedKb: number | null
  usePercent: number | null
  error?: string
}

interface DiagnosticHeap {
  heapUsedMb: number
  heapTotalMb: number
  externalMb: number
  rssMb: number
}

interface MacosSystemMetrics {
  vmStatRaw: string | null
  loadAvg: string | null
  cpuCount: number | null
  topProcessesRaw: string | null
  error?: string
}

const cli = parseCliArgs(process.argv.slice(2))
const reportLines: string[] = []
const startedAt = new Date()
const runTimestamp = formatFileTimestamp(startedAt)
// User-space, not cwd: as a global command this would otherwise scatter reports
// into whatever directory the user happened to run from.
const reportDir = resolve(resolveAppConfigDir(process.env as Record<string, string>), 'diagnostics')
const reportPath = resolve(reportDir, `runtime-stall-${runTimestamp}.log`)
const commandAvailability = new Map<string, boolean>()

let detectedPlatform: Platform | null = null

function detectPlatform(): Platform {
  if (detectedPlatform) return detectedPlatform
  if (process.platform === 'win32') {
    detectedPlatform = 'windows'
    return detectedPlatform
  }
  if (process.platform === 'darwin') {
    detectedPlatform = 'macos'
    return detectedPlatform
  }
  const procVersion = (() => {
    try { return readFileSync('/proc/version', 'utf8').toLowerCase() } catch { return '' }
  })()
  detectedPlatform = procVersion.includes('microsoft') ? 'wsl' : 'linux'
  return detectedPlatform
}

function isWindowsDrivePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path)
}

function isWindowsUncPath(path: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(path)
}

function resolvePortablePath(path: string, basePath = process.cwd()): string {
  const trimmed = path.trim()
  if (!trimmed) return trimmed

  const platform = detectPlatform()
  const windowsDriveMatch = trimmed.match(/^([a-z]):[\\/](.*)$/i)
  if (windowsDriveMatch) {
    if (platform === 'wsl') {
      const drive = windowsDriveMatch[1]!.toLowerCase()
      const rest = windowsDriveMatch[2]!.replace(/\\/g, '/')
      return `/mnt/${drive}/${rest}`
    }

    return trimmed
  }

  if (isWindowsUncPath(trimmed)) {
    return trimmed
  }

  return isAbsolute(trimmed) ? trimmed : resolve(basePath, trimmed)
}

function describePortablePathResolution(inputPath: string, resolvedPath: string): string | null {
  if (inputPath === resolvedPath) {
    if (isWindowsDrivePath(inputPath) && detectPlatform() !== 'windows' && detectPlatform() !== 'wsl') {
      return `Windows drive path is not directly accessible on ${detectPlatform()}.`
    }
    return null
  }

  return `Resolved platform path: ${resolvedPath}`
}

const colorEnabled = (() => {
  if (process.argv.includes('--no-color') || process.env.NO_COLOR) return false
  if (process.env.FORCE_COLOR) return true
  return Boolean(process.stdout.isTTY)
})()

if (process.argv.includes('--help')) {
  printHelp()
  process.exit(0)
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

type AnsiColor = 'red' | 'yellow' | 'green' | 'cyan' | 'bold' | 'dim' | 'magenta'

const ANSI: Record<AnsiColor, string> = {
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  magenta: '\x1b[35m',
}
const ANSI_RESET = '\x1b[0m'

function colorize(text: string, color: AnsiColor): string {
  if (!colorEnabled) return text
  return `${ANSI[color]}${text}${ANSI_RESET}`
}

function print(line = '') {
  console.log(line)
  reportLines.push(stripAnsi(line))
}

function heading(title: string) {
  print()
  const decorated = colorize(`── ${title} ──`, 'bold')
  print(decorated)
}

function banner(emojiAndTitle: string) {
  const LINE_WIDTH = 62
  const inner = ` ${emojiAndTitle} `
  const pad = Math.max(0, LINE_WIDTH - inner.length)
  const top = `╔${'═'.repeat(LINE_WIDTH + 2)}╗`
  const mid = `║${inner}${' '.repeat(pad)} ║`
  const bot = `╚${'═'.repeat(LINE_WIDTH + 2)}╝`
  print()
  print(colorize(top, 'bold'))
  print(colorize(mid, 'bold'))
  print(colorize(bot, 'bold'))
}

function kv(label: string, value: unknown) {
  print(`${label}: ${formatValue(value)}`)
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'n/a'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, 2)
}

function formatDuration(durationMs: number): string {
  return `${durationMs}ms`
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  const abs = Math.abs(value)
  if (abs >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  if (abs >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`
  if (abs >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a'
  return `${value.toFixed(1)}%`
}

function formatBodyPreview(raw: string, limit = 500): string {
  const compact = raw.replace(/\s+/g, ' ').trim()
  if (compact.length <= limit) return compact || '(empty body)'
  return `${compact.slice(0, limit)}...`
}

function formatFileTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = {}

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg) continue

    const next = args[i + 1]

    if (arg === '--backend-port' && next) {
      options.backendPort = Number(next)
      i += 1
      continue
    }

    if (arg === '--frontend-port' && next) {
      options.frontendPort = Number(next)
      i += 1
      continue
    }

    if (arg === '--opencode-url' && next) {
      options.opencodeUrl = next
      i += 1
      continue
    }

    if (arg === '--timeout-ms' && next) {
      options.timeoutMs = Number(next)
      i += 1
      continue
    }

    if (arg === '--sample-ms' && next) {
      options.sampleMs = Number(next)
      i += 1
      continue
    }

    if (arg === '--trend-ms' && next) {
      options.trendMs = Number(next)
      i += 1
      continue
    }

    if (arg === '--trend-interval-ms' && next) {
      options.trendIntervalMs = Number(next)
      i += 1
      continue
    }

    if (arg === '--ticket-path' && next) {
      options.ticketPath = next
      i += 1
      continue
    }

    if (arg === '--no-color') {
      options.noColor = true
      continue
    }
  }

  return options
}

function printHelp() {
  console.log(`LoopTroop runtime stall diagnostics

Usage:
  npm run diagnose:stall

Optional flags:
  --backend-port <port>
  --frontend-port <port>
  --opencode-url <url>
  --timeout-ms <ms>
  --sample-ms <ms>
  --trend-ms <ms>            Runtime observation window duration. Default: 180000 (3m). Use 0 to disable.
  --trend-interval-ms <ms>   Trend sample interval. Default: 1000.
  --ticket-path <path>       Focus artifact and log diagnostics on a ticket .ticket, runtime, or worktree path.
  --no-color         Disable colored output (also respects NO_COLOR env var)

What it checks:
  - Frontend, backend, and OpenCode endpoint responsiveness
  - Relevant running processes, backend listener details, and fallback watcher/candidate detection
  - Backend thread wait states when available
  - One-window CPU, memory, I/O, and file-descriptor activity for backend/frontend/OpenCode
  - Whole-system top CPU/RSS/read-I/O/write-I/O consumers during the sample window and trend window
  - Per-process memory snapshots from /proc (RSS/HWM/threads/OOM score)
  - System load, memory, and Linux pressure stall metrics
  - Linux cgroup resource snapshot when available
  - Mount type, disk space, and inode usage for app/project paths
  - Per-process I/O counters from /proc/<pid>/io
  - Workspace/project mount, cwd, and watcher environment data
  - Best-effort kernel OOM scan from dmesg
  - App DB attached projects
  - Project DB ticket/session state
  - Git responsiveness for attached projects
  - A short repeated backend sampler across HTTP probes
  - A multi-minute trend sampler for process CPU/RSS/I/O, HTTP latency, pressure deltas, and growing files
  - Optional ticket-focused runtime artifact size, largest files, and execution-log growth checks
  - Shell startup baseline to separate diagnostic overhead from real probe latency
  - Git Trace2 perf output for repo status calls
  - Direct filesystem latency probes for project metadata paths
  - Ticket meta file presence and baseBranch fields
`)
}

function runShell(command: string, timeoutMs = 5000): CommandResult {
  const start = Date.now()
  const platform = detectPlatform()

  let shellCmd: string
  let shellArgs: string[]

  if (platform === 'windows') {
    shellCmd = 'powershell.exe'
    shellArgs = ['-NoProfile', '-NonInteractive', '-Command', command]
  } else {
    // Linux, macOS, WSL — try bash first, fall back to sh
    shellCmd = 'bash'
    shellArgs = ['--noprofile', '--norc', '-c', command]
  }

  const result = spawnSync(shellCmd, shellArgs, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
  })

  const durationMs = Date.now() - start
  const error = result.error

  // If bash not found, retry with sh
  if (error && (error as NodeJS.ErrnoException).code === 'ENOENT' && shellCmd === 'bash') {
    const fallback = spawnSync('sh', ['-c', command], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: timeoutMs,
    })
    const fallbackError = fallback.error
    const timedOut = fallbackError?.name === 'TimeoutError'
    return {
      command,
      shell: 'sh -c',
      durationMs: Date.now() - start,
      exitCode: fallback.status,
      signal: fallback.signal,
      stdout: fallback.stdout ?? '',
      stderr: fallback.stderr ?? '',
      timedOut,
      ...(fallbackError ? { error: fallbackError.message } : {}),
    }
  }

  const timedOut = error?.name === 'TimeoutError'
  return {
    command,
    shell: `${shellCmd} ${shellArgs.slice(0, -1).join(' ')}`,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
    ...(error ? { error: error.message } : {}),
  }
}

function runProcess(command: string, args: string[], timeoutMs = 3000): CommandResult {
  const start = Date.now()
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    timeout: timeoutMs,
  })

  const durationMs = Date.now() - start
  const error = result.error
  const timedOut = error?.name === 'TimeoutError'
  const displayCommand = [command, ...args].map((part) => part.includes(' ') ? shellQuote(part) : part).join(' ')

  return {
    command: displayCommand,
    durationMs,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    timedOut,
    ...(error ? { error: error.message } : {}),
  }
}

function printCommandResult(title: string, result: CommandResult) {
  heading(title)
  kv('Command', result.command)
  if (result.shell) kv('Shell', result.shell)
  kv('Duration', formatDuration(result.durationMs))
  kv('Exit code', result.exitCode)
  kv('Signal', result.signal)
  kv('Timed out', result.timedOut)
  if (result.error) kv('Error', result.error)

  print('-- stdout --')
  print(result.stdout.trim() || '(empty)')
  print('-- stderr --')
  print(result.stderr.trim() || '(empty)')
}

function collectShellLatencyBaselines(): SpawnLatencyBaseline[] {
  const platform = detectPlatform()
  const baselines: SpawnLatencyBaseline[] = []

  if (platform !== 'windows') {
    baselines.push({ label: 'direct true', result: runProcess('/bin/true', [], 3000) })
    baselines.push({ label: 'sh -c true', result: runProcess('sh', ['-c', 'true'], 3000) })
    baselines.push({ label: 'bash --noprofile --norc -c true', result: runProcess('bash', ['--noprofile', '--norc', '-c', 'true'], 3000) })
    baselines.push({ label: 'bash -lc true', result: runProcess('bash', ['-lc', 'true'], 3000) })
  }

  const psResult = runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], 5000)
  if (!psResult.error?.includes('ENOENT')) {
    baselines.push({ label: 'powershell.exe -NoProfile -Command exit 0', result: psResult })
  }

  return baselines
}

function printShellLatencyBaselines(baselines: SpawnLatencyBaseline[]) {
  heading('Shell Startup Latency Baseline')
  for (const baseline of baselines) {
    print(`- ${baseline.label}: duration=${formatDuration(baseline.result.durationMs)} exit=${baseline.result.exitCode}`)
    if (baseline.result.timedOut) print('  timed_out=true')
    if (baseline.result.error) print(`  error=${baseline.result.error}`)
  }
}

function parseEnvFile(raw: Buffer | string): Record<string, string> {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw
  const entries = text.split('\0').filter(Boolean)
  const env: Record<string, string> = {}

  for (const entry of entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) continue
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }

  return env
}

function readProcessEnv(pid: number): Record<string, string> {
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') return {}
  try {
    return parseEnvFile(readFileSync(`/proc/${pid}/environ`))
  } catch {
    return {}
  }
}

function readProcessCwd(pid: number): string | null {
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') return null
  try {
    return realpathSync(`/proc/${pid}/cwd`)
  } catch {
    return null
  }
}

function commandExists(binary: string): boolean {
  const cached = commandAvailability.get(binary)
  if (cached !== undefined) return cached

  const platform = detectPlatform()
  const result = platform === 'windows'
    ? runPowerShell(`Get-Command -Name ${powerShellQuote(binary)} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Name`, 2000)
    : runShell(`command -v ${shellQuote(binary)}`, 2000)
  const exists = result.exitCode === 0 && result.stdout.trim().length > 0
  commandAvailability.set(binary, exists)
  return exists
}

function measureDiskWriteLatency(dirPath: string): FsLatencyProbe {
  const startedAt = Date.now()
  const tempFile = resolve(dirPath, `.stall-diag-${Math.random().toString(36).slice(2)}.tmp`)
  const buffer = Buffer.alloc(1024 * 64, 'x') // 64KB write

  try {
    writeFileSync(tempFile, buffer)
    const stats = statSync(tempFile)
    const readBack = readFileSync(tempFile)
    try {
      unlinkSync(tempFile)
    } catch { /* ignore */ }
    
    return {
      label: 'disk write/read latency (64KB)',
      durationMs: Date.now() - startedAt,
      ok: true,
      details: `wrote ${stats.size} bytes, read back ${readBack.length} bytes`,
    }
  } catch (error) {
    return {
      label: 'disk write latency (64KB)',
      durationMs: Date.now() - startedAt,
      ok: false,
      details: '(operation failed)',
      error: getErrorMessage(error),
    }
  }
}

function runPowerShell(command: string, timeoutMs = 5000): CommandResult {
  return runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], timeoutMs)
}

function skippedCommandResult(command: string, message: string): CommandResult {
  return {
    command,
    durationMs: 0,
    exitCode: null,
    signal: null,
    stdout: message,
    stderr: '',
    timedOut: false,
  }
}

function parseNetstatListeningPid(output: string, port: number): number | null {
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!/^tcp/i.test(trimmed) || !/\bLISTEN(?:ING)?\b/i.test(trimmed)) continue
    const parts = trimmed.split(/\s+/)
    if (!parts.some((part) => part.endsWith(`:${port}`) || part.endsWith(`.${port}`))) continue

    const pid = parseInteger(parts.at(-1))
    if (pid && pid > 0) return pid
  }

  return null
}

function parseJsonRecords(output: string): Array<Record<string, unknown>> {
  if (!output.trim()) return []

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

function findListeningPid(port: number): number | null {
  const platform = detectPlatform()
  if (platform === 'windows') {
    const result = runPowerShell(`Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Select-Object -First 1`, 3000)
    const pid = Number(result.stdout.trim())
    if (Number.isInteger(pid) && pid > 0) return pid

    const netstatResult = runProcess('netstat', ['-ano', '-p', 'tcp'], 3000)
    return parseNetstatListeningPid(netstatResult.stdout, port)
  }

  if (commandExists('lsof')) {
    const lsofResult = runShell(`lsof -tiTCP:${port} -sTCP:LISTEN | head -n 1`, 3000)
    const lsofPid = Number(lsofResult.stdout.trim())
    if (Number.isInteger(lsofPid) && lsofPid > 0) return lsofPid
  }

  if (commandExists('ss')) {
    const ssResult = runShell(`ss -ltnp '( sport = :${port} )'`, 3000)
    const match = ssResult.stdout.match(/pid=(\d+)/)
    if (match?.[1]) {
      const pid = Number(match[1])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
  }

  return null
}

async function probeHttp(label: string, url: string, timeoutMs: number): Promise<HttpProbeResult> {
  const start = Date.now()
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const body = await response.text()
    return {
      label,
      url,
      durationMs: Date.now() - start,
      ok: response.ok,
      status: response.status,
      bodyPreview: formatBodyPreview(body),
    }
  } catch (error) {
    return {
      label,
      url,
      durationMs: Date.now() - start,
      ok: false,
      status: null,
      bodyPreview: '(no response body)',
      error: getErrorMessage(error),
    }
  }
}

function parsePercent(raw: string | undefined): number | null {
  if (!raw) return null
  const parsed = Number(raw.replace('%', ''))
  return Number.isFinite(parsed) ? parsed : null
}

function parseInteger(raw: string | undefined): number | null {
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function inspectMount(path: string): MountSnapshot {
  if (!existsSync(path)) {
    return {
      path,
      target: null,
      source: null,
      fstype: null,
      options: null,
      error: 'Path does not exist',
    }
  }

  const platform = detectPlatform()
  if (platform === 'windows') {
    return {
      path,
      target: null,
      source: null,
      fstype: null,
      options: null,
      error: 'Mount details are not available from this diagnostic on Windows',
    }
  }

  if (!commandExists('findmnt')) {
    if (platform === 'macos' && commandExists('df')) {
      const result = runShell(`df -Pk ${shellQuote(path)} | tail -n 1`, 3000)
      const parts = result.stdout.trim().split(/\s+/)
      return {
        path,
        target: parts[5] ?? null,
        source: parts[0] ?? null,
        fstype: null,
        options: null,
        error: result.exitCode === 0 ? undefined : result.stderr.trim() || result.error,
      }
    }

    return {
      path,
      target: null,
      source: null,
      fstype: null,
      options: null,
      error: '`findmnt` is not available on this system',
    }
  }

  const result = runShell(`findmnt -rn -T ${shellQuote(path)} -o TARGET,SOURCE,FSTYPE,OPTIONS`, 3000)
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return {
      path,
      target: null,
      source: null,
      fstype: null,
      options: null,
      error: result.stderr.trim() || result.error || 'Unable to resolve mount information',
    }
  }

  const line = result.stdout.trim().split('\n')[0]?.trim() ?? ''
  const parts = line.split(/\s+/)
  return {
    path,
    target: parts[0] ?? null,
    source: parts[1] ?? null,
    fstype: parts[2] ?? null,
    options: parts.slice(3).join(' ') || null,
  }
}

function inspectDiskUsage(path: string): DiskUsageSnapshot {
  if (!existsSync(path)) {
    return {
      path,
      filesystem: null,
      totalKb: null,
      usedKb: null,
      availableKb: null,
      usePercent: null,
      mountedOn: null,
      error: 'Path does not exist',
    }
  }

  if (detectPlatform() === 'windows') {
    const drive = path.match(/^([a-z]):/i)?.[1]
    if (!drive) {
      return {
        path,
        filesystem: null,
        totalKb: null,
        usedKb: null,
        availableKb: null,
        usePercent: null,
        mountedOn: null,
        error: 'Unable to infer Windows drive letter',
      }
    }

    const result = runPowerShell(`Get-PSDrive -Name ${powerShellQuote(drive)} | Select-Object Name,Root,Used,Free | ConvertTo-Json -Compress`, 3000)
    const driveInfo = parseJsonRecords(result.stdout)[0]
    const usedBytes = parseInteger(String(driveInfo?.Used ?? ''))
    const freeBytes = parseInteger(String(driveInfo?.Free ?? ''))
    const totalBytes = usedBytes !== null && freeBytes !== null ? usedBytes + freeBytes : null
    return {
      path,
      filesystem: driveInfo?.Name ? `${driveInfo.Name}:` : `${drive.toUpperCase()}:`,
      totalKb: totalBytes !== null ? Math.round(totalBytes / 1024) : null,
      usedKb: usedBytes !== null ? Math.round(usedBytes / 1024) : null,
      availableKb: freeBytes !== null ? Math.round(freeBytes / 1024) : null,
      usePercent: totalBytes && usedBytes !== null ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
      mountedOn: typeof driveInfo?.Root === 'string' ? driveInfo.Root : `${drive.toUpperCase()}:\\`,
      ...(result.exitCode !== 0 || result.error ? { error: result.stderr.trim() || result.error || 'Unable to read Windows drive usage' } : {}),
    }
  }

  const result = runShell(`df -Pk ${shellQuote(path)} | tail -n 1`, 3000)
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return {
      path,
      filesystem: null,
      totalKb: null,
      usedKb: null,
      availableKb: null,
      usePercent: null,
      mountedOn: null,
      error: result.stderr.trim() || result.error || 'Unable to read df output',
    }
  }

  const parts = result.stdout.trim().split(/\s+/)
  return {
    path,
    filesystem: parts[0] ?? null,
    totalKb: parseInteger(parts[1]),
    usedKb: parseInteger(parts[2]),
    availableKb: parseInteger(parts[3]),
    usePercent: parsePercent(parts[4]),
    mountedOn: parts[5] ?? null,
  }
}

function inspectInodeUsage(path: string): InodeUsageSnapshot {
  if (!existsSync(path)) {
    return {
      path,
      filesystem: null,
      totalInodes: null,
      usedInodes: null,
      freeInodes: null,
      usePercent: null,
      mountedOn: null,
      error: 'Path does not exist',
    }
  }

  if (detectPlatform() === 'windows') {
    return {
      path,
      filesystem: null,
      totalInodes: null,
      usedInodes: null,
      freeInodes: null,
      usePercent: null,
      mountedOn: null,
      error: 'Inode usage is not applicable on Windows',
    }
  }

  const result = runShell(`df -Pi ${shellQuote(path)} | tail -n 1`, 3000)
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    return {
      path,
      filesystem: null,
      totalInodes: null,
      usedInodes: null,
      freeInodes: null,
      usePercent: null,
      mountedOn: null,
      error: result.stderr.trim() || result.error || 'Unable to read inode df output',
    }
  }

  const parts = result.stdout.trim().split(/\s+/)
  const totalInodes = parseInteger(parts[1])
  const usedInodes = parseInteger(parts[2])
  const freeInodes = parseInteger(parts[3])
  const usePercent = parsePercent(parts[4])
  return {
    path,
    filesystem: parts[0] ?? null,
    totalInodes: totalInodes !== null && totalInodes >= 0 ? totalInodes : null,
    usedInodes: usedInodes !== null && usedInodes >= 0 ? usedInodes : null,
    freeInodes: freeInodes !== null && freeInodes >= 0 ? freeInodes : null,
    usePercent,
    mountedOn: parts[5] ?? null,
  }
}

function measureFsLatency(label: string, action: () => string): FsLatencyProbe {
  const startedAt = Date.now()
  try {
    const details = action()
    return {
      label,
      durationMs: Date.now() - startedAt,
      ok: true,
      details,
    }
  } catch (error) {
    return {
      label,
      durationMs: Date.now() - startedAt,
      ok: false,
      details: '(operation failed)',
      error: getErrorMessage(error),
    }
  }
}

function inspectPressureFile(path: string): PressureSnapshot {
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    return {
      path,
      some: null,
      full: null,
      error: `Pressure metrics not available on ${platform}`,
    }
  }
  if (!existsSync(path)) {
    return {
      path,
      some: null,
      full: null,
      error: 'Pressure file not available on this system',
    }
  }

  try {
    const raw = readFileSync(path, 'utf8').trim()
    const parseLine = (prefix: 'some' | 'full'): PressureMetrics | null => {
      const line = raw.split('\n').find((entry) => entry.startsWith(`${prefix} `))
      if (!line) return null
      const metrics = Object.fromEntries(
        line
          .split(/\s+/)
          .slice(1)
          .map((entry) => entry.split('=').slice(0, 2) as [string, string]),
      )

      return {
        avg10: parseInteger(metrics.avg10),
        avg60: parseInteger(metrics.avg60),
        avg300: parseInteger(metrics.avg300),
        total: parseInteger(metrics.total),
        raw: line,
      }
    }

    return {
      path,
      some: parseLine('some'),
      full: parseLine('full'),
    }
  } catch (error) {
    return {
      path,
      some: null,
      full: null,
      error: getErrorMessage(error),
    }
  }
}

function readProcessIo(pid: number): ProcessIoSnapshot {
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    return {
      pid,
      values: {},
      raw: '',
      error: `Process I/O counters not available on ${platform}`,
    }
  }
  const path = `/proc/${pid}/io`
  try {
    const raw = readFileSync(path, 'utf8').trim()
    const values = Object.fromEntries(
      raw
        .split('\n')
        .map((line) => line.split(':').map((part) => part.trim()))
        .filter((parts): parts is [string, string] => parts.length === 2)
        .map(([key, value]) => [key, Number(value)]),
    )

    return { pid, values, raw }
  } catch (error) {
    return {
      pid,
      values: {},
      raw: '',
      error: getErrorMessage(error),
    }
  }
}

function readGetconfNumber(name: string, fallback: number): number {
  const result = runProcess('getconf', [name], 2000)
  const parsed = Number(result.stdout.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

let cachedClockTicksPerSecond: number | null = null
let cachedPageSizeBytes: number | null = null

function getClockTicksPerSecond(): number {
  cachedClockTicksPerSecond ??= readGetconfNumber('CLK_TCK', 100)
  return cachedClockTicksPerSecond
}

function getPageSizeBytes(): number {
  cachedPageSizeBytes ??= readGetconfNumber('PAGESIZE', 4096)
  return cachedPageSizeBytes
}

function readOptionalProcText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return null
  }
}

function readFdCount(pid: number): number | null {
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') return null
  try {
    return readdirSync(`/proc/${pid}/fd`).length
  } catch {
    return null
  }
}

function readProcessCommand(pid: number, fallback: string | null): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`)
      .toString('utf8')
      .replace(/\0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (raw.length > 0) return formatBodyPreview(raw, 180)
  } catch {
    // Fall through to comm/stat fallback.
  }

  return fallback ? formatBodyPreview(fallback, 180) : null
}

function readProcessRuntimeSnapshot(pid: number): ProcessRuntimeSnapshot {
  const capturedAtMs = Date.now()
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    return {
      pid,
      command: null,
      state: null,
      wchan: null,
      cpuTicks: null,
      rssKb: null,
      numThreads: null,
      fdCount: null,
      readBytes: null,
      writeBytes: null,
      syscr: null,
      syscw: null,
      capturedAtMs,
      error: `Process runtime snapshots not available on ${platform}`,
    }
  }

  try {
    const rawStat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim()
    const commandStart = rawStat.indexOf('(')
    const commandEnd = rawStat.lastIndexOf(')')
    if (commandStart < 0 || commandEnd <= commandStart) {
      throw new Error('Unable to parse /proc stat command field')
    }

    const statCommand = rawStat.slice(commandStart + 1, commandEnd)
    const fields = rawStat.slice(commandEnd + 2).trim().split(/\s+/)
    const utimeTicks = parseInteger(fields[11])
    const stimeTicks = parseInteger(fields[12])
    const rssPages = parseInteger(fields[21])
    const io = readProcessIo(pid)
    const cpuTicks = utimeTicks !== null && stimeTicks !== null ? utimeTicks + stimeTicks : null

    return {
      pid,
      command: readProcessCommand(pid, statCommand),
      state: fields[0] ?? null,
      wchan: readOptionalProcText(`/proc/${pid}/wchan`),
      cpuTicks,
      rssKb: rssPages !== null ? Math.max(0, Math.round((rssPages * getPageSizeBytes()) / 1024)) : null,
      numThreads: parseInteger(fields[17]),
      fdCount: readFdCount(pid),
      readBytes: io.values.read_bytes ?? null,
      writeBytes: io.values.write_bytes ?? null,
      syscr: io.values.syscr ?? null,
      syscw: io.values.syscw ?? null,
      capturedAtMs,
      ...(io.error ? { error: `I/O counters unavailable: ${io.error}` } : {}),
    }
  } catch (error) {
    return {
      pid,
      command: null,
      state: null,
      wchan: null,
      cpuTicks: null,
      rssKb: null,
      numThreads: null,
      fdCount: null,
      readBytes: null,
      writeBytes: null,
      syscr: null,
      syscw: null,
      capturedAtMs,
      error: getErrorMessage(error),
    }
  }
}

function numberDelta(start: number | null, end: number | null): number | null {
  if (start === null || end === null) return null
  return end - start
}

function buildProcessActivitySample(
  label: string,
  pid: number | null,
  start: ProcessRuntimeSnapshot | null,
  end: ProcessRuntimeSnapshot | null,
  durationMs: number,
): ProcessActivitySample {
  if (pid === null) {
    return {
      label,
      pid,
      durationMs,
      cpuPercent: null,
      rssKb: null,
      numThreads: null,
      fdCount: null,
      fdCountDelta: null,
      readBytesDelta: null,
      writeBytesDelta: null,
      syscrDelta: null,
      syscwDelta: null,
      state: null,
      wchan: null,
      command: null,
      error: 'PID not available',
    }
  }

  if (!start || !end) {
    return {
      label,
      pid,
      durationMs,
      cpuPercent: null,
      rssKb: end?.rssKb ?? null,
      numThreads: end?.numThreads ?? null,
      fdCount: end?.fdCount ?? null,
      fdCountDelta: null,
      readBytesDelta: null,
      writeBytesDelta: null,
      syscrDelta: null,
      syscwDelta: null,
      state: end?.state ?? null,
      wchan: end?.wchan ?? null,
      command: end?.command ?? start?.command ?? null,
      error: end?.error ?? start?.error ?? 'Unable to sample process',
    }
  }

  const cpuTickDelta = numberDelta(start.cpuTicks, end.cpuTicks)
  const elapsedSeconds = durationMs / 1000
  const cpuPercent = cpuTickDelta !== null && elapsedSeconds > 0
    ? (cpuTickDelta / getClockTicksPerSecond() / elapsedSeconds) * 100
    : null

  return {
    label,
    pid,
    durationMs,
    cpuPercent,
    rssKb: end.rssKb,
    numThreads: end.numThreads,
    fdCount: end.fdCount,
    fdCountDelta: numberDelta(start.fdCount, end.fdCount),
    readBytesDelta: numberDelta(start.readBytes, end.readBytes),
    writeBytesDelta: numberDelta(start.writeBytes, end.writeBytes),
    syscrDelta: numberDelta(start.syscr, end.syscr),
    syscwDelta: numberDelta(start.syscw, end.syscw),
    state: end.state,
    wchan: end.wchan,
    command: end.command ?? start.command,
    error: end.error ?? start.error,
  }
}

async function sampleProcessActivities(
  targets: Array<{ label: string; pid: number | null }>,
  sampleMs: number,
): Promise<ProcessActivitySample[]> {
  const starts = new Map<number, ProcessRuntimeSnapshot>()
  for (const target of targets) {
    if (target.pid !== null) starts.set(target.pid, readProcessRuntimeSnapshot(target.pid))
  }

  const startedAtMs = Date.now()
  await sleep(sampleMs)
  const durationMs = Date.now() - startedAtMs

  const ends = new Map<number, ProcessRuntimeSnapshot>()
  for (const target of targets) {
    if (target.pid !== null) ends.set(target.pid, readProcessRuntimeSnapshot(target.pid))
  }

  return targets.map((target) => buildProcessActivitySample(
    target.label,
    target.pid,
    target.pid !== null ? starts.get(target.pid) ?? null : null,
    target.pid !== null ? ends.get(target.pid) ?? null : null,
    durationMs,
  ))
}

function listSystemRuntimeSnapshots(): ProcessRuntimeSnapshot[] {
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') return []
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry))
    .flatMap((entry) => {
      const pid = Number(entry)
      if (!Number.isInteger(pid) || pid <= 0) return []
      const snapshot = readProcessRuntimeSnapshot(pid)
      return snapshot.error && !snapshot.command ? [] : [snapshot]
    })
}

function toSystemProcessUsage(
  end: ProcessRuntimeSnapshot,
  start: ProcessRuntimeSnapshot | null,
  durationMs: number,
): SystemProcessUsage {
  const cpuTickDelta = start ? numberDelta(start.cpuTicks, end.cpuTicks) : null
  const elapsedSeconds = durationMs / 1000
  const cpuPercent = cpuTickDelta !== null && elapsedSeconds > 0
    ? (cpuTickDelta / getClockTicksPerSecond() / elapsedSeconds) * 100
    : null

  return {
    pid: end.pid,
    command: end.command ?? '(unknown)',
    cpuPercent,
    rssKb: end.rssKb,
    readBytesDelta: start ? numberDelta(start.readBytes, end.readBytes) : null,
    writeBytesDelta: start ? numberDelta(start.writeBytes, end.writeBytes) : null,
  }
}

async function sampleSystemProcessActivity(sampleMs: number): Promise<SystemProcessActivitySnapshot> {
  const startSnapshots = new Map(listSystemRuntimeSnapshots().map((snapshot) => [snapshot.pid, snapshot]))
  const startedAtMs = Date.now()
  await sleep(sampleMs)
  const durationMs = Date.now() - startedAtMs
  const endSnapshots = listSystemRuntimeSnapshots()
  return buildSystemProcessActivitySnapshot(startSnapshots, endSnapshots, durationMs)
}

function buildSystemProcessActivitySnapshot(
  startSnapshots: Map<number, ProcessRuntimeSnapshot>,
  endSnapshots: ProcessRuntimeSnapshot[],
  durationMs: number,
): SystemProcessActivitySnapshot {
  const usages = endSnapshots.map((snapshot) => toSystemProcessUsage(
    snapshot,
    startSnapshots.get(snapshot.pid) ?? null,
    durationMs,
  ))

  const byNumberDesc = <K extends keyof SystemProcessUsage>(key: K) =>
    [...usages]
      .filter((usage) => typeof usage[key] === 'number' && Number.isFinite(usage[key] as number))
      .sort((a, b) => ((b[key] as number | null) ?? -Infinity) - ((a[key] as number | null) ?? -Infinity))

  const byIoDeltaDesc = (key: 'readBytesDelta' | 'writeBytesDelta') =>
    byNumberDesc(key).filter((usage) => (usage[key] ?? 0) > 0)

  return {
    durationMs,
    processCount: endSnapshots.length,
    topCpu: byNumberDesc('cpuPercent').filter((usage) => (usage.cpuPercent ?? 0) > 0).slice(0, 10),
    topRss: byNumberDesc('rssKb').slice(0, 10),
    topReadBytes: byIoDeltaDesc('readBytesDelta').slice(0, 10),
    topWriteBytes: byIoDeltaDesc('writeBytesDelta').slice(0, 10),
  }
}

function readTrendFileSample(target: TrendFileTarget, previous?: TrendFileSample): TrendFileSample {
  try {
    const previousSize = previous?.sizeBytes
    if (!existsSync(target.path)) {
      return {
        label: target.label,
        path: target.path,
        exists: false,
        sizeBytes: null,
        sizeDeltaBytes: typeof previousSize === 'number' ? -previousSize : null,
        modifiedAt: null,
      }
    }

    const stats = statSync(target.path)
    return {
      label: target.label,
      path: target.path,
      exists: true,
      sizeBytes: stats.size,
      sizeDeltaBytes: typeof previousSize === 'number'
        ? stats.size - previousSize
        : previous && !previous.exists
          ? stats.size
          : null,
      modifiedAt: stats.mtime.toISOString(),
    }
  } catch (error) {
    return {
      label: target.label,
      path: target.path,
      exists: false,
      sizeBytes: null,
      sizeDeltaBytes: null,
      modifiedAt: null,
      error: getErrorMessage(error),
    }
  }
}

function readPressureTrendTotals(): PressureTrendTotals {
  const io = inspectPressureFile('/proc/pressure/io')
  const memory = inspectPressureFile('/proc/pressure/memory')
  const cpu = inspectPressureFile('/proc/pressure/cpu')

  return {
    ioSome: io.some?.total ?? null,
    ioFull: io.full?.total ?? null,
    memorySome: memory.some?.total ?? null,
    memoryFull: memory.full?.total ?? null,
    cpuSome: cpu.some?.total ?? null,
    cpuFull: cpu.full?.total ?? null,
  }
}

function buildPressureTrendDelta(start: PressureTrendTotals, end: PressureTrendTotals): PressureTrendDelta {
  return {
    ioSomeUs: numberDelta(start.ioSome, end.ioSome),
    ioFullUs: numberDelta(start.ioFull, end.ioFull),
    memorySomeUs: numberDelta(start.memorySome, end.memorySome),
    memoryFullUs: numberDelta(start.memoryFull, end.memoryFull),
    cpuSomeUs: numberDelta(start.cpuSome, end.cpuSome),
    cpuFullUs: numberDelta(start.cpuFull, end.cpuFull),
  }
}

function buildTrendFileTargets(
  appDbPath: string,
  projectSnapshots: ProjectSnapshot[],
  ticketRuntimeTarget: TicketRuntimeTarget | null,
): TrendFileTarget[] {
  const targets: TrendFileTarget[] = [
    { label: 'app db', path: appDbPath },
    { label: 'app db wal', path: `${appDbPath}-wal` },
    { label: 'app db shm', path: `${appDbPath}-shm` },
  ]

  for (const project of projectSnapshots) {
    targets.push({ label: `project ${project.id} db`, path: project.projectDbPath })
    targets.push({ label: `project ${project.id} db wal`, path: `${project.projectDbPath}-wal` })
    targets.push({ label: `project ${project.id} db shm`, path: `${project.projectDbPath}-shm` })
    if (project.latestNonTerminalTicketLog?.logPath) {
      targets.push({
        label: `project ${project.id} ${project.latestNonTerminalTicketLog.externalId} log`,
        path: project.latestNonTerminalTicketLog.logPath,
      })
    }
  }

  if (ticketRuntimeTarget) {
    for (const [label, path] of [
      ['focused ticket state', resolve(ticketRuntimeTarget.runtimePath, 'state.yaml')],
      ['focused ticket execution log', resolve(ticketRuntimeTarget.runtimePath, 'execution-log.jsonl')],
      ['focused ticket debug log', resolve(ticketRuntimeTarget.runtimePath, 'execution-log.debug.jsonl')],
      ['focused ticket ai log', resolve(ticketRuntimeTarget.runtimePath, 'execution-log.ai.jsonl')],
      ['focused ticket setup profile', resolve(ticketRuntimeTarget.runtimePath, 'execution-setup-profile.json')],
    ] as const) {
      targets.push({ label, path })
    }
  }

  const seen = new Set<string>()
  return targets.filter((target) => {
    if (seen.has(target.path)) return false
    seen.add(target.path)
    return true
  })
}

async function sampleRuntimeTrend(options: {
  durationMs: number
  intervalMs: number
  backendHealthUrl: string
  ticketsUrl: string
  probeTimeoutMs: number
  processTargets: Array<{ label: string; pid: number | null }>
  fileTargets: TrendFileTarget[]
}): Promise<RuntimeTrendReport> {
  const durationMs = Math.max(0, Math.floor(options.durationMs))
  if (durationMs <= 0) {
    return {
      enabled: false,
      durationMs,
      intervalMs: options.intervalMs,
      samples: [],
    }
  }

  const intervalMs = Math.max(250, Math.floor(options.intervalMs))
  const samples: RuntimeTrendSample[] = []
  const startedAtMs = Date.now()
  let previousCapturedAtMs = startedAtMs
  let previousProcesses = new Map<number, ProcessRuntimeSnapshot>()
  let previousSystemProcesses = new Map(listSystemRuntimeSnapshots().map((snapshot) => [snapshot.pid, snapshot]))
  let previousFiles = new Map<string, TrendFileSample>()
  let previousPressure = readPressureTrendTotals()

  for (const target of options.processTargets) {
    if (target.pid !== null) previousProcesses.set(target.pid, readProcessRuntimeSnapshot(target.pid))
  }
  for (const target of options.fileTargets) {
    previousFiles.set(target.path, readTrendFileSample(target))
  }

  const sampleCount = Math.max(1, Math.ceil(durationMs / intervalMs))

  for (let index = 1; index <= sampleCount; index += 1) {
    const scheduledAtMs = startedAtMs + index * intervalMs
    const waitMs = Math.max(0, Math.min(intervalMs, scheduledAtMs - Date.now()))
    if (waitMs > 0) await sleep(waitMs)

    const wokeAtMs = Date.now()
    const [health, tickets] = await Promise.all([
      probeHttp(`trend health ${index}`, options.backendHealthUrl, options.probeTimeoutMs),
      probeHttp(`trend tickets ${index}`, options.ticketsUrl, options.probeTimeoutMs),
    ])

    const endProcesses = new Map<number, ProcessRuntimeSnapshot>()
    for (const target of options.processTargets) {
      if (target.pid !== null) endProcesses.set(target.pid, readProcessRuntimeSnapshot(target.pid))
    }

    const endSystemProcesses = listSystemRuntimeSnapshots()
    const endPressure = readPressureTrendTotals()
    const capturedAtMs = Date.now()
    const actualIntervalMs = Math.max(1, capturedAtMs - previousCapturedAtMs)
    const fileSamples = options.fileTargets.map((target) => readTrendFileSample(target, previousFiles.get(target.path)))
    const processActivities = options.processTargets.map((target) => buildProcessActivitySample(
      target.label,
      target.pid,
      target.pid !== null ? previousProcesses.get(target.pid) ?? null : null,
      target.pid !== null ? endProcesses.get(target.pid) ?? null : null,
      actualIntervalMs,
    ))

    samples.push({
      index,
      at: new Date(capturedAtMs).toISOString(),
      elapsedMs: capturedAtMs - startedAtMs,
      intervalMs: actualIntervalMs,
      loopDriftMs: Math.max(0, wokeAtMs - scheduledAtMs),
      health,
      tickets,
      processActivities,
      systemActivity: buildSystemProcessActivitySnapshot(previousSystemProcesses, endSystemProcesses, actualIntervalMs),
      files: fileSamples,
      pressureDelta: buildPressureTrendDelta(previousPressure, endPressure),
    })

    previousCapturedAtMs = capturedAtMs
    previousProcesses = endProcesses
    previousSystemProcesses = new Map(endSystemProcesses.map((snapshot) => [snapshot.pid, snapshot]))
    previousPressure = endPressure
    previousFiles = new Map(fileSamples.map((sample) => [sample.path, sample]))
  }

  return {
    enabled: true,
    durationMs,
    intervalMs,
    samples,
  }
}

function listProcessRecords(): ProcessRecord[] {
  const platform = detectPlatform()
  if (platform === 'windows') {
    const result = runPowerShell(
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress',
      7000,
    )
    if (result.exitCode !== 0 || !result.stdout.trim()) return []

    return parseJsonRecords(result.stdout)
      .flatMap((entry): ProcessRecord[] => {
        const pid = parseInteger(String(entry.ProcessId ?? ''))
        if (!pid || pid <= 0) return []

        return [{
          pid,
          ppid: parseInteger(String(entry.ParentProcessId ?? '')),
          elapsed: null,
          pcpu: null,
          pmem: null,
          rssKb: null,
          args: String(entry.CommandLine ?? entry.Name ?? ''),
        }]
      })
  }

  const processCommand = platform === 'macos'
    ? 'ps -axo pid=,ppid=,etime=,pcpu=,pmem=,rss=,command='
    : 'ps -eo pid=,ppid=,etime=,pcpu=,pmem=,rss=,args= --sort=pid'
  const result = runShell(processCommand, 5000)
  if (result.exitCode !== 0 || !result.stdout.trim()) return []

  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/)
      if (!match) return []

      const [, pidRaw, ppidRaw, elapsedRaw, pcpuRaw, pmemRaw, rssRaw, argsRaw] = match
      const pid = Number(pidRaw)
      if (!Number.isInteger(pid) || pid <= 0) return []

      return [{
        pid,
        ppid: parseInteger(ppidRaw),
        elapsed: elapsedRaw || null,
        pcpu: parseInteger(pcpuRaw),
        pmem: parseInteger(pmemRaw),
        rssKb: parseInteger(rssRaw),
        args: argsRaw ?? '',
      }]
    })
}

function findFirstProcessMatch(processes: ProcessRecord[], patterns: RegExp[]): ProcessRecord | null {
  for (const pattern of patterns) {
    const match = processes.find((process) => pattern.test(process.args.replace(/\\/g, '/')))
    if (match) return match
  }

  return null
}

function readProcessMemorySnapshot(pid: number): ProcessMemorySnapshot {
  const platform = detectPlatform()
  if (platform === 'windows') {
    const result = runPowerShell(`Get-Process -Id ${pid} | Select-Object Name, CPU, WorkingSet64, PeakWorkingSet64, VirtualMemorySize64 | ConvertTo-Json`, 3000)
    try {
      const data = JSON.parse(result.stdout)
      return {
        pid,
        name: data.Name ?? null,
        state: null,
        vmRssKb: data.WorkingSet64 ? Math.round(data.WorkingSet64 / 1024) : null,
        vmHwmKb: data.PeakWorkingSet64 ? Math.round(data.PeakWorkingSet64 / 1024) : null,
        vmSizeKb: data.VirtualMemorySize64 ? Math.round(data.VirtualMemorySize64 / 1024) : null,
        vmPeakKb: null,
        threads: null,
        fdSize: null,
        voluntaryCtxtSwitches: null,
        nonvoluntaryCtxtSwitches: null,
        oomScore: null,
        oomScoreAdj: null,
      }
    } catch {
      return { pid, name: null, state: null, vmRssKb: null, vmHwmKb: null, vmSizeKb: null, vmPeakKb: null, threads: null, fdSize: null, voluntaryCtxtSwitches: null, nonvoluntaryCtxtSwitches: null, oomScore: null, oomScoreAdj: null, error: 'Failed to parse PowerShell output' }
    }
  }

  if (platform !== 'linux' && platform !== 'wsl') {
    return {
      pid,
      name: null,
      state: null,
      vmRssKb: null,
      vmHwmKb: null,
      vmSizeKb: null,
      vmPeakKb: null,
      threads: null,
      fdSize: null,
      voluntaryCtxtSwitches: null,
      nonvoluntaryCtxtSwitches: null,
      oomScore: null,
      oomScoreAdj: null,
      error: `Process memory snapshots not available on ${platform}`,
    }
  }
  const statusPath = `/proc/${pid}/status`

  try {
    const raw = readFileSync(statusPath, 'utf8')
    const values = Object.fromEntries(
      raw
        .split('\n')
        .map((line) => {
          const separator = line.indexOf(':')
          if (separator <= 0) return ['', '']
          return [line.slice(0, separator), line.slice(separator + 1).trim()]
        })
        .filter(([key]) => (key ?? '').length > 0),
    ) as Record<string, string>

    const readProcNumber = (path: string): number | null => {
      try {
        return parseInteger(readFileSync(path, 'utf8').trim())
      } catch {
        return null
      }
    }

    return {
      pid,
      name: values.Name ?? null,
      state: values.State ?? null,
      vmRssKb: parseInteger(values.VmRSS?.split(/\s+/)[0]),
      vmHwmKb: parseInteger(values.VmHWM?.split(/\s+/)[0]),
      vmSizeKb: parseInteger(values.VmSize?.split(/\s+/)[0]),
      vmPeakKb: parseInteger(values.VmPeak?.split(/\s+/)[0]),
      threads: parseInteger(values.Threads),
      fdSize: parseInteger(values.FDSize),
      voluntaryCtxtSwitches: parseInteger(values.voluntary_ctxt_switches),
      nonvoluntaryCtxtSwitches: parseInteger(values.nonvoluntary_ctxt_switches),
      oomScore: readProcNumber(`/proc/${pid}/oom_score`),
      oomScoreAdj: readProcNumber(`/proc/${pid}/oom_score_adj`),
    }
  } catch (error) {
    return {
      pid,
      name: null,
      state: null,
      vmRssKb: null,
      vmHwmKb: null,
      vmSizeKb: null,
      vmPeakKb: null,
      threads: null,
      fdSize: null,
      voluntaryCtxtSwitches: null,
      nonvoluntaryCtxtSwitches: null,
      oomScore: null,
      oomScoreAdj: null,
      error: getErrorMessage(error),
    }
  }
}

function parseLocalPortFromUrl(rawUrl: string): number | null {
  try {
    const url = new URL(rawUrl)
    if (!['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(url.hostname)) return null
    const defaultPort = url.protocol === 'https:' ? 443 : 80
    return Number(url.port || defaultPort)
  } catch {
    return null
  }
}

function sleep(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function measureEventLoopLag(): Promise<number> {
  const start = Date.now()
  await new Promise<void>((resolve) => setImmediate(resolve))
  return Date.now() - start
}

async function probeDns(hostname: string): Promise<DnsProbeResult> {
  const start = Date.now()
  try {
    const result = await dnsPromises.lookup(hostname, { all: true })
    const addresses = result.map((record) => record.address)
    return {
      hostname,
      ok: true,
      durationMs: Date.now() - start,
      addresses,
    }
  } catch (error) {
    return {
      hostname,
      ok: false,
      durationMs: Date.now() - start,
      addresses: [],
      error: getErrorMessage(error),
    }
  }
}

function readFdLimits(): FdLimits {
  const platform = detectPlatform()
  if (platform === 'windows') {
    return { soft: null, hard: null, error: 'FD limits not applicable on Windows' }
  }
  try {
    const softResult = runShell('ulimit -Sn', 2000)
    const hardResult = runShell('ulimit -Hn', 2000)
    const soft = parseInteger(softResult.stdout.trim())
    const hard = parseInteger(hardResult.stdout.trim())
    return { soft, hard }
  } catch (error) {
    return { soft: null, hard: null, error: getErrorMessage(error) }
  }
}

function readTcpStats(): TcpStats {
  const platform = detectPlatform()
  try {
    if (platform === 'linux' || platform === 'wsl') {
      const result = runShell('ss -tn 2>/dev/null | tail -n +2', 3000)
      if (result.exitCode !== 0 || result.error) return { established: 0, timeWait: 0, closeWait: 0, listen: 0, error: result.stderr || result.error }
      const lines = result.stdout.split('\n').filter(Boolean)
      const count = (state: string) => lines.filter((l) => l.startsWith(state)).length
      const listenResult = runShell('ss -tln 2>/dev/null | tail -n +2 | wc -l', 2000)
      return {
        established: count('ESTAB'),
        timeWait: count('TIME-WAIT'),
        closeWait: count('CLOSE-WAIT'),
        listen: parseInteger(listenResult.stdout.trim()) ?? 0,
      }
    }
    if (platform === 'macos') {
      const result = runShell('netstat -an -p tcp 2>/dev/null', 3000)
      if (result.exitCode !== 0) return { established: 0, timeWait: 0, closeWait: 0, listen: 0, error: result.stderr }
      const lines = result.stdout.split('\n').filter((l) => l.startsWith('tcp'))
      const count = (state: string) => lines.filter((l) => l.includes(state)).length
      return {
        established: count('ESTABLISHED'),
        timeWait: count('TIME_WAIT'),
        closeWait: count('CLOSE_WAIT'),
        listen: count('LISTEN'),
      }
    }
    if (platform === 'windows') {
      const result = runShell('netstat -ano', 3000)
      if (result.exitCode !== 0) return { established: 0, timeWait: 0, closeWait: 0, listen: 0, error: result.stderr }
      const lines = result.stdout.split('\n').filter((l) => l.includes('TCP'))
      const count = (state: string) => lines.filter((l) => l.includes(state)).length
      return {
        established: count('ESTABLISHED'),
        timeWait: count('TIME_WAIT'),
        closeWait: count('CLOSE_WAIT'),
        listen: count('LISTENING'),
      }
    }
    return { established: 0, timeWait: 0, closeWait: 0, listen: 0, error: 'Platform not supported' }
  } catch (error) {
    return { established: 0, timeWait: 0, closeWait: 0, listen: 0, error: getErrorMessage(error) }
  }
}

function countZombieProcesses(): number {
  const platform = detectPlatform()
  try {
    if (platform === 'linux' || platform === 'wsl') {
      const entries = readdirSync('/proc').filter((entry) => /^\d+$/.test(entry))
      let count = 0
      for (const entry of entries) {
        try {
          const status = readFileSync(`/proc/${entry}/status`, 'utf8')
          if (/^State:\s+Z/m.test(status)) count += 1
        } catch { /* ignore */ }
      }
      return count
    }
    if (platform === 'macos') {
      const result = runShell("ps aux | awk '$8 == \"Z\"' | wc -l", 3000)
      return parseInteger(result.stdout.trim()) ?? 0
    }
    return 0
  } catch {
    return 0
  }
}

function readDiagnosticProcessHeap(): DiagnosticHeap {
  const mem = process.memoryUsage()
  return {
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024 * 10) / 10,
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024 * 10) / 10,
    externalMb: Math.round(mem.external / 1024 / 1024 * 10) / 10,
    rssMb: Math.round(mem.rss / 1024 / 1024 * 10) / 10,
  }
}

function readSwapSnapshot(): SwapSnapshot {
  const platform = detectPlatform()
  if (platform === 'macos' || platform === 'windows') {
    return { totalKb: null, freeKb: null, usedKb: null, usePercent: null, error: `Swap metrics not available via /proc on ${platform}` }
  }
  try {
    const raw = readOptionalProcText('/proc/meminfo')
    if (!raw) return { totalKb: null, freeKb: null, usedKb: null, usePercent: null, error: '/proc/meminfo not available' }
    const parse = (key: string): number | null => {
      const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))
      return match?.[1] != null ? parseInt(match[1], 10) : null
    }
    const totalKb = parse('SwapTotal')
    const freeKb = parse('SwapFree')
    const usedKb = totalKb !== null && freeKb !== null ? totalKb - freeKb : null
    const usePercent = totalKb && totalKb > 0 && usedKb !== null ? Math.round(usedKb / totalKb * 100 * 10) / 10 : null
    return { totalKb, freeKb, usedKb, usePercent }
  } catch (error) {
    return { totalKb: null, freeKb: null, usedKb: null, usePercent: null, error: getErrorMessage(error) }
  }
}

function collectMacosSystemMetrics(): MacosSystemMetrics {
  const platform = detectPlatform()
  if (platform !== 'macos') {
    return { vmStatRaw: null, loadAvg: null, cpuCount: null, topProcessesRaw: null, error: 'Only available on macOS' }
  }
  const vmStat = runShell('vm_stat', 3000)
  const loadAvg = runShell('sysctl -n vm.loadavg', 2000)
  const cpuCountResult = runShell('sysctl -n hw.ncpu', 2000)
  const topResult = runShell("top -l 1 -n 10 -stats pid,command,cpu,rsize 2>/dev/null | tail -n +13", 5000)
  return {
    vmStatRaw: vmStat.exitCode === 0 ? vmStat.stdout.trim() : null,
    loadAvg: loadAvg.exitCode === 0 ? loadAvg.stdout.trim() : null,
    cpuCount: parseInteger(cpuCountResult.stdout.trim()),
    topProcessesRaw: topResult.exitCode === 0 ? topResult.stdout.trim() : null,
    error: [vmStat, loadAvg, cpuCountResult].some((r) => r.exitCode !== 0) ? 'Some macOS metrics failed' : undefined,
  }
}

async function sampleRepeatedBackendProbes(options: {
  backendPid: number | null
  backendHealthUrl: string
  ticketsUrl: string
  iterations?: number
  intervalMs?: number
  probeTimeoutMs?: number
}): Promise<RepeatedProbeSample[]> {
  const samples: RepeatedProbeSample[] = []
  const iterations = options.iterations ?? 5
  const intervalMs = options.intervalMs ?? 700
  const probeTimeoutMs = options.probeTimeoutMs ?? 900

  for (let index = 0; index < iterations; index += 1) {
    const [healthProbe, ticketsProbe] = await Promise.all([
      probeHttp(`repeated health ${index + 1}`, options.backendHealthUrl, probeTimeoutMs),
      probeHttp(`repeated tickets ${index + 1}`, options.ticketsUrl, probeTimeoutMs),
    ])

    let processStat: string | null = null
    let processWchan: string | null = null

    if (options.backendPid && detectPlatform() !== 'windows' && commandExists('ps')) {
      const processSnapshot = runShell(
        `ps -p ${options.backendPid} -o stat=,wchan=`,
        Math.max(1500, probeTimeoutMs),
      )

      const raw = processSnapshot.stdout.trim()
      if (raw) {
        const parts = raw.split(/\s+/)
        processStat = parts[0] ?? null
        processWchan = parts.slice(1).join(' ') || null
      }
    }

    samples.push({
      at: new Date().toISOString(),
      healthOk: healthProbe.ok,
      healthStatus: healthProbe.status,
      healthDurationMs: healthProbe.durationMs,
      ...(healthProbe.error ? { healthError: healthProbe.error } : {}),
      ticketsOk: ticketsProbe.ok,
      ticketsStatus: ticketsProbe.status,
      ticketsDurationMs: ticketsProbe.durationMs,
      ...(ticketsProbe.error ? { ticketsError: ticketsProbe.error } : {}),
      processStat,
      processWchan,
    })

    if (index < iterations - 1) {
      await sleep(intervalMs)
    }
  }

  return samples
}

function resolveAppConfigDir(env: Record<string, string>): string {
  const configured = env.LOOPTROOP_CONFIG_DIR?.trim()
  if (configured) {
    return resolvePortablePath(configured)
  }

  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim()
    const baseDir = appData
      ? resolvePortablePath(appData)
      : resolve(env.USERPROFILE?.trim() || homedir(), 'AppData', 'Roaming')
    return resolve(baseDir, 'looptroop')
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim()
  const baseDir = xdgConfigHome
    ? resolvePortablePath(xdgConfigHome)
    : resolve(env.HOME?.trim() || homedir(), '.config')

  return resolve(baseDir, 'looptroop')
}

function resolveAppDbPath(env: Record<string, string>): string {
  const configured = env.LOOPTROOP_APP_DB_PATH?.trim()
  if (configured) {
    return resolvePortablePath(configured)
  }

  return resolve(resolveAppConfigDir(env), 'app.sqlite')
}

function findAncestorNamed(startPath: string, targetName: string): string | null {
  let current = startPath

  for (let depth = 0; depth < 64; depth += 1) {
    if (basename(current) === targetName) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }

  return null
}

function resolveTicketRuntimeTarget(inputPath: string): TicketRuntimeTarget {
  const resolvedInputPath = resolvePortablePath(inputPath)
  const notes: string[] = []
  const resolutionNote = describePortablePathResolution(inputPath, resolvedInputPath)
  if (resolutionNote) notes.push(resolutionNote)

  const ticketAncestor = findAncestorNamed(resolvedInputPath, '.ticket')
  const ticketRootPath = ticketAncestor
    ?? (existsSync(resolve(resolvedInputPath, '.ticket')) ? resolve(resolvedInputPath, '.ticket') : resolvedInputPath)
  const runtimePath = basename(ticketRootPath) === 'runtime'
    ? ticketRootPath
    : resolve(ticketRootPath, 'runtime')
  const worktreePath = basename(ticketRootPath) === '.ticket' ? dirname(ticketRootPath) : null
  const ticketId = worktreePath ? basename(worktreePath) : null

  if (!existsSync(ticketRootPath)) {
    notes.push('Resolved ticket root path does not exist.')
  }
  if (!existsSync(runtimePath)) {
    notes.push('Resolved ticket runtime path does not exist.')
  }
  if (basename(ticketRootPath) !== '.ticket') {
    notes.push('Input did not resolve to a .ticket directory; runtime checks use the resolved path as the ticket root.')
  }

  return {
    inputPath,
    resolvedInputPath,
    ticketRootPath,
    runtimePath,
    worktreePath,
    ticketId,
    notes,
  }
}

function collectTicketRuntimeTopDirectories(runtimePath: string): CommandResult {
  if (!existsSync(runtimePath)) {
    return skippedCommandResult('ticket runtime directory scan', 'Runtime path does not exist.')
  }

  const platform = detectPlatform()
  const runtimeArg = commandShellQuote(runtimePath)

  if (platform === 'windows') {
    return skippedCommandResult(
      'ticket runtime top directories',
      'Top directory sizing is skipped on Windows because recursive per-directory measurement is too expensive for this diagnostic.',
    )
  }

  const command = platform === 'macos'
    ? `du -k -d 3 ${runtimeArg} 2>/dev/null | sort -nr | head -n 30`
    : `du -k --max-depth=3 ${runtimeArg} 2>/dev/null | sort -nr | head -n 30`

  return runShell(command, 20000)
}

function collectTicketRuntimeLargestFiles(runtimePath: string): CommandResult {
  if (!existsSync(runtimePath)) {
    return skippedCommandResult('ticket runtime largest files', 'Runtime path does not exist.')
  }

  const platform = detectPlatform()
  const runtimeArg = commandShellQuote(runtimePath)

  if (platform === 'windows') {
    return runPowerShell(
      [
        `$root = ${powerShellQuote(runtimePath)}`,
        'Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue',
        '  | Where-Object { $_.Length -ge 104857600 }',
        '  | Sort-Object Length -Descending',
        '  | Select-Object -First 30 @{Name="Bytes";Expression={$_.Length}}, FullName',
        '  | Format-Table -AutoSize | Out-String',
      ].join(' '),
      20000,
    )
  }

  const command = platform === 'macos'
    ? `find ${runtimeArg} -type f -size +100M -exec stat -f '%z %N' {} + 2>/dev/null | sort -nr | head -n 30`
    : `find ${runtimeArg} -type f -size +100M -printf '%s %p\\n' 2>/dev/null | sort -nr | head -n 30`

  return runShell(command, 20000)
}

function openReadonlyDatabase(path: string): Database.Database {
  return new Database(path, {
    readonly: true,
    fileMustExist: true,
  })
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
  ).get(tableName) as { name?: string } | undefined

  return row?.name === tableName
}

function inspectAppDatabase(appDbPath: string): {
  exists: boolean
  attachedProjects: AttachedProjectRow[]
  openMs: number
  queryMs: number
  error?: string
} {
  if (!existsSync(appDbPath)) {
    return { exists: false, attachedProjects: [], openMs: 0, queryMs: 0 }
  }

  let db: Database.Database | null = null
  const openStartedAt = Date.now()

  try {
    db = openReadonlyDatabase(appDbPath)
    const openMs = Date.now() - openStartedAt
    const queryStartedAt = Date.now()
    const attachedProjects = tableExists(db, 'attached_projects')
      ? db.prepare(
        `SELECT id, folder_path AS folderPath, created_at AS createdAt, updated_at AS updatedAt
         FROM attached_projects
         ORDER BY id`,
      ).all() as AttachedProjectRow[]
      : []
    const queryMs = Date.now() - queryStartedAt
    return { exists: true, attachedProjects, openMs, queryMs }
  } catch (error) {
    return {
      exists: true,
      attachedProjects: [],
      openMs: Date.now() - openStartedAt,
      queryMs: 0,
      error: getErrorMessage(error),
    }
  } finally {
    db?.close()
  }
}

function inspectTicketMetaFiles(projectRoot: string, ticketRefs: string[]): {
  checked: number
  missingMetaFiles: number
  metaWithoutBaseBranch: number
  details: string[]
} {
  const details: string[] = []
  let checked = 0
  let missingMetaFiles = 0
  let metaWithoutBaseBranch = 0

  for (const externalId of ticketRefs) {
    checked += 1
    const metaPath = resolve(projectRoot, '.looptroop', 'worktrees', externalId, '.ticket', 'meta', 'ticket.meta.json')
    if (!existsSync(metaPath)) {
      missingMetaFiles += 1
      if (details.length < 8) details.push(`${externalId}: missing ${metaPath}`)
      continue
    }

    try {
      const parsed = JSON.parse(readFileSync(metaPath, 'utf8')) as { baseBranch?: unknown }
      if (typeof parsed.baseBranch !== 'string' || parsed.baseBranch.trim().length === 0) {
        metaWithoutBaseBranch += 1
        if (details.length < 8) details.push(`${externalId}: meta present but baseBranch missing or empty`)
      }
    } catch (error) {
      metaWithoutBaseBranch += 1
      if (details.length < 8) {
        const message = getErrorMessage(error)
        details.push(`${externalId}: failed to parse meta file (${message})`)
      }
    }
  }

  return { checked, missingMetaFiles, metaWithoutBaseBranch, details }
}

function formatExecutionLogTailLine(rawLine: string): string {
  try {
    const parsed = JSON.parse(rawLine) as {
      timestamp?: unknown
      phase?: unknown
      type?: unknown
      message?: unknown
      content?: unknown
    }
    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : 'n/a'
    const phase = typeof parsed.phase === 'string' ? parsed.phase : 'n/a'
    const type = typeof parsed.type === 'string' ? parsed.type : 'n/a'
    const messageSource = typeof parsed.message === 'string'
      ? parsed.message
      : typeof parsed.content === 'string'
        ? parsed.content
        : rawLine
    return `${timestamp} | ${phase} | ${type} | ${formatBodyPreview(messageSource, 220)}`
  } catch {
    return formatBodyPreview(rawLine, 260)
  }
}

function readTicketExecutionLogPreview(
  projectRoot: string,
  ticket: TicketRow,
  maxLines = 8,
): TicketLogPreview {
  const logPath = resolve(projectRoot, '.looptroop', 'worktrees', ticket.external_id, '.ticket', 'runtime', 'execution-log.jsonl')
  if (!existsSync(logPath)) {
    return {
      externalId: ticket.external_id,
      status: ticket.status,
      logPath,
      exists: false,
      tailLines: [],
      detail: 'Execution log file is missing.',
    }
  }

  try {
    const raw = readFileSync(logPath, 'utf8')
    const tailLines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .slice(-maxLines)
      .map(formatExecutionLogTailLine)

    return {
      externalId: ticket.external_id,
      status: ticket.status,
      logPath,
      exists: true,
      tailLines,
      ...(tailLines.length === 0 ? { detail: 'Execution log file exists but contains no entries.' } : {}),
    }
  } catch (error) {
    return {
      externalId: ticket.external_id,
      status: ticket.status,
      logPath,
      exists: true,
      tailLines: [],
      detail: getErrorMessage(error),
    }
  }
}

function inspectProjectDatabase(project: AttachedProjectRow): ProjectSnapshot {
  const projectRoot = resolvePortablePath(project.folderPath)
  const projectDbPath = resolve(projectRoot, '.looptroop', 'db.sqlite')
  const exists = existsSync(projectRoot)
  const projectDbExists = existsSync(projectDbPath)
  const pathCheckDetails: string[] = []
  const mount = inspectMount(projectRoot)
  const diskUsage = inspectDiskUsage(projectRoot)
  const inodeUsage = inspectInodeUsage(projectRoot)
  const latencyProbes: FsLatencyProbe[] = []
  const pathResolutionDetail = describePortablePathResolution(project.folderPath, projectRoot)

  if (pathResolutionDetail) {
    pathCheckDetails.push(pathResolutionDetail)
  }
  if (!exists) {
    pathCheckDetails.push('Project root path does not exist right now.')
  }
  if (!projectDbExists) {
    pathCheckDetails.push('Project DB file does not exist at .looptroop/db.sqlite.')
  }

  if (!projectDbExists) {
    return {
      id: project.id,
      folderPath: project.folderPath,
      resolvedFolderPath: projectRoot,
      exists,
      projectDbPath,
      projectDbExists,
      projectName: null,
      shortname: null,
      ticketCounter: null,
      ticketCount: 0,
      activeSessionCount: 0,
      recentTickets: [],
      latestNonTerminalTicketLog: null,
      activeSessions: [],
      statusCounts: [],
      metaFilesChecked: 0,
      missingMetaFiles: 0,
      metaWithoutBaseBranch: 0,
      metaCheckDetails: [],
      pathCheckDetails,
      dbOpenMs: 0,
      dbQueryMs: 0,
      mount,
      diskUsage,
      inodeUsage,
      latencyProbes,
    }
  }

  let db: Database.Database | null = null
  const dbOpenStartedAt = Date.now()

  try {
    db = openReadonlyDatabase(projectDbPath)
    const dbOpenMs = Date.now() - dbOpenStartedAt
    const queryStartedAt = Date.now()

    const projectRow = tableExists(db, 'projects')
      ? db.prepare(
        `SELECT name, shortname, ticket_counter AS ticketCounter FROM projects LIMIT 1`,
      ).get() as { name?: string | null; shortname?: string | null; ticketCounter?: number | null } | undefined
      : undefined

    const ticketCount = tableExists(db, 'tickets')
      ? (db.prepare(`SELECT COUNT(*) AS count FROM tickets`).get() as { count: number }).count
      : 0

    const recentTickets = tableExists(db, 'tickets')
      ? db.prepare(
        `SELECT external_id, status, updated_at
         FROM tickets
         ORDER BY updated_at DESC
         LIMIT 8`,
      ).all() as TicketRow[]
      : []

    const latestNonTerminalTicket = tableExists(db, 'tickets')
      ? db.prepare(
        `SELECT external_id, status, updated_at
         FROM tickets
         WHERE status NOT IN ('COMPLETED', 'CANCELED')
         ORDER BY updated_at DESC
         LIMIT 1`,
      ).get() as TicketRow | undefined
      : undefined

    const statusCounts = tableExists(db, 'tickets')
      ? db.prepare(
        `SELECT status, COUNT(*) AS count
         FROM tickets
         GROUP BY status
         ORDER BY count DESC, status ASC`,
      ).all() as Array<{ status: string; count: number }>
      : []

    const activeSessions = tableExists(db, 'opencode_sessions')
      ? db.prepare(
        `SELECT session_id, ticket_id, phase, member_id, step, updated_at
         FROM opencode_sessions
         WHERE state = 'active'
         ORDER BY updated_at DESC
         LIMIT 8`,
      ).all() as ActiveSessionRow[]
      : []

    const ticketRefs = tableExists(db, 'tickets')
      ? db.prepare(`SELECT external_id FROM tickets ORDER BY updated_at DESC`).all() as Array<{ external_id: string }>
      : []

    const metaInspection = inspectTicketMetaFiles(
      projectRoot,
      ticketRefs.map((ticket) => ticket.external_id),
    )
    const latestNonTerminalTicketLog = latestNonTerminalTicket
      ? readTicketExecutionLogPreview(projectRoot, latestNonTerminalTicket)
      : null

    const latestExternalId = recentTickets[0]?.external_id ?? ticketRefs[0]?.external_id ?? null
    const gitHeadPath = resolve(projectRoot, '.git', 'HEAD')
    const worktreesPath = resolve(projectRoot, '.looptroop', 'worktrees')
    const latestMetaPath = latestExternalId
      ? resolve(projectRoot, '.looptroop', 'worktrees', latestExternalId, '.ticket', 'meta', 'ticket.meta.json')
      : null

    latencyProbes.push(
      measureFsLatency('stat project root', () => {
        const stats = statSync(projectRoot)
        return `mode=${stats.mode} size=${stats.size} mtime=${stats.mtime.toISOString()}`
      }),
    )

    latencyProbes.push(
      measureFsLatency('stat project db', () => {
        const stats = statSync(projectDbPath)
        return `size=${stats.size} mtime=${stats.mtime.toISOString()}`
      }),
    )

    latencyProbes.push(
      measureFsLatency('read .git/HEAD', () => formatBodyPreview(readFileSync(gitHeadPath, 'utf8'), 120)),
    )

    latencyProbes.push(
      measureFsLatency('list .looptroop/worktrees', () => {
        const entries = readdirSync(worktreesPath)
        return `entries=${entries.length} sample=${entries.slice(0, 5).join(', ') || '(none)'}`
      }),
    )

    if (latestMetaPath) {
      latencyProbes.push(
        measureFsLatency(`read latest ticket meta (${latestExternalId})`, () => {
          return formatBodyPreview(readFileSync(latestMetaPath, 'utf8'), 200)
        }),
      )
    }

    const dbQueryMs = Date.now() - queryStartedAt

    return {
      id: project.id,
      folderPath: project.folderPath,
      resolvedFolderPath: projectRoot,
      exists,
      projectDbPath,
      projectDbExists,
      projectName: projectRow?.name ?? null,
      shortname: projectRow?.shortname ?? null,
      ticketCounter: projectRow?.ticketCounter ?? null,
      ticketCount,
      activeSessionCount: activeSessions.length,
      recentTickets,
      latestNonTerminalTicketLog,
      activeSessions,
      statusCounts,
      metaFilesChecked: metaInspection.checked,
      missingMetaFiles: metaInspection.missingMetaFiles,
      metaWithoutBaseBranch: metaInspection.metaWithoutBaseBranch,
      metaCheckDetails: metaInspection.details,
      pathCheckDetails,
      dbOpenMs,
      dbQueryMs,
      mount,
      diskUsage,
      inodeUsage,
      latencyProbes,
    }
  } finally {
    db?.close()
  }
}

function printFileStats(title: string, filePath: string) {
  heading(title)
  kv('Path', filePath)
  kv('Exists', existsSync(filePath))
  if (!existsSync(filePath)) return

  try {
    const stats = statSync(filePath)
    kv('Size bytes', stats.size)
    kv('Modified at', stats.mtime.toISOString())
  } catch (error) {
    const message = getErrorMessage(error)
    kv('Stat error', message)
  }
}

function printTicketRuntimeSnapshot(target: TicketRuntimeTarget) {
  heading('Focused Ticket Runtime')
  kv('Input path', target.inputPath)
  kv('Resolved input path', target.resolvedInputPath)
  kv('Ticket id', target.ticketId ?? 'n/a')
  kv('Worktree path', target.worktreePath ?? 'n/a')
  kv('Ticket root path', target.ticketRootPath)
  kv('Runtime path', target.runtimePath)
  kv('Ticket root exists', existsSync(target.ticketRootPath))
  kv('Runtime path exists', existsSync(target.runtimePath))
  if (target.notes.length > 0) {
    print('Notes:')
    for (const note of target.notes) {
      print(`- ${note}`)
    }
  }

  printMountSnapshot('Focused Ticket Runtime Mount Snapshot', inspectMount(target.runtimePath))
  printDiskUsageSnapshot('Focused Ticket Runtime Disk Usage', inspectDiskUsage(target.runtimePath))
  printInodeUsageSnapshot('Focused Ticket Runtime Inode Usage', inspectInodeUsage(target.runtimePath))
  printFileStats('Focused Ticket State File Stats', resolve(target.runtimePath, 'state.yaml'))
  printFileStats('Focused Ticket Execution Log Stats', resolve(target.runtimePath, 'execution-log.jsonl'))
  printFileStats('Focused Ticket Debug Log Stats', resolve(target.runtimePath, 'execution-log.debug.jsonl'))
  printFileStats('Focused Ticket AI Log Stats', resolve(target.runtimePath, 'execution-log.ai.jsonl'))
  printFileStats('Focused Ticket Setup Profile Stats', resolve(target.runtimePath, 'execution-setup-profile.json'))
  printFileStats('Focused Ticket Execution Setup Directory Stats', resolve(target.runtimePath, 'execution-setup'))
  printCommandResult('Focused Ticket Runtime Top Directories by KiB', collectTicketRuntimeTopDirectories(target.runtimePath))
  printCommandResult('Focused Ticket Runtime Largest Files >= 100 MiB', collectTicketRuntimeLargestFiles(target.runtimePath))
}

function printHttpProbe(result: HttpProbeResult) {
  heading(`HTTP Probe: ${result.label}`)
  kv('URL', result.url)
  kv('Duration', formatDuration(result.durationMs))
  kv('Success', result.ok)
  kv('Status', result.status)
  if (result.error) kv('Error', result.error)
  kv('Body preview', result.bodyPreview)
}

function printMountSnapshot(title: string, snapshot: MountSnapshot) {
  heading(title)
  kv('Path', snapshot.path)
  kv('Target', snapshot.target)
  kv('Source', snapshot.source)
  kv('Filesystem type', snapshot.fstype)
  kv('Options', snapshot.options)
  if (snapshot.error) kv('Error', snapshot.error)
}

function printDiskUsageSnapshot(title: string, snapshot: DiskUsageSnapshot) {
  heading(title)
  kv('Path', snapshot.path)
  kv('Filesystem', snapshot.filesystem)
  kv('Total KB', snapshot.totalKb)
  kv('Used KB', snapshot.usedKb)
  kv('Available KB', snapshot.availableKb)
  kv('Use %', snapshot.usePercent)
  kv('Mounted on', snapshot.mountedOn)
  if (snapshot.error) kv('Error', snapshot.error)
}

function printInodeUsageSnapshot(title: string, snapshot: InodeUsageSnapshot) {
  heading(title)
  kv('Path', snapshot.path)
  kv('Filesystem', snapshot.filesystem)
  kv('Total inodes', snapshot.totalInodes)
  kv('Used inodes', snapshot.usedInodes)
  kv('Free inodes', snapshot.freeInodes)
  kv('Use %', snapshot.usePercent)
  kv('Mounted on', snapshot.mountedOn)
  if (snapshot.error) kv('Error', snapshot.error)
}

function printLatencyProbes(title: string, probes: FsLatencyProbe[]) {
  heading(title)
  if (probes.length === 0) {
    print('(none)')
    return
  }

  for (const probe of probes) {
    print(`- ${probe.label}: ok=${probe.ok} duration=${formatDuration(probe.durationMs)} details=${probe.details}`)
    if (probe.error) {
      print(`  error=${probe.error}`)
    }
  }
}

function printPressureSnapshot(title: string, snapshot: PressureSnapshot) {
  heading(title)
  kv('Path', snapshot.path)
  if (snapshot.error) {
    kv('Error', snapshot.error)
    return
  }

  if (!snapshot.some && !snapshot.full) {
    print('(no pressure metrics reported)')
    return
  }

  if (snapshot.some) {
    kv('some.avg10', snapshot.some.avg10)
    kv('some.avg60', snapshot.some.avg60)
    kv('some.avg300', snapshot.some.avg300)
    kv('some.total', snapshot.some.total)
    kv('some.raw', snapshot.some.raw)
  }

  if (snapshot.full) {
    kv('full.avg10', snapshot.full.avg10)
    kv('full.avg60', snapshot.full.avg60)
    kv('full.avg300', snapshot.full.avg300)
    kv('full.total', snapshot.full.total)
    kv('full.raw', snapshot.full.raw)
  }
}

function printProcessIoSnapshot(title: string, snapshot: ProcessIoSnapshot) {
  heading(title)
  kv('PID', snapshot.pid)
  if (snapshot.error) {
    kv('Error', snapshot.error)
    return
  }

  for (const key of ['rchar', 'wchar', 'syscr', 'syscw', 'read_bytes', 'write_bytes', 'cancelled_write_bytes']) {
    kv(key, snapshot.values[key] ?? 'n/a')
  }
}

function printProcessCandidate(title: string, process: ProcessRecord | null) {
  heading(title)
  if (!process) {
    print('(not found)')
    return
  }

  kv('PID', process.pid)
  kv('PPID', process.ppid)
  kv('Elapsed', process.elapsed)
  kv('CPU %', process.pcpu)
  kv('MEM %', process.pmem)
  kv('RSS KB', process.rssKb)
  kv('Args', process.args)
}

function printProcessMemorySnapshot(title: string, snapshot: ProcessMemorySnapshot | null) {
  heading(title)
  if (!snapshot) {
    print('(not available)')
    return
  }

  kv('PID', snapshot.pid)
  if (snapshot.error) {
    kv('Error', snapshot.error)
    return
  }

  kv('Name', snapshot.name)
  kv('State', snapshot.state)
  kv('VmRSS KB', snapshot.vmRssKb)
  kv('VmHWM KB', snapshot.vmHwmKb)
  kv('VmSize KB', snapshot.vmSizeKb)
  kv('VmPeak KB', snapshot.vmPeakKb)
  kv('Threads', snapshot.threads)
  kv('FDSize', snapshot.fdSize)
  kv('voluntary_ctxt_switches', snapshot.voluntaryCtxtSwitches)
  kv('nonvoluntary_ctxt_switches', snapshot.nonvoluntaryCtxtSwitches)
  kv('oom_score', snapshot.oomScore)
  kv('oom_score_adj', snapshot.oomScoreAdj)
}

function printProcessActivitySamples(title: string, samples: ProcessActivitySample[]) {
  heading(title)
  if (samples.length === 0) {
    print('(none)')
    return
  }

  for (const sample of samples) {
    print(
      `- ${sample.label}` +
      ` pid=${sample.pid ?? 'n/a'}` +
      ` sample_ms=${sample.durationMs}` +
      ` cpu=${formatPercent(sample.cpuPercent)}` +
      ` rss=${formatBytes(sample.rssKb !== null ? sample.rssKb * 1024 : null)}` +
      ` threads=${sample.numThreads ?? 'n/a'}` +
      ` fds=${sample.fdCount ?? 'n/a'}` +
      ` fd_delta=${sample.fdCountDelta ?? 'n/a'}` +
      ` read_delta=${formatBytes(sample.readBytesDelta)}` +
      ` write_delta=${formatBytes(sample.writeBytesDelta)}` +
      ` syscr_delta=${sample.syscrDelta ?? 'n/a'}` +
      ` syscw_delta=${sample.syscwDelta ?? 'n/a'}` +
      ` state=${sample.state ?? 'n/a'}` +
      ` wchan=${sample.wchan ?? 'n/a'}`,
    )
    if (sample.command) print(`  command=${sample.command}`)
    if (sample.error) print(`  error=${sample.error}`)
  }
}

function printSystemUsageList(title: string, usages: SystemProcessUsage[], metric: 'cpu' | 'rss' | 'read' | 'write') {
  print(title)
  if (usages.length === 0) {
    print('- (none observed during sample)')
    return
  }

  for (const usage of usages) {
    const metricText = metric === 'cpu'
      ? formatPercent(usage.cpuPercent)
      : metric === 'rss'
        ? formatBytes(usage.rssKb !== null ? usage.rssKb * 1024 : null)
        : metric === 'read'
          ? formatBytes(usage.readBytesDelta)
          : formatBytes(usage.writeBytesDelta)
    print(`- pid=${usage.pid} ${metric}=${metricText} cmd=${usage.command}`)
  }
}

function printSystemProcessActivitySnapshot(title: string, snapshot: SystemProcessActivitySnapshot) {
  heading(title)
  kv('Sample duration', formatDuration(snapshot.durationMs))
  kv('Processes sampled', snapshot.processCount)
  printSystemUsageList('Top CPU consumers:', snapshot.topCpu, 'cpu')
  printSystemUsageList('Top RSS consumers:', snapshot.topRss, 'rss')
  printSystemUsageList('Top read I/O consumers during sample:', snapshot.topReadBytes, 'read')
  printSystemUsageList('Top write I/O consumers during sample:', snapshot.topWriteBytes, 'write')
}

function formatTrendHttpProbe(probe: HttpProbeResult): string {
  const status = probe.status ?? 'n/a'
  return `${probe.ok ? 'ok' : 'fail'}:${status}:${formatDuration(probe.durationMs)}`
}

function formatPressureDelta(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'n/a'
  if (value === 0) return '0ms'
  return `${(value / 1000).toFixed(1)}ms`
}

function hasPressureDelta(delta: PressureTrendDelta): boolean {
  return Object.values(delta).some((value) => (value ?? 0) > 0)
}

function formatSystemUsageShort(usage: SystemProcessUsage | undefined, metric: 'cpu' | 'rss' | 'read' | 'write'): string {
  if (!usage) return 'n/a'
  const metricText = metric === 'cpu'
    ? formatPercent(usage.cpuPercent)
    : metric === 'rss'
      ? formatBytes(usage.rssKb !== null ? usage.rssKb * 1024 : null)
    : metric === 'read'
      ? formatBytes(usage.readBytesDelta)
      : formatBytes(usage.writeBytesDelta)
  return `pid=${usage.pid} ${metric}=${metricText} cmd=${formatBodyPreview(usage.command, 90)}`
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1))
  return sorted[index] ?? null
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function formatDurationStat(value: number | null): string {
  return value === null ? 'n/a' : formatDuration(Math.round(value))
}

function formatTrendProbeStats(label: string, probes: HttpProbeResult[]) {
  const durations = probes.map((probe) => probe.durationMs)
  const failures = probes.filter((probe) => !probe.ok).length
  print(
    `${label}:` +
    ` min=${formatDurationStat(percentile(durations, 0))}` +
    ` avg=${formatDurationStat(average(durations))}` +
    ` p50=${formatDurationStat(percentile(durations, 50))}` +
    ` p95=${formatDurationStat(percentile(durations, 95))}` +
    ` max=${formatDurationStat(percentile(durations, 100))}` +
    ` failures=${failures}/${probes.length}`,
  )
}

function formatTrendSampleSummary(sample: RuntimeTrendSample): string {
  return (
    `#${sample.index}` +
    ` at=${sample.at}` +
    ` elapsed=${formatDuration(sample.elapsedMs)}` +
    ` interval=${formatDuration(sample.intervalMs)}` +
    ` drift=${formatDuration(sample.loopDriftMs)}` +
    ` health=${formatTrendHttpProbe(sample.health)}` +
    ` tickets=${formatTrendHttpProbe(sample.tickets)}` +
    ` top_cpu=${formatSystemUsageShort(sample.systemActivity.topCpu[0], 'cpu')}` +
    ` top_rss=${formatSystemUsageShort(sample.systemActivity.topRss[0], 'rss')}` +
    ` top_write=${formatSystemUsageShort(sample.systemActivity.topWriteBytes[0], 'write')}`
  )
}

function pressureDeltaTotal(samples: RuntimeTrendSample[], key: keyof PressureTrendDelta): number | null {
  let sawValue = false
  let total = 0
  for (const sample of samples) {
    const value = sample.pressureDelta[key]
    if (value === null || !Number.isFinite(value)) continue
    sawValue = true
    total += value
  }
  return sawValue ? total : null
}

function aggregateSystemUsageAcrossTrend(samples: RuntimeTrendSample[]): SystemTrendUsageAggregate[] {
  const aggregates = new Map<string, SystemTrendUsageAggregate>()

  for (const sample of samples) {
    const sampleUsages = new Map<string, SystemProcessUsage>()
    for (const usage of [
      ...sample.systemActivity.topCpu,
      ...sample.systemActivity.topRss,
      ...sample.systemActivity.topReadBytes,
      ...sample.systemActivity.topWriteBytes,
    ]) {
      const key = `${usage.pid}\0${usage.command}`
      const existing = sampleUsages.get(key)
      if (!existing) {
        sampleUsages.set(key, { ...usage })
        continue
      }

      sampleUsages.set(key, {
        ...existing,
        cpuPercent: Math.max(existing.cpuPercent ?? -Infinity, usage.cpuPercent ?? -Infinity),
        rssKb: Math.max(existing.rssKb ?? -Infinity, usage.rssKb ?? -Infinity),
        readBytesDelta: Math.max(existing.readBytesDelta ?? 0, usage.readBytesDelta ?? 0),
        writeBytesDelta: Math.max(existing.writeBytesDelta ?? 0, usage.writeBytesDelta ?? 0),
      })
    }

    for (const [key, usage] of sampleUsages) {
      const aggregate = aggregates.get(key)
      if (!aggregate) {
        aggregates.set(key, {
          key,
          pid: usage.pid,
          command: usage.command,
          samples: 1,
          firstSeenAt: sample.at,
          lastSeenAt: sample.at,
          peakCpuPercent: usage.cpuPercent,
          peakRssKb: usage.rssKb,
          totalReadBytes: usage.readBytesDelta ?? 0,
          totalWriteBytes: usage.writeBytesDelta ?? 0,
        })
        continue
      }

      aggregate.samples += 1
      aggregate.lastSeenAt = sample.at
      aggregate.peakCpuPercent = Math.max(aggregate.peakCpuPercent ?? -Infinity, usage.cpuPercent ?? -Infinity)
      aggregate.peakRssKb = Math.max(aggregate.peakRssKb ?? -Infinity, usage.rssKb ?? -Infinity)
      aggregate.totalReadBytes += usage.readBytesDelta ?? 0
      aggregate.totalWriteBytes += usage.writeBytesDelta ?? 0
    }
  }

  return [...aggregates.values()].map((aggregate) => ({
    ...aggregate,
    peakCpuPercent: aggregate.peakCpuPercent === -Infinity ? null : aggregate.peakCpuPercent,
    peakRssKb: aggregate.peakRssKb === -Infinity ? null : aggregate.peakRssKb,
  }))
}

function printSystemTrendAggregateList(
  title: string,
  aggregates: SystemTrendUsageAggregate[],
  metric: 'cpu' | 'rss' | 'read' | 'write',
) {
  print(title)
  const sorted = aggregates
    .filter((aggregate) => {
      if (metric === 'cpu') return (aggregate.peakCpuPercent ?? 0) > 0
      if (metric === 'rss') return (aggregate.peakRssKb ?? 0) > 0
      if (metric === 'read') return aggregate.totalReadBytes > 0
      return aggregate.totalWriteBytes > 0
    })
    .sort((left, right) => {
      if (metric === 'cpu') return (right.peakCpuPercent ?? 0) - (left.peakCpuPercent ?? 0)
      if (metric === 'rss') return (right.peakRssKb ?? 0) - (left.peakRssKb ?? 0)
      if (metric === 'read') return right.totalReadBytes - left.totalReadBytes
      return right.totalWriteBytes - left.totalWriteBytes
    })
    .slice(0, 8)

  if (sorted.length === 0) {
    print('- (none observed during trend)')
    return
  }

  for (const aggregate of sorted) {
    print(
      `- pid=${aggregate.pid}` +
      ` peak_cpu=${formatPercent(aggregate.peakCpuPercent)}` +
      ` peak_rss=${formatBytes(aggregate.peakRssKb !== null ? aggregate.peakRssKb * 1024 : null)}` +
      ` read_total=${formatBytes(aggregate.totalReadBytes)}` +
      ` write_total=${formatBytes(aggregate.totalWriteBytes)}` +
      ` samples=${aggregate.samples}` +
      ` first=${aggregate.firstSeenAt}` +
      ` last=${aggregate.lastSeenAt}` +
      ` cmd=${formatBodyPreview(aggregate.command, 140)}`,
    )
  }
}

function printRuntimeTrendReport(title: string, report: RuntimeTrendReport) {
  heading(title)
  if (!report.enabled) {
    print('(disabled; pass --trend-ms with a positive value to enable)')
    return
  }
  if (report.samples.length === 0) {
    print('(no samples captured)')
    return
  }

  const maxProcessCpu = report.samples
    .flatMap((sample) => sample.processActivities)
    .filter((sample) => sample.cpuPercent !== null)
    .sort((left, right) => (right.cpuPercent ?? -Infinity) - (left.cpuPercent ?? -Infinity))[0]
  const maxFileGrowth = report.samples
    .flatMap((sample) => sample.files)
    .filter((sample) => (sample.sizeDeltaBytes ?? 0) > 0)
    .sort((left, right) => (right.sizeDeltaBytes ?? 0) - (left.sizeDeltaBytes ?? 0))[0]
  const topTicketSamples = report.samples
    .slice()
    .sort((left, right) => {
      if (left.tickets.ok !== right.tickets.ok) return left.tickets.ok ? 1 : -1
      return right.tickets.durationMs - left.tickets.durationMs
    })
    .slice(0, 5)
  const topHealthSamples = report.samples
    .slice()
    .sort((left, right) => {
      if (left.health.ok !== right.health.ok) return left.health.ok ? 1 : -1
      return right.health.durationMs - left.health.durationMs
    })
    .slice(0, 5)
  const systemTrendAggregates = aggregateSystemUsageAcrossTrend(report.samples)

  kv('Trend window', formatDuration(report.durationMs))
  kv('Trend interval target', formatDuration(report.intervalMs))
  kv('Samples captured', report.samples.length)
  formatTrendProbeStats('Health latency', report.samples.map((sample) => sample.health))
  formatTrendProbeStats('Tickets latency', report.samples.map((sample) => sample.tickets))
  if (maxProcessCpu) {
    print(`Max watched-process CPU: ${maxProcessCpu.label} pid=${maxProcessCpu.pid ?? 'n/a'} cpu=${formatPercent(maxProcessCpu.cpuPercent)} at rss=${formatBytes(maxProcessCpu.rssKb !== null ? maxProcessCpu.rssKb * 1024 : null)}`)
  }
  if (maxFileGrowth) {
    print(`Largest watched-file growth: ${maxFileGrowth.label} delta=${formatBytes(maxFileGrowth.sizeDeltaBytes)} size=${formatBytes(maxFileGrowth.sizeBytes)}`)
  }

  heading('Whole-System Trend Leaders')
  printSystemTrendAggregateList('Top peak RSS consumers across trend:', systemTrendAggregates, 'rss')
  printSystemTrendAggregateList('Top cumulative write I/O consumers across trend:', systemTrendAggregates, 'write')
  printSystemTrendAggregateList('Top cumulative read I/O consumers across trend:', systemTrendAggregates, 'read')
  printSystemTrendAggregateList('Top peak CPU consumers across trend:', systemTrendAggregates, 'cpu')

  heading('Top Latency Samples')
  print('Slowest /api/tickets samples:')
  for (const sample of topTicketSamples) {
    print(`- ${formatTrendSampleSummary(sample)}`)
  }
  print('Slowest /api/health samples:')
  for (const sample of topHealthSamples) {
    print(`- ${formatTrendSampleSummary(sample)}`)
  }

  heading('Watched Process Totals')
  const processLabels = Array.from(new Set(report.samples.flatMap((sample) => sample.processActivities.map((processSample) => processSample.label))))
  for (const label of processLabels) {
    const samples = report.samples
      .flatMap((sample) => sample.processActivities)
      .filter((processSample) => processSample.label === label)
    const cpuValues = samples
      .map((sample) => sample.cpuPercent)
      .filter((value): value is number => value !== null && Number.isFinite(value))
    const first = samples.find((sample) => sample.rssKb !== null || sample.fdCount !== null)
    const last = samples.slice().reverse().find((sample) => sample.rssKb !== null || sample.fdCount !== null)
    const totalRead = samples.reduce((sum, sample) => sum + (sample.readBytesDelta ?? 0), 0)
    const totalWrite = samples.reduce((sum, sample) => sum + (sample.writeBytesDelta ?? 0), 0)
    const totalFdDelta = samples.reduce((sum, sample) => sum + (sample.fdCountDelta ?? 0), 0)
    const rssDeltaKb = first?.rssKb !== null && first?.rssKb !== undefined && last?.rssKb !== null && last?.rssKb !== undefined
      ? last.rssKb - first.rssKb
      : null
    print(
      `- ${label}` +
      ` pid=${last?.pid ?? first?.pid ?? 'n/a'}` +
      ` cpu_avg=${formatPercent(average(cpuValues))}` +
      ` cpu_peak=${formatPercent(percentile(cpuValues, 100))}` +
      ` rss_first=${formatBytes(first?.rssKb !== null && first?.rssKb !== undefined ? first.rssKb * 1024 : null)}` +
      ` rss_last=${formatBytes(last?.rssKb !== null && last?.rssKb !== undefined ? last.rssKb * 1024 : null)}` +
      ` rss_delta=${formatBytes(rssDeltaKb !== null ? rssDeltaKb * 1024 : null)}` +
      ` fd_delta_total=${totalFdDelta}` +
      ` read_total=${formatBytes(totalRead)}` +
      ` write_total=${formatBytes(totalWrite)}`,
    )
  }

  heading('Watched File Totals')
  const fileLabels = Array.from(new Set(report.samples.flatMap((sample) => sample.files.map((file) => file.path))))
  let printedFileChange = false
  for (const path of fileLabels) {
    const samples = report.samples
      .flatMap((sample) => sample.files)
      .filter((file) => file.path === path)
    const first = samples.find((file) => file.sizeBytes !== null)
    const last = samples.slice().reverse().find((file) => file.sizeBytes !== null)
    const totalDelta = samples.reduce((sum, file) => sum + (file.sizeDeltaBytes ?? 0), 0)
    const maxGrowth = Math.max(0, ...samples.map((file) => file.sizeDeltaBytes ?? 0))
    if (totalDelta === 0 && maxGrowth === 0 && samples.every((file) => !file.error)) continue
    printedFileChange = true
    print(
      `- ${last?.label ?? first?.label ?? path}` +
      ` total_delta=${formatBytes(totalDelta)}` +
      ` max_interval_growth=${formatBytes(maxGrowth)}` +
      ` first_size=${formatBytes(first?.sizeBytes ?? null)}` +
      ` last_size=${formatBytes(last?.sizeBytes ?? null)}` +
      ` path=${path}` +
      `${samples.find((file) => file.error)?.error ? ` error=${samples.find((file) => file.error)?.error}` : ''}`,
    )
  }
  if (!printedFileChange) {
    print('(no watched DB/WAL/log file size changes during the observation window)')
  }

  heading('Pressure Totals')
  print(
    `io_some=${formatPressureDelta(pressureDeltaTotal(report.samples, 'ioSomeUs'))}` +
    ` io_full=${formatPressureDelta(pressureDeltaTotal(report.samples, 'ioFullUs'))}` +
    ` memory_some=${formatPressureDelta(pressureDeltaTotal(report.samples, 'memorySomeUs'))}` +
    ` memory_full=${formatPressureDelta(pressureDeltaTotal(report.samples, 'memoryFullUs'))}` +
    ` cpu_some=${formatPressureDelta(pressureDeltaTotal(report.samples, 'cpuSomeUs'))}` +
    ` cpu_full=${formatPressureDelta(pressureDeltaTotal(report.samples, 'cpuFullUs'))}`,
  )

  heading('Per-Sample Timeline')
  for (const sample of report.samples) {
    print(`- ${formatTrendSampleSummary(sample)}`)

    for (const processSample of sample.processActivities) {
      print(
        `  process ${processSample.label}` +
        ` pid=${processSample.pid ?? 'n/a'}` +
        ` cpu=${formatPercent(processSample.cpuPercent)}` +
        ` rss=${formatBytes(processSample.rssKb !== null ? processSample.rssKb * 1024 : null)}` +
        ` fd_delta=${processSample.fdCountDelta ?? 'n/a'}` +
        ` read_delta=${formatBytes(processSample.readBytesDelta)}` +
        ` write_delta=${formatBytes(processSample.writeBytesDelta)}` +
        ` state=${processSample.state ?? 'n/a'}` +
        ` wchan=${processSample.wchan ?? 'n/a'}`,
      )
    }

    if (hasPressureDelta(sample.pressureDelta)) {
      print(
        `  pressure_delta` +
        ` io_some=${formatPressureDelta(sample.pressureDelta.ioSomeUs)}` +
        ` io_full=${formatPressureDelta(sample.pressureDelta.ioFullUs)}` +
        ` memory_some=${formatPressureDelta(sample.pressureDelta.memorySomeUs)}` +
        ` memory_full=${formatPressureDelta(sample.pressureDelta.memoryFullUs)}` +
        ` cpu_some=${formatPressureDelta(sample.pressureDelta.cpuSomeUs)}` +
        ` cpu_full=${formatPressureDelta(sample.pressureDelta.cpuFullUs)}`,
      )
    }

    const changedFiles = sample.files.filter((file) => file.error || (file.sizeDeltaBytes ?? 0) !== 0)
    if (changedFiles.length === 0) {
      print('  file_changes=(none)')
    } else {
      for (const file of changedFiles) {
        print(
          `  file ${file.label}` +
          ` exists=${file.exists}` +
          ` size=${formatBytes(file.sizeBytes)}` +
          ` delta=${formatBytes(file.sizeDeltaBytes)}` +
          ` mtime=${file.modifiedAt ?? 'n/a'}` +
          `${file.error ? ` error=${file.error}` : ''}`,
        )
      }
    }
  }
}

function readMemoryStatSummary(): string | null {
  const raw = readOptionalProcText('/sys/fs/cgroup/memory.stat')
  if (!raw) return null

  const wanted = new Set(['anon', 'file', 'file_dirty', 'file_writeback', 'swapcached', 'pgmajfault'])
  return raw
    .split('\n')
    .filter((line) => wanted.has(line.split(/\s+/)[0] ?? ''))
    .join('; ')
}

function printCgroupResourceSnapshot() {
  heading('Cgroup Resource Snapshot')
  const platform = detectPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    print('(cgroup not available on this platform)')
    return
  }
  const entries = [
    ['cgroup.controllers', '/sys/fs/cgroup/cgroup.controllers'],
    ['cpuset.cpus.effective', '/sys/fs/cgroup/cpuset.cpus.effective'],
    ['memory.max', '/sys/fs/cgroup/memory.max'],
    ['memory.current', '/sys/fs/cgroup/memory.current'],
    ['memory.stat summary', null],
    ['memory.swap.max', '/sys/fs/cgroup/memory.swap.max'],
    ['memory.swap.current', '/sys/fs/cgroup/memory.swap.current'],
    ['cpu.max', '/sys/fs/cgroup/cpu.max'],
    ['cpu.stat', '/sys/fs/cgroup/cpu.stat'],
    ['io.stat', '/sys/fs/cgroup/io.stat'],
    ['pids.max', '/sys/fs/cgroup/pids.max'],
    ['pids.current', '/sys/fs/cgroup/pids.current'],
  ] as const

  for (const [label, path] of entries) {
    const raw = path === null ? readMemoryStatSummary() : readOptionalProcText(path)
    kv(label, raw ?? 'n/a')
  }
}

function printRepeatedBackendSamples(title: string, samples: RepeatedProbeSample[]) {
  heading(title)
  if (samples.length === 0) {
    print('(none)')
    return
  }

  const healthDurations = samples.map((sample) => sample.healthDurationMs)
  const ticketDurations = samples.map((sample) => sample.ticketsDurationMs)
  kv('Health max', formatDuration(Math.max(...healthDurations)))
  kv('Tickets max', formatDuration(Math.max(...ticketDurations)))
  kv('Health failures', samples.filter((sample) => !sample.healthOk).length)
  kv('Tickets failures', samples.filter((sample) => !sample.ticketsOk).length)

  for (const sample of samples) {
    print(
      `- at=${sample.at}` +
      ` health_ok=${sample.healthOk}` +
      ` health_status=${sample.healthStatus ?? 'n/a'}` +
      ` health_ms=${sample.healthDurationMs}` +
      ` tickets_ok=${sample.ticketsOk}` +
      ` tickets_status=${sample.ticketsStatus ?? 'n/a'}` +
      ` tickets_ms=${sample.ticketsDurationMs}` +
      ` stat=${sample.processStat ?? 'n/a'}` +
      ` wchan=${sample.processWchan ?? 'n/a'}` +
      ` health_error=${sample.healthError ?? 'n/a'}` +
      ` tickets_error=${sample.ticketsError ?? 'n/a'}`,
    )
  }
}

function printProjectSnapshot(project: ProjectSnapshot) {
  heading(`Attached Project ${project.id}`)
  kv('Folder', project.folderPath)
  if (project.resolvedFolderPath !== project.folderPath) {
    kv('Resolved folder', project.resolvedFolderPath)
  }
  kv('Path exists', project.exists)
  kv('Project DB', project.projectDbPath)
  kv('Project DB exists', project.projectDbExists)
  kv('Project name', project.projectName)
  kv('Project shortname', project.shortname)
  kv('Ticket counter', project.ticketCounter)
  kv('Ticket count', project.ticketCount)
  kv('Active session count', project.activeSessionCount)
  kv('DB open time', formatDuration(project.dbOpenMs))
  kv('DB query time', formatDuration(project.dbQueryMs))
  kv('Meta files checked', project.metaFilesChecked)
  kv('Missing meta files', project.missingMetaFiles)
  kv('Meta without baseBranch', project.metaWithoutBaseBranch)
  kv('Mount type', project.mount.fstype)
  kv('Mount source', project.mount.source)
  kv('Disk use %', project.diskUsage.usePercent)
  kv('Inode use %', project.inodeUsage.usePercent)

  print('Path/meta file check details:')
  if (project.pathCheckDetails.length === 0 && project.metaCheckDetails.length === 0) {
    print('(none)')
  } else {
    for (const detail of [...project.pathCheckDetails, ...project.metaCheckDetails]) {
      print(`- ${detail}`)
    }
  }

  print('Recent tickets:')
  if (project.recentTickets.length === 0) {
    print('(none)')
  } else {
    for (const ticket of project.recentTickets) {
      print(`- ${ticket.external_id} | ${ticket.status} | updated_at=${ticket.updated_at}`)
    }
  }

  print('Latest non-terminal ticket execution log tail:')
  if (!project.latestNonTerminalTicketLog) {
    print('(none)')
  } else {
    print(
      `- ticket=${project.latestNonTerminalTicketLog.externalId} status=${project.latestNonTerminalTicketLog.status}` +
      ` exists=${project.latestNonTerminalTicketLog.exists} path=${project.latestNonTerminalTicketLog.logPath}`,
    )
    if (project.latestNonTerminalTicketLog.detail) {
      print(`- detail=${project.latestNonTerminalTicketLog.detail}`)
    }
    if (project.latestNonTerminalTicketLog.tailLines.length === 0) {
      print('(no log lines)')
    } else {
      for (const line of project.latestNonTerminalTicketLog.tailLines) {
        print(`- ${line}`)
      }
    }
  }

  print('Status counts:')
  if (project.statusCounts.length === 0) {
    print('(none)')
  } else {
    for (const status of project.statusCounts) {
      print(`- ${status.status}: ${status.count}`)
    }
  }

  print('Active OpenCode sessions:')
  if (project.activeSessions.length === 0) {
    print('(none)')
  } else {
    for (const session of project.activeSessions) {
      print(
        `- session=${session.session_id} ticket_id=${session.ticket_id ?? 'n/a'} phase=${session.phase}` +
        ` member=${session.member_id ?? 'n/a'} step=${session.step ?? 'n/a'} updated_at=${session.updated_at}`,
      )
    }
  }
}

function printAdvancedDiagnostics(params: {
  eventLoopLagMs: number
  dnsProbe: DnsProbeResult
  fdLimits: FdLimits
  tcpStats: TcpStats
  zombieCount: number
  heap: DiagnosticHeap
  swap: SwapSnapshot
  macosMetrics: MacosSystemMetrics
}) {
  banner('🧬  ADVANCED DIAGNOSTICS')

  heading('Event Loop Lag')
  kv('Event loop lag', `${params.eventLoopLagMs}ms`)

  heading('DNS Resolution Probe')
  kv('localhost', params.dnsProbe.ok
    ? `${params.dnsProbe.durationMs}ms → ${params.dnsProbe.addresses.join(', ')}`
    : `FAILED – ${params.dnsProbe.error}`)

  heading('File Descriptor Limits')
  if (params.fdLimits.error && !params.fdLimits.soft) {
    kv('FD limits', params.fdLimits.error)
  } else {
    kv('FD soft limit', params.fdLimits.soft ?? 'n/a')
    kv('FD hard limit', params.fdLimits.hard ?? 'n/a')
  }

  heading('TCP Connection States')
  if (params.tcpStats.error && params.tcpStats.established === 0) {
    kv('TCP stats', params.tcpStats.error)
  } else {
    kv('ESTABLISHED', params.tcpStats.established)
    kv('TIME_WAIT', params.tcpStats.timeWait)
    kv('CLOSE_WAIT', params.tcpStats.closeWait)
    kv('LISTEN', params.tcpStats.listen)
  }

  heading('Zombie Processes')
  kv('Zombie count', params.zombieCount)

  heading('Diagnostic Process Heap (this script)')
  kv('Heap used', `${params.heap.heapUsedMb} MiB`)
  kv('Heap total', `${params.heap.heapTotalMb} MiB`)
  kv('External', `${params.heap.externalMb} MiB`)
  kv('RSS', `${params.heap.rssMb} MiB`)

  heading('Swap Pressure')
  if (params.swap.error && params.swap.totalKb === null) {
    kv('Swap', params.swap.error)
  } else {
    kv('Swap total', formatBytes(params.swap.totalKb !== null ? params.swap.totalKb * 1024 : null))
    kv('Swap free', formatBytes(params.swap.freeKb !== null ? params.swap.freeKb * 1024 : null))
    kv('Swap used', formatBytes(params.swap.usedKb !== null ? params.swap.usedKb * 1024 : null))
    kv('Swap use %', formatPercent(params.swap.usePercent))
  }

  const platform = detectPlatform()
  if (platform === 'macos') {
    heading('macOS System Metrics')
    kv('CPU count', params.macosMetrics.cpuCount ?? 'n/a')
    kv('Load avg', params.macosMetrics.loadAvg ?? 'n/a')
    if (params.macosMetrics.vmStatRaw) {
      print('vm_stat:')
      for (const line of params.macosMetrics.vmStatRaw.split('\n').slice(0, 15)) {
        print(`  ${line}`)
      }
    }
    if (params.macosMetrics.topProcessesRaw) {
      print('Top processes:')
      for (const line of params.macosMetrics.topProcessesRaw.split('\n').slice(0, 12)) {
        print(`  ${line}`)
      }
    }
  }
}

async function main() {
  const platform = detectPlatform()

  banner('🩺  LoopTroop Runtime Stall Diagnostics')
  kv('Started at', startedAt.toISOString())
  kv('Working directory', process.cwd())
  kv('Node version', process.version)
  kv('Platform', `${platform} (${process.platform} ${process.arch})`)
  kv('WSL distro', process.env.WSL_DISTRO_NAME ?? 'n/a')
  kv('CLI options', cli)

  // Collect advanced diagnostics early (needed for Quick Summary)
  const [eventLoopLagMs, dnsProbe] = await Promise.all([
    measureEventLoopLag(),
    probeDns('localhost'),
  ])
  const fdLimits = readFdLimits()
  const tcpStats = readTcpStats()
  const zombieCount = countZombieProcesses()
  const heap = readDiagnosticProcessHeap()
  const swap = readSwapSnapshot()
  const macosMetrics = collectMacosSystemMetrics()

  const defaultEnv: Record<string, string> = {
    HOME: process.env.HOME ?? homedir(),
    ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}),
    ...(process.env.LOOPTROOP_CONFIG_DIR ? { LOOPTROOP_CONFIG_DIR: process.env.LOOPTROOP_CONFIG_DIR } : {}),
    ...(process.env.LOOPTROOP_APP_DB_PATH ? { LOOPTROOP_APP_DB_PATH: process.env.LOOPTROOP_APP_DB_PATH } : {}),
  }

  const backendPort = cli.backendPort
    ?? Number(process.env.LOOPTROOP_BACKEND_PORT || 3000)

  const processRecords = listProcessRecords()
  const backendPid = findListeningPid(backendPort)
  const backendCandidate = findFirstProcessMatch(processRecords, [
    /tsx watch server\/index\.ts/,
    /node .*tsx.*watch server\/index\.ts/,
    /npm run dev:backend/,
    /server\/index\.ts/,
  ])
  const frontendCandidate = findFirstProcessMatch(processRecords, [
    /node .*\/vite\b/,
    /\b vite\b/,
    /npm run dev:frontend/,
  ])
  const opencodeCandidate = findFirstProcessMatch(processRecords, [
    /\bopencode serve\b/,
    /tsx scripts\/dev-opencode\.ts/,
    /npm run dev:opencode/,
  ])
  const backendInspectPid = backendPid ?? backendCandidate?.pid ?? null
  const backendEnv = backendInspectPid ? readProcessEnv(backendInspectPid) : {}
  const effectiveEnv = { ...defaultEnv, ...backendEnv }
  const effectiveBackendPort = cli.backendPort
    ?? Number(backendEnv.LOOPTROOP_BACKEND_PORT || process.env.LOOPTROOP_BACKEND_PORT || 3000)
  const effectiveFrontendPort = cli.frontendPort
    ?? Number(backendEnv.LOOPTROOP_FRONTEND_PORT || process.env.LOOPTROOP_FRONTEND_PORT || 5173)
  const effectiveOpenCodeUrl = cli.opencodeUrl
    ?? backendEnv.LOOPTROOP_OPENCODE_BASE_URL
    ?? process.env.LOOPTROOP_OPENCODE_BASE_URL
    ?? 'http://127.0.0.1:4096'
  const timeoutMs = Number.isFinite(cli.timeoutMs) && (cli.timeoutMs ?? 0) > 0 ? cli.timeoutMs! : 4000
  const sampleMs = Number.isFinite(cli.sampleMs) && (cli.sampleMs ?? 0) > 0 ? cli.sampleMs! : 1000
  const trendMs = Number.isFinite(cli.trendMs) ? Math.max(0, Math.floor(cli.trendMs!)) : 180000
  const trendIntervalMs = Number.isFinite(cli.trendIntervalMs) && (cli.trendIntervalMs ?? 0) > 0
    ? Math.floor(cli.trendIntervalMs!)
    : 1000
  const appDbPath = resolveAppDbPath(effectiveEnv)
  const ticketRuntimeTarget = cli.ticketPath ? resolveTicketRuntimeTarget(cli.ticketPath) : null
  const frontendPid = findListeningPid(effectiveFrontendPort)
  const opencodePort = parseLocalPortFromUrl(effectiveOpenCodeUrl)
  const opencodePid = opencodePort ? findListeningPid(opencodePort) : null
  const frontendInspectPid = frontendPid ?? frontendCandidate?.pid ?? null
  const opencodeInspectPid = opencodePid ?? opencodeCandidate?.pid ?? null
  const watchedProcessTargets = [
    { label: 'backend', pid: backendInspectPid },
    { label: 'frontend', pid: frontendInspectPid },
    { label: 'opencode', pid: opencodeInspectPid },
  ]
  const backendCwd = backendInspectPid ? readProcessCwd(backendInspectPid) : null
  const frontendCwd = frontendInspectPid ? readProcessCwd(frontendInspectPid) : null
  const opencodeCwd = opencodeInspectPid ? readProcessCwd(opencodeInspectPid) : null
  const backendMemorySnapshot = backendInspectPid ? readProcessMemorySnapshot(backendInspectPid) : null
  const frontendMemorySnapshot = frontendInspectPid ? readProcessMemorySnapshot(frontendInspectPid) : null
  const opencodeMemorySnapshot = opencodeInspectPid ? readProcessMemorySnapshot(opencodeInspectPid) : null
  const workspaceMount = inspectMount(process.cwd())
  const workspaceDiskUsage = inspectDiskUsage(process.cwd())
  const workspaceInodeUsage = inspectInodeUsage(process.cwd())
  const appDbMount = inspectMount(appDbPath)
  const appDbDiskUsage = inspectDiskUsage(appDbPath)
  const appDbInodeUsage = inspectInodeUsage(appDbPath)
  const shellLatencyBaselines = collectShellLatencyBaselines()
  const appDbLatency = [
    measureFsLatency('stat app db', () => {
      const stats = statSync(appDbPath)
      return `size=${stats.size} mtime=${stats.mtime.toISOString()}`
    }),
    measureFsLatency('read app db header', () => {
      const buffer = readFileSync(appDbPath)
      return `header=${buffer.subarray(0, 16).toString('utf8').replace(/\0/g, '\\0')}`
    }),
    measureDiskWriteLatency(process.cwd()),
  ]
  const appDbInspection = inspectAppDatabase(appDbPath)
  const projectSnapshots = appDbInspection.attachedProjects.map(inspectProjectDatabase)

  const ioPressure = inspectPressureFile('/proc/pressure/io')
  const memoryPressure = inspectPressureFile('/proc/pressure/memory')
  const cpuPressure = inspectPressureFile('/proc/pressure/cpu')

  const frontendUrl = `http://localhost:${effectiveFrontendPort}`
  const backendHealthUrl = `http://localhost:${effectiveBackendPort}/api/health`
  const backendStartupUrl = `http://localhost:${effectiveBackendPort}/api/health/startup`
  const projectsUrl = `http://localhost:${effectiveBackendPort}/api/projects`
  const ticketsUrl = `http://localhost:${effectiveBackendPort}/api/tickets`
  const opencodeHealthUrl = `http://localhost:${effectiveBackendPort}/api/health/opencode`
  const trendProbeTimeoutMs = Math.min(timeoutMs, Math.max(500, Math.floor(trendIntervalMs * 0.8)))

  const frontendProbe = await probeHttp('frontend root', frontendUrl, timeoutMs)
  const healthProbe = await probeHttp('backend health', backendHealthUrl, timeoutMs)
  const startupProbe = await probeHttp('backend startup status', backendStartupUrl, timeoutMs)
  const projectsProbe = await probeHttp('projects list', projectsUrl, timeoutMs)
  const ticketsProbe = await probeHttp('tickets list', ticketsUrl, timeoutMs)
  const opencodeProbe = await probeHttp('backend OpenCode health', opencodeHealthUrl, timeoutMs)
  const repeatedBackendSamples = await sampleRepeatedBackendProbes({
    backendPid: backendInspectPid,
    backendHealthUrl,
    ticketsUrl,
    iterations: 5,
    intervalMs: 700,
    probeTimeoutMs: 900,
  })
  if (trendMs > 0) {
    print(`Collecting runtime observation trend for ${formatDuration(trendMs)} at ${formatDuration(trendIntervalMs)} intervals...`)
  }
  const runtimeTrend = await sampleRuntimeTrend({
    durationMs: trendMs,
    intervalMs: trendIntervalMs,
    backendHealthUrl,
    ticketsUrl,
    probeTimeoutMs: trendProbeTimeoutMs,
    processTargets: watchedProcessTargets,
    fileTargets: buildTrendFileTargets(appDbPath, projectSnapshots, ticketRuntimeTarget),
  })
  const [processActivities, systemActivity] = await Promise.all([
    sampleProcessActivities(watchedProcessTargets, sampleMs),
    sampleSystemProcessActivity(sampleMs),
  ])

  banner('🔍  ENVIRONMENT & CONFIGURATION')
  heading('Resolved Runtime Configuration')
  kv('Backend port', effectiveBackendPort)
  kv('Frontend port', effectiveFrontendPort)
  kv('OpenCode URL', effectiveOpenCodeUrl)
  kv('HTTP probe timeout', timeoutMs)
  kv('Process activity sample window', formatDuration(sampleMs))
  kv('Trend sample window', formatDuration(trendMs))
  kv('Trend sample interval', formatDuration(trendIntervalMs))
  kv('Trend HTTP probe timeout', formatDuration(trendProbeTimeoutMs))
  kv('Detected backend listener PID', backendPid)
  kv('Detected backend candidate PID', backendCandidate?.pid ?? 'n/a')
  kv('Backend inspect PID', backendInspectPid)
  kv('Detected frontend listener PID', frontendPid)
  kv('Detected frontend candidate PID', frontendCandidate?.pid ?? 'n/a')
  kv('Frontend inspect PID', frontendInspectPid)
  kv('Detected OpenCode listener PID', opencodePid)
  kv('Detected OpenCode candidate PID', opencodeCandidate?.pid ?? 'n/a')
  kv('OpenCode inspect PID', opencodeInspectPid)
  kv('Detected backend cwd', backendCwd ?? 'n/a')
  kv('Detected frontend cwd', frontendCwd ?? 'n/a')
  kv('Detected OpenCode cwd', opencodeCwd ?? 'n/a')
  kv('Resolved app DB path', appDbPath)
  kv('Focused ticket path', ticketRuntimeTarget?.inputPath ?? 'n/a')
  kv('Focused ticket runtime path', ticketRuntimeTarget?.runtimePath ?? 'n/a')

  printShellLatencyBaselines(shellLatencyBaselines)

  heading('Backend Environment Snapshot')
  if (Object.keys(backendEnv).length === 0) {
    print('(backend PID not found or /proc env unavailable)')
  } else {
    for (const key of [
      'HOME',
      'XDG_CONFIG_HOME',
      'LOOPTROOP_CONFIG_DIR',
      'LOOPTROOP_APP_DB_PATH',
      'LOOPTROOP_BACKEND_PORT',
      'LOOPTROOP_FRONTEND_PORT',
      'LOOPTROOP_FRONTEND_ORIGIN',
      'LOOPTROOP_OPENCODE_BASE_URL',
      'LOOPTROOP_OPENCODE_MODE',
      'CHOKIDAR_USEPOLLING',
      'NODE_OPTIONS',
      'npm_lifecycle_script',
    ]) {
      kv(key, backendEnv[key] ?? 'n/a')
    }
  }

  banner('🌐  NETWORK & ENDPOINT HEALTH')
  printHttpProbe(frontendProbe)
  printHttpProbe(healthProbe)
  printHttpProbe(startupProbe)
  printHttpProbe(projectsProbe)
  printHttpProbe(ticketsProbe)
  printHttpProbe(opencodeProbe)

  banner('🔁  REPEATED RUNTIME SAMPLES')
  printRepeatedBackendSamples('Backend Repeated Probe Samples', repeatedBackendSamples)
  printRuntimeTrendReport('Runtime Observation Trend', runtimeTrend)

  banner('⚙️   APPLICATION PROCESS ACTIVITY')
  printProcessCandidate('Backend Candidate Process', backendCandidate)
  printProcessCandidate('Frontend Candidate Process', frontendCandidate)
  printProcessCandidate('OpenCode Candidate Process', opencodeCandidate)
  printProcessMemorySnapshot('Backend Memory Snapshot', backendMemorySnapshot)
  printProcessMemorySnapshot('Frontend Memory Snapshot', frontendMemorySnapshot)
  printProcessMemorySnapshot('OpenCode Memory Snapshot', opencodeMemorySnapshot)
  printProcessActivitySamples('LoopTroop Process Activity Sample', processActivities)
  printSystemProcessActivitySnapshot('System Resource Consumers During Sample', systemActivity)

  if (backendInspectPid && platform === 'windows') {
    const backendPs = runPowerShell(`Get-Process -Id ${backendInspectPid} | Select-Object Id,ProcessName,CPU,WorkingSet64,StartTime | Format-List | Out-String`, 5000)
    printCommandResult(`Backend Process ${backendInspectPid}`, backendPs)
    printProcessIoSnapshot(`Backend /proc/${backendInspectPid}/io`, readProcessIo(backendInspectPid))
  } else if (backendInspectPid && commandExists('ps')) {
    const backendPsCommand = platform === 'macos'
      ? `ps -p ${backendInspectPid} -o pid,ppid,etime,pcpu,pmem,stat,command`
      : `ps -p ${backendInspectPid} -o pid,ppid,etime,pcpu,pmem,stat,wchan:32,args`
    const backendPs = runShell(backendPsCommand, 5000)
    printCommandResult(`Backend Process ${backendInspectPid}`, backendPs)

    if (platform === 'linux' || platform === 'wsl') {
      const backendThreads = runShell(`ps -L -p ${backendInspectPid} -o pid,tid,pcpu,stat,wchan:32,comm`, 5000)
      printCommandResult(`Backend Threads ${backendInspectPid}`, backendThreads)
    }
    printProcessIoSnapshot(`Backend /proc/${backendInspectPid}/io`, readProcessIo(backendInspectPid))

    if (commandExists('lsof')) {
      const backendFiles = runShell(
        `lsof -p ${backendInspectPid} | grep -E "app\\.sqlite|db\\.sqlite|sqlite|looptroop|\\.git|wal|shm" || true`,
        5000,
      )
      printCommandResult(`Backend Open Files ${backendInspectPid}`, backendFiles)
    }
  }

  if (frontendInspectPid) {
    printProcessIoSnapshot(`Frontend /proc/${frontendInspectPid}/io`, readProcessIo(frontendInspectPid))
  }

  if (opencodeInspectPid) {
    printProcessIoSnapshot(`OpenCode /proc/${opencodeInspectPid}/io`, readProcessIo(opencodeInspectPid))
  }

  const relevantPattern = 'vite|server/index.ts|dev-opencode|opencode serve|npm run dev|tsx watch server/index.ts|tsx scripts/dev.ts|tsx scripts/dev-backend.ts'
  const relevantProcessList = platform === 'windows'
    ? runPowerShell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match ${powerShellQuote(relevantPattern)} } | Select-Object ProcessId,ParentProcessId,Name,CommandLine | Format-Table -AutoSize | Out-String`, 5000)
    : runShell(
      platform === 'macos'
        ? `ps -axo pid,ppid,etime,pcpu,pmem,command | grep -E ${shellQuote(relevantPattern)} | grep -v grep`
        : `ps -eo pid,ppid,etime,pcpu,pmem,args --sort=pid | grep -E ${shellQuote(relevantPattern)} | grep -v grep`,
      5000,
    )
  printCommandResult('Relevant Process List', relevantProcessList)

  if (platform === 'windows') {
    const listeners = runPowerShell(
      `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in @(${effectiveFrontendPort}, ${effectiveBackendPort}, 4096, 4097) } | Select-Object LocalAddress,LocalPort,OwningProcess | Format-Table -AutoSize | Out-String`,
      5000,
    )
    printCommandResult('Listener Snapshot', listeners)
  } else if (commandExists('ss')) {
    const listeners = runShell(`ss -ltnp | grep -E ":${effectiveFrontendPort}|:${effectiveBackendPort}|4096|4097" || true`, 5000)
    printCommandResult('Listener Snapshot', listeners)
  } else if (commandExists('lsof')) {
    const listeners = runShell(`lsof -nP -iTCP:${effectiveFrontendPort} -iTCP:${effectiveBackendPort} -iTCP:4096 -iTCP:4097 -sTCP:LISTEN || true`, 5000)
    printCommandResult('Listener Snapshot', listeners)
  }

  banner('💻  SYSTEM RESOURCES')
  printPressureSnapshot('I/O Pressure Snapshot', ioPressure)
  printPressureSnapshot('Memory Pressure Snapshot', memoryPressure)
  printPressureSnapshot('CPU Pressure Snapshot', cpuPressure)
  printCgroupResourceSnapshot()

  const uptimeResult = runShell('uptime', 3000)
  printCommandResult('System Uptime', uptimeResult)

  if (platform === 'linux' || platform === 'wsl') {
    const loadavgResult = runShell('cat /proc/loadavg', 2000)
    printCommandResult('Load Average Raw', loadavgResult)

    const freeResult = runShell('free -h', 3000)
    printCommandResult('Memory Snapshot', freeResult)

    const topCpuResult = runShell(`ps -eo pid,ppid,etime,pcpu,pmem,rss,args --sort=-pcpu | head -n 20`, 5000)
    printCommandResult('Top CPU Processes Snapshot', topCpuResult)

    const topRssResult = runShell(`ps -eo pid,ppid,etime,pcpu,pmem,rss,args --sort=-rss | head -n 20`, 5000)
    printCommandResult('Top RSS Processes Snapshot', topRssResult)

    const meminfoResult = runShell(`grep -E 'MemTotal|MemAvailable|SwapTotal|SwapFree|Dirty|Writeback|Cached' /proc/meminfo || true`, 2000)
    printCommandResult('Key /proc/meminfo Fields', meminfoResult)

    if (commandExists('dmesg')) {
      const dmesgOomResult = runShell(`dmesg -T 2>/dev/null | grep -Ei 'out of memory|killed process|oom' | tail -n 40 || true`, 5000)
      printCommandResult('Kernel OOM Scan', dmesgOomResult)
    }

    if (commandExists('vmstat')) {
      const vmstatResult = runShell('vmstat 1 2', 4000)
      printCommandResult('vmstat Sample', vmstatResult)
    }

    if (commandExists('iostat')) {
      const iostatResult = runShell('iostat -xz 1 2', 5000)
      printCommandResult('iostat Sample', iostatResult)
    } else {
      const diskstatsResult = runShell(`grep -E ' (sd|vd|nvme|dm-|loop)' /proc/diskstats || true`, 2000)
      printCommandResult('/proc/diskstats Snapshot', diskstatsResult)
    }
  } else if (platform === 'macos') {
    const topCpuResult = runShell('top -l 1 -n 20 -stats pid,command,cpu,mem,rsize 2>/dev/null | tail -n +13', 5000)
    printCommandResult('Top CPU Processes Snapshot', topCpuResult)
  } else {
    const windowsMemory = runPowerShell('Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize,FreePhysicalMemory,TotalVirtualMemorySize,FreeVirtualMemory | Format-List | Out-String', 5000)
    printCommandResult('Memory Snapshot', windowsMemory)

    const windowsTopCpu = runPowerShell('Get-Process | Sort-Object CPU -Descending | Select-Object -First 20 Id,ProcessName,CPU,WorkingSet64 | Format-Table -AutoSize | Out-String', 5000)
    printCommandResult('Top CPU Processes Snapshot', windowsTopCpu)
  }

  banner('💾  STORAGE, MOUNTS & FILESYSTEM')
  printMountSnapshot('Workspace Mount Snapshot', workspaceMount)
  printDiskUsageSnapshot('Workspace Disk Usage', workspaceDiskUsage)
  printInodeUsageSnapshot('Workspace Inode Usage', workspaceInodeUsage)
  printMountSnapshot('App DB Mount Snapshot', appDbMount)
  printDiskUsageSnapshot('App DB Disk Usage', appDbDiskUsage)
  printInodeUsageSnapshot('App DB Inode Usage', appDbInodeUsage)
  printLatencyProbes('App DB Filesystem Latency Probes', appDbLatency)
  if (ticketRuntimeTarget) {
    printTicketRuntimeSnapshot(ticketRuntimeTarget)
  }

  banner('🗄️   DATABASE & PROJECT STATE')
  printFileStats('App DB File Stats', appDbPath)
  printFileStats('App DB WAL Stats', `${appDbPath}-wal`)
  printFileStats('App DB SHM Stats', `${appDbPath}-shm`)

  heading('App DB Inspection')
  kv('App DB exists', appDbInspection.exists)
  kv('Open time', formatDuration(appDbInspection.openMs))
  kv('Query time', formatDuration(appDbInspection.queryMs))
  if (appDbInspection.error) kv('Error', appDbInspection.error)
  kv('Attached project count', appDbInspection.attachedProjects.length)
  if (appDbInspection.attachedProjects.length === 0) {
    print('(no attached projects found)')
  } else {
    for (const project of appDbInspection.attachedProjects) {
      print(`- id=${project.id} folder=${project.folderPath} created_at=${project.createdAt} updated_at=${project.updatedAt}`)
    }
  }

  for (const project of projectSnapshots) {
    printProjectSnapshot(project)
    printMountSnapshot(`Project ${project.id} Mount Snapshot`, project.mount)
    printDiskUsageSnapshot(`Project ${project.id} Disk Usage`, project.diskUsage)
    printInodeUsageSnapshot(`Project ${project.id} Inode Usage`, project.inodeUsage)
    printLatencyProbes(`Project ${project.id} Filesystem Latency Probes`, project.latencyProbes)
    printFileStats(`Project ${project.id} DB File Stats`, project.projectDbPath)
    printFileStats(`Project ${project.id} DB WAL Stats`, `${project.projectDbPath}-wal`)
    printFileStats(`Project ${project.id} DB SHM Stats`, `${project.projectDbPath}-shm`)
    printFileStats(`Project ${project.id} Git Index Stats`, resolve(project.resolvedFolderPath, '.git', 'index'))
  }

  banner('🔀  GIT RESPONSIVENESS')
  for (const project of projectSnapshots) {
    const projectPathArg = commandShellQuote(project.resolvedFolderPath)
    const gitStatus = runShell(`git -C ${projectPathArg} status --short --branch`, 5000)
    printCommandResult(`Project ${project.id} Git Status`, gitStatus)

    const gitStatusTrace = runShell(
      platform === 'windows'
        ? `$env:GIT_TRACE2_PERF = '1'; git -C ${powerShellQuote(project.resolvedFolderPath)} status --short --branch`
        : `env GIT_TRACE2_PERF=1 git -C ${projectPathArg} status --short --branch`,
      7000,
    )
    printCommandResult(`Project ${project.id} Git Status Trace2`, gitStatusTrace)

    const gitBranch = runShell(`git -C ${projectPathArg} rev-parse --abbrev-ref HEAD`, 3000)
    printCommandResult(`Project ${project.id} Git Branch`, gitBranch)

    const gitRemoteHead = runShell(`git -C ${projectPathArg} symbolic-ref --quiet --short refs/remotes/origin/HEAD`, 3000)
    printCommandResult(`Project ${project.id} Git Remote HEAD`, gitRemoteHead)
  }

  printAdvancedDiagnostics({ eventLoopLagMs, dnsProbe, fdLimits, tcpStats, zombieCount, heap, swap, macosMetrics })

  heading('Report Saved')
  kv('Path', reportPath)
  kv('Finished at', new Date().toISOString())

  mkdirSync(reportDir, { recursive: true })
  writeFileSync(reportPath, `${reportLines.join('\n')}\n`, 'utf8')
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function commandShellQuote(value: string): string {
  return detectPlatform() === 'windows' ? powerShellQuote(value) : shellQuote(value)
}

await main()
