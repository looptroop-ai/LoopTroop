import { execFileSync } from 'node:child_process'
import { existsSync, accessSync, constants } from 'node:fs'
import { resolveAppConfigDir } from '../lib/appConfigDir'
import { resolveSettings, getSettingsPath } from '../lib/appSettings'
import { resolveInstallInfo } from '../lib/installChannel'
import { probePort } from '../lib/portProbe'
import { readDaemonStartFailure, type DaemonState } from '../lib/daemonPaths'
import type { SchemaCompatibility } from '../db/schemaVersion'
import { readRunningDaemon } from './commands'

type Status = 'ok' | 'warn' | 'fail'

/**
 * The version facts behind a schema check, for `--json` consumers.
 *
 * `detail` is prose aimed at a person and its wording is not a contract. A
 * script deciding whether to upgrade, or naming the file to move aside, gets
 * the numbers here instead of parsing a sentence.
 */
interface SchemaFacts {
  databasePath: string
  found: number
  expected: number
}

interface Check {
  name: string
  status: Status
  detail: string
  /** Shown only when the check is not ok. */
  remedy?: string
  /** Present on the schema checks only. */
  schema?: SchemaFacts
}

const REQUIRED_NODE_MAJOR = 24
const REQUIRED_NODE_MINOR = 15

/** Enough for a local binary to print its version and exit. */
const PROBE_TIMEOUT_MS = 5_000
/** Longer, for the one probe that reaches the network before it answers. */
const NETWORK_PROBE_TIMEOUT_MS = 10_000

function installHint(tool: string): string {
  switch (process.platform) {
    case 'darwin': return `brew install ${tool}`
    case 'win32': return `winget install ${tool}`
    default: return `Use your package manager, e.g. apt install ${tool}`
  }
}

/** What running one of doctor's probe commands established. */
export type ProbeResult =
  | { kind: 'ok'; output: string }
  | { kind: 'timed-out' }
  /** Not on PATH, or on it and exiting non-zero. */
  | { kind: 'unavailable' }

/**
 * Runs one of doctor's probe commands under a deadline.
 *
 * Every one of them normally answers instantly, and the deadline is what keeps
 * `doctor` from becoming the thing that hangs. `gh auth status` is the sharp
 * case: it reaches github.com to validate the token, so a black-holed proxy
 * turns the command someone runs to diagnose a hang into a second hang, with no
 * output and nothing to interrupt — execFileSync blocks the whole process, so
 * there is no later point at which this could be given up on.
 */
export function runProbe(command: string, args: string[], timeoutMs: number): ProbeResult {
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
    })
    return { kind: 'ok', output }
  } catch (error) {
    // A command that was found and then hung is a different problem from one
    // that is not installed, and the install hint would be wrong advice.
    return (error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
      ? { kind: 'timed-out' }
      : { kind: 'unavailable' }
  }
}

/** The line to show for a probe that never came back, and what to do about it. */
function timedOutCheck(name: string, command: string, timeoutMs: number): Omit<Check, 'status'> {
  return {
    name,
    detail: `\`${command}\` did not answer within ${timeoutMs / 1000}s`,
    remedy: `Run \`${command}\` yourself to see what it is waiting for.`,
  }
}

function checkNode(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const supported = major > REQUIRED_NODE_MAJOR
    || (major === REQUIRED_NODE_MAJOR && minor >= REQUIRED_NODE_MINOR)

  return supported
    ? { name: 'node', status: 'ok', detail: `v${process.versions.node}` }
    : {
        name: 'node',
        status: 'fail',
        detail: `v${process.versions.node}`,
        remedy: `LoopTroop needs Node ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0 or newer. Install it with nvm: nvm install ${REQUIRED_NODE_MAJOR}`,
      }
}

function checkBinary(name: string, args: string[], required: boolean): Check {
  const probe = runProbe(name, args, PROBE_TIMEOUT_MS)
  if (probe.kind === 'ok') {
    return { name, status: 'ok', detail: probe.output.trim().split('\n')[0] ?? 'present' }
  }

  if (probe.kind === 'timed-out') {
    // Installed, and stuck. Whether that is fatal is the same question as for a
    // missing one: git is not optional, gh is.
    return { status: required ? 'fail' : 'warn', ...timedOutCheck(name, `${name} ${args.join(' ')}`, PROBE_TIMEOUT_MS) }
  }

  return {
    name,
    status: required ? 'fail' : 'warn',
    detail: 'not found on PATH',
    remedy: installHint(name),
  }
}

function checkGitHubAuth(): Check {
  // The one probe that goes to the network: `gh auth status` validates the
  // token against github.com rather than reading it locally.
  const probe = runProbe('gh', ['auth', 'status'], NETWORK_PROBE_TIMEOUT_MS)
  if (probe.kind === 'ok') return { name: 'gh auth', status: 'ok', detail: 'authenticated' }

  if (probe.kind === 'timed-out') {
    return { status: 'warn', ...timedOutCheck('gh auth', 'gh auth status', NETWORK_PROBE_TIMEOUT_MS) }
  }

  return {
    name: 'gh auth',
    status: 'warn',
    detail: 'not authenticated',
    remedy: 'Run `gh auth login`. Only needed for pull-request delivery.',
  }
}

function checkConfigDir(): Check {
  const configDir = resolveAppConfigDir()
  if (!existsSync(configDir)) {
    // Created on first start, so its absence is not itself a problem.
    return { name: 'config dir', status: 'ok', detail: `${configDir} (not created yet)` }
  }

  try {
    accessSync(configDir, constants.R_OK | constants.W_OK)
    return { name: 'config dir', status: 'ok', detail: configDir }
  } catch {
    return {
      name: 'config dir',
      status: 'fail',
      detail: `${configDir} is not writable`,
      remedy: 'Fix the directory permissions, or set LOOPTROOP_CONFIG_DIR to a writable path.',
    }
  }
}

/** What asking the OpenCode server for its config established. */
export type OpenCodeReachability =
  | { kind: 'ok' }
  | { kind: 'unreachable' }
  | { kind: 'responded'; status: number }

/**
 * Whether this machine can run a coding operation, from the three facts that
 * decide it: is a server answering, is a daemon already relying on one, and
 * could a start launch one.
 *
 * Every one of these used to be a warning, so `doctor` exited 0 — and printed
 * "This machine can run LoopTroop" — on a machine where `looptroop start` is
 * refused outright for want of the binary, and on one where the daemon is up
 * and its OpenCode has been dead for an hour. Both are the exact question the
 * command was run to answer.
 *
 * Unreachable on its own is still a warning, and deliberately so: on a machine
 * where nothing has been started yet there is no server, and the next start
 * launches one. Reporting that as broken would fail every fresh install.
 */
export function judgeOpenCode(
  reachable: OpenCodeReachability,
  context: { baseUrl: string; daemon: DaemonState | null; cliAvailable: boolean },
): Check {
  const { baseUrl } = context
  if (reachable.kind === 'ok') {
    return { name: 'opencode', status: 'ok', detail: `reachable at ${baseUrl}` }
  }

  const detail = reachable.kind === 'responded'
    ? `responded ${reachable.status} at ${baseUrl}`
    : `not reachable at ${baseUrl}`

  // A daemon that has an OpenCode record is one that needs a server; that it is
  // not answering means every operation LoopTroop exists to perform fails right
  // now. A daemon in mock mode records nothing, and is not evidence either way.
  const daemonOpenCode = context.daemon?.opencode
  if (daemonOpenCode) {
    const gaveUp = daemonOpenCode.status === 'degraded' ? daemonOpenCode.detail : undefined
    return {
      name: 'opencode',
      status: 'fail',
      detail: gaveUp ? `${detail}; LoopTroop gave up on it: ${gaveUp}` : `${detail}, while LoopTroop is running`,
      remedy: 'Run `looptroop restart`. If that does not fix it, run `opencode serve` yourself to see why.',
    }
  }

  if (!context.cliAvailable) {
    return {
      name: 'opencode',
      status: 'fail',
      // Nothing is running and nothing could be started: the next start is
      // refused before it binds a port, rather than launching a server.
      detail: `${detail}, and \`opencode\` cannot be launched`,
      remedy: 'Install it from https://opencode.ai, or point LOOPTROOP_OPENCODE_BASE_URL at a running server.',
    }
  }

  return {
    name: 'opencode',
    status: 'warn',
    detail: `${detail}; \`looptroop start\` will launch one`,
    remedy: 'No action needed: LoopTroop starts OpenCode itself.',
  }
}

async function checkOpenCode(daemon: DaemonState | null, cliAvailable: boolean): Promise<Check> {
  const settings = resolveSettings()
  if (settings.opencodeMode === 'mock') {
    return { name: 'opencode', status: 'ok', detail: 'mock mode' }
  }

  const reachable = await probeOpenCodeConfig(settings.opencodeBaseUrl)
  return judgeOpenCode(reachable, { baseUrl: settings.opencodeBaseUrl, daemon, cliAvailable })
}

async function probeOpenCodeConfig(baseUrl: string): Promise<OpenCodeReachability> {
  try {
    const response = await fetch(`${baseUrl}/config`, { signal: AbortSignal.timeout(2_000) })
    return response.ok ? { kind: 'ok' } : { kind: 'responded', status: response.status }
  } catch {
    return { kind: 'unreachable' }
  }
}

/**
 * The version of the OpenCode binary this machine would launch. The running
 * server reports no version of its own, and the two can differ: a server that
 * was already up may predate an upgrade of the CLI on PATH.
 */
function checkOpenCodeVersion(): Check {
  if (resolveSettings().opencodeMode === 'mock') {
    return { name: 'opencode cli', status: 'ok', detail: 'not needed in mock mode' }
  }

  const probe = runProbe('opencode', ['--version'], PROBE_TIMEOUT_MS)
  if (probe.kind === 'ok') {
    return { name: 'opencode cli', status: 'ok', detail: probe.output.trim().split('\n')[0] || 'present' }
  }

  if (probe.kind === 'timed-out') {
    return { status: 'warn', ...timedOutCheck('opencode cli', 'opencode --version', PROBE_TIMEOUT_MS) }
  }

  return {
    name: 'opencode cli',
    status: 'warn',
    // A server that is already running can still serve LoopTroop, so a missing
    // binary is only a problem for starting one. Whether that is survivable is
    // decided by `judgeOpenCode`, which can see both facts at once.
    detail: 'not found on PATH',
    remedy: 'Install it from https://opencode.ai, or point LOOPTROOP_OPENCODE_BASE_URL at a running server.',
  }
}

/**
 * The port the next `looptroop start` would ask for. Occupied by our own daemon
 * is the expected case and not a fault; occupied by anything else is only fatal
 * when the port was named explicitly, which is exactly when the runtime refuses
 * to relocate.
 */
async function checkPort(daemon: DaemonState | null): Promise<Check> {
  const settings = resolveSettings()
  const port = settings.port

  if (daemon?.port === port) {
    return { name: 'port', status: 'ok', detail: `${port} in use by this LoopTroop (pid ${daemon.pid})` }
  }

  const probe = await probePort(port)
  switch (probe.kind) {
    case 'free':
      return { name: 'port', status: 'ok', detail: `${port} is free` }
    case 'in-use':
      return settings.portIsExplicit
        ? {
            name: 'port',
            status: 'fail',
            detail: `${port} is in use by another process`,
            remedy: 'Stop whatever holds it, or choose another port with --port.',
          }
        : {
            name: 'port',
            status: 'warn',
            detail: `${port} is in use by another process`,
            remedy: 'No action needed: LoopTroop will pick a free port instead.',
          }
    default:
      return {
        name: 'port',
        status: 'warn',
        detail: `${port} could not be checked: ${probe.message}`,
        remedy: 'Check the local firewall or privilege rules for this port.',
      }
  }
}

function checkDaemon(daemon: DaemonState | null): Check {
  return daemon
    ? { name: 'daemon', status: 'ok', detail: `running on http://${daemon.host}:${daemon.port} (pid ${daemon.pid})` }
    : { name: 'daemon', status: 'ok', detail: 'not running' }
}

type DatabaseInspection =
  | { kind: 'missing' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'classified'; compatibility: SchemaCompatibility }

/**
 * Classifies a database without opening it for writing.
 *
 * `doctor` is the command someone runs when they suspect their data is already
 * in trouble, so it must never be the thing that stamps a version or runs boot
 * DDL. Read-only is the whole point of not reusing the startup path here.
 */
async function inspectDatabase(
  databasePath: string,
  expected: number,
  migratableFrom: number,
): Promise<DatabaseInspection> {
  if (!existsSync(databasePath)) return { kind: 'missing' }

  const [{ Database }, schema] = await Promise.all([
    import('../db/sqliteShim'),
    import('../db/schemaVersion'),
  ])

  let store: InstanceType<typeof Database> | null = null
  try {
    store = new Database(databasePath, { readonly: true })
    return {
      kind: 'classified',
      compatibility: schema.classifySchemaVersion(
        schema.inspectSchemaVersion(store),
        expected,
        migratableFrom,
      ),
    }
  } catch (error) {
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) }
  } finally {
    try {
      store?.close()
    } catch {
      // Nothing useful to do if the handle is already gone.
    }
  }
}

/**
 * Reports an unopenable database here rather than leaving it to surface as a
 * failed start, so the found and expected versions are visible before anything
 * tries to mutate the file.
 */
async function checkSchema(): Promise<Check> {
  const [{ APP_DB_PATH }, schema] = await Promise.all([
    import('../db/index'),
    import('../db/schemaVersion'),
  ])
  const inspection = await inspectDatabase(
    APP_DB_PATH,
    schema.APP_SCHEMA_VERSION,
    schema.APP_MIGRATABLE_FROM,
  )

  if (inspection.kind === 'missing') {
    return { name: 'schema', status: 'ok', detail: 'no database yet' }
  }

  if (inspection.kind === 'unreadable') {
    return {
      name: 'schema',
      status: 'fail',
      detail: `cannot read ${APP_DB_PATH}: ${inspection.message}`,
      remedy: 'Check the file permissions, or delete the database to start clean.',
    }
  }

  const { compatibility } = inspection
  const found = 'found' in compatibility
    ? compatibility.found
    : compatibility.kind === 'current'
      ? schema.APP_SCHEMA_VERSION
      : schema.UNVERSIONED_SCHEMA_VERSION
  const facts: SchemaFacts = { databasePath: APP_DB_PATH, found, expected: schema.APP_SCHEMA_VERSION }

  switch (compatibility.kind) {
    case 'newer':
      return {
        name: 'schema',
        status: 'fail',
        detail: `database is version ${compatibility.found}, this build supports ${schema.APP_SCHEMA_VERSION}`,
        remedy: `Upgrade LoopTroop, or point LOOPTROOP_CONFIG_DIR elsewhere. Database: ${APP_DB_PATH}`,
        schema: facts,
      }
    case 'unsupported':
      return {
        name: 'schema',
        status: 'fail',
        detail: `database is version ${compatibility.found}, too old to upgrade`,
        remedy: `Delete ${APP_DB_PATH} to start clean, or run an older LoopTroop first.`,
        schema: facts,
      }
    case 'older':
      return {
        name: 'schema',
        status: 'warn',
        detail: `database is version ${compatibility.found}; it will be upgraded to ${schema.APP_SCHEMA_VERSION} on next start`,
        remedy: 'No action needed. The upgrade runs automatically.',
        schema: facts,
      }
    case 'unversioned':
      return {
        name: 'schema',
        status: 'warn',
        detail: 'database predates 0.5.0 and carries no version marker',
        remedy: `Delete ${APP_DB_PATH} to start clean if LoopTroop misbehaves.`,
        schema: facts,
      }
    case 'fresh':
      return {
        name: 'schema',
        status: 'ok',
        detail: 'no database yet',
        schema: facts,
      }
    default:
      return { name: 'schema', status: 'ok', detail: `version ${schema.APP_SCHEMA_VERSION}`, schema: facts }
  }
}

/**
 * Reports a start the schema guard refused, which nothing else here can see.
 *
 * The daemon that hit it is gone, and the database it named need not be the app
 * database checked above: a project database is only opened when that project
 * is used, so `doctor` would otherwise pass while every start keeps failing.
 *
 * The record is re-checked rather than trusted. Someone who upgraded LoopTroop
 * or moved the file aside has already fixed it, and a refusal from last week
 * reported as a live failure would send them hunting for a problem that is no
 * longer there.
 */
async function checkLastStart(): Promise<Check> {
  const failure = readDaemonStartFailure()
  if (!failure) {
    return { name: 'last start', status: 'ok', detail: 'no refused start recorded' }
  }

  // The versions the refusal was about, not what the file says now: this check
  // reports the recorded event, and `schema` above reports the current state.
  const facts: SchemaFacts = {
    databasePath: failure.schema.databasePath,
    found: failure.schema.found,
    expected: failure.schema.expected,
  }
  const inspection = await inspectDatabase(
    failure.schema.databasePath,
    failure.schema.expected,
    failure.schema.migratableFrom,
  )
  const stillRefused = inspection.kind === 'classified'
    && (inspection.compatibility.kind === 'newer' || inspection.compatibility.kind === 'unsupported')

  if (!stillRefused) {
    return {
      name: 'last start',
      status: 'ok',
      detail: inspection.kind === 'missing'
        ? `refused at ${failure.at}; ${failure.schema.databasePath} is gone, so the next start will proceed`
        : `refused at ${failure.at}; the ${failure.schema.databaseLabel} is readable again`,
      schema: facts,
    }
  }

  return {
    name: 'last start',
    status: 'fail',
    detail: `refused at ${failure.at}: the ${failure.schema.databaseLabel} reports version ${failure.schema.found}, LoopTroop ${failure.version} supports ${failure.schema.expected}`,
    remedy: failure.schema.found > failure.schema.expected
      ? `Upgrade LoopTroop to the version that wrote ${failure.schema.databasePath}.`
      : `Delete ${failure.schema.databasePath} to start clean, or run an older LoopTroop first.`,
    schema: facts,
  }
}

function checkInstallChannel(): Check {
  const info = resolveInstallInfo()
  return info.channel === 'unknown'
    ? {
        name: 'install',
        status: 'warn',
        detail: 'could not determine how LoopTroop was installed',
        // A wrong upgrade command is worse than none, so this stays a warning.
        remedy: `${info.upgradeCommand}. To settle it, set "install": { "channel": "npm" } in ${getSettingsPath()}.`,
      }
    : { name: 'install', status: 'ok', detail: `${info.channel} (upgrade: ${info.upgradeCommand})` }
}

/**
 * Re-checks the ignore choice made at attach time, since a repository's
 * .gitignore can be rewritten by anyone long after the project was added.
 */
async function checkProjectIgnores(): Promise<Check> {
  const { APP_DB_PATH } = await import('../db/index')
  if (!existsSync(APP_DB_PATH)) {
    return { name: 'project ignores', status: 'ok', detail: 'no projects attached yet' }
  }

  const [{ db }, { attachedProjects }, { areLoopTroopPathsIgnored }] = await Promise.all([
    import('../db/index'),
    import('../db/schema'),
    import('../git/repository'),
  ])

  let rows: { folderPath: string }[]
  try {
    rows = db.select().from(attachedProjects).all()
  } catch {
    // The schema check above already reports an unreadable database.
    return { name: 'project ignores', status: 'ok', detail: 'skipped, database unreadable' }
  }

  if (rows.length === 0) {
    return { name: 'project ignores', status: 'ok', detail: 'no projects attached yet' }
  }

  const unignored = rows
    .filter((row) => existsSync(row.folderPath) && !areLoopTroopPathsIgnored(row.folderPath))
    .map((row) => row.folderPath)

  return unignored.length === 0
    ? { name: 'project ignores', status: 'ok', detail: `${rows.length} project(s) ignore LoopTroop state` }
    : {
        name: 'project ignores',
        status: 'warn',
        detail: `not ignored in: ${unignored.join(', ')}`,
        remedy: 'Re-attach the project and pick an ignore option, or add /.looptroop/ and /.ticket/ yourself.',
      }
}

export async function runChecks(): Promise<Check[]> {
  // Read once and shared: the port check needs to know whether the process
  // holding the port is our own daemon, and probing twice would be two more
  // HTTP requests for an answer that cannot have changed in between.
  const daemon = await readRunningDaemon()
  // Run before the server check, which needs its verdict: an unreachable
  // OpenCode is survivable only when there is a binary left to start one.
  const opencodeCli = checkOpenCodeVersion()

  return [
    checkNode(),
    checkBinary('git', ['--version'], true),
    checkBinary('gh', ['--version'], false),
    checkGitHubAuth(),
    checkConfigDir(),
    checkInstallChannel(),
    await checkSchema(),
    await checkLastStart(),
    await checkProjectIgnores(),
    opencodeCli,
    await checkOpenCode(daemon, opencodeCli.status === 'ok'),
    await checkPort(daemon),
    checkDaemon(daemon),
  ]
}

export async function doctorCommand(json: boolean): Promise<number> {
  const checks = await runChecks()
  const failed = checks.some((check) => check.status === 'fail')

  if (json) {
    // Only JSON on stdout, so the output can be piped into a parser.
    process.stdout.write(`${JSON.stringify({ ok: !failed, checks }, null, 2)}\n`)
    return failed ? 1 : 0
  }

  const symbol: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' }
  for (const check of checks) {
    process.stdout.write(`${symbol[check.status]} ${check.name.padEnd(15)} ${check.detail}\n`)
    if (check.status !== 'ok' && check.remedy) {
      process.stdout.write(`  ↳ ${check.remedy}\n`)
    }
  }

  process.stdout.write(failed
    ? '\nLoopTroop cannot run until the failures above are fixed.\n'
    : '\nThis machine can run LoopTroop.\n')

  return failed ? 1 : 0
}
