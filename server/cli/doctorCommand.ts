import { execFileSync } from 'node:child_process'
import { existsSync, accessSync, constants } from 'node:fs'
import { resolveAppConfigDir } from '../lib/appConfigDir'
import { resolveSettings, getSettingsPath } from '../lib/appSettings'
import { resolveInstallInfo } from '../lib/installChannel'
import { summarizeUpdateStatus, type UpdateStatus } from '../lib/updateCheck'
import { getLatestToolVersions } from '../lib/toolVersions'
import { isDevStackRunning } from '../lib/devStack'
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

/**
 * The install facts behind the install check, for `--json` consumers.
 *
 * Same reasoning as `SchemaFacts`, learned the same way: the packaging smokes
 * used to read the channel and the upgrade command by parsing `detail`, so
 * rewording that sentence broke eight of them at once. A script asking "which
 * channel is this, and what upgrades it" reads these fields; `detail` is free to
 * be whatever reads best to a person.
 */
interface InstallFacts {
  channel: string
  upgradeCommand: string
  upgradeFirst?: string
  postUpgradeCommand?: string
  upgradeNote?: string
}

interface Check {
  /**
   * The stable identifier, and what `--json` reports.
   *
   * Scripts key on this — the repository's own install smoke asserts on
   * `install`, and users' scripts do the same — so it is an interface, not a
   * caption. Rename it and every consumer breaks silently. Use `label` to change
   * what a person reads.
   */
  name: string
  /** What the human-readable report prints instead of `name`, when they differ. */
  label?: string
  status: Status
  detail: string
  /**
   * Something is not installed at all, as opposed to installed and unhappy.
   *
   * Purely a display distinction: absent things print `✗` and degraded ones `!`,
   * because "gh is missing" and "gh is not signed in" are different problems and
   * a single `!` for both makes the list harder to scan. It does **not** change
   * `status`, so which checks fail — and therefore doctor's exit code, which
   * scripts gate on — is exactly what it was.
   */
  missing?: boolean
  /**
   * An extra line printed under the detail, whatever the status.
   *
   * `remedy` appears only when something is wrong, which is right for a fix but
   * wrong for a fact that is useful precisely when everything is fine — the
   * upgrade command being the case in point.
   */
  note?: string
  /** Shown only when the check is not ok. */
  remedy?: string
  /** Present on the schema checks only. */
  schema?: SchemaFacts
  /** Present on the install check only. */
  install?: InstallFacts
}

const REQUIRED_NODE_MAJOR = 24
const REQUIRED_NODE_MINOR = 15

/**
 * Bold, but only on a terminal.
 *
 * `doctor` output is piped into files and issues at least as often as it is read
 * live, and escape codes in a pasted log are worse than no emphasis.
 */
function bold(text: string): string {
  return process.stdout.isTTY === true ? `[1m${text}[22m` : text
}

/**
 * "1.2.3 (latest 1.2.4)" — always both, with the current version emphasised when
 * it is behind.
 *
 * Shown even when the two match, because "you are on the newest" is the answer
 * to the question being asked, and a line that omits it leaves the reader unsure
 * whether the check ran at all. The emphasis, not the presence of the number,
 * is what marks the ones worth acting on.
 */
function withLatest(current: string, latest: string | null): string {
  if (latest === null || latest === '') return `${current} (latest unknown)`
  const behind = current.replace(/^v/, '') !== latest.replace(/^v/, '')
  return `${behind ? bold(current) : current} (latest ${latest})`
}

/** Pulls `1.2.3` out of `git version 2.47.3` or `gh version 2.97.0 (2026-07-31)`. */
function versionIn(text: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(text)?.[1] ?? null
}

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
 *
 * Through a shell on Windows, because half the tools doctor asks about are not
 * `.exe` files. `CreateProcess` appends only `.exe` and never reads `PATHEXT`,
 * so a bare `npm` — which ships as `npm.cmd` — is invisible to it, and naming
 * the shim outright does not help either: Node has refused to launch `.cmd` and
 * `.bat` directly since the BatBadBut hardening (18.20.2/20.12.2/21+) and
 * throws `EINVAL`. That is why doctor called npm missing on a machine where npm
 * works, and it would have said the same about an npm-installed OpenCode.
 *
 * Only ever called with literal arguments, which is what makes routing through
 * cmd.exe safe: it re-parses the command line, so anything derived from a path
 * or from user input would have to be quoted first.
 */
export function runProbe(command: string, args: string[], timeoutMs: number): ProbeResult {
  const started = Date.now()
  try {
    const output = execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: timeoutMs,
      shell: process.platform === 'win32',
    })
    return { kind: 'ok', output }
  } catch (error) {
    // A command that was found and then hung is a different problem from one
    // that is not installed, and the install hint would be wrong advice.
    //
    // Missing still lands here under a shell, by a different route: cmd.exe
    // starts perfectly well and exits 9009 with "is not recognized", which
    // execFileSync raises as a non-zero exit rather than as `ENOENT`.
    //
    // The deadline is recognised by how long this took, not only by `ETIMEDOUT`,
    // because under a shell that code does not arrive: the deadline kills
    // cmd.exe, and what surfaces is an ordinary non-zero exit from the wrapper.
    // Relying on the code alone reported every hung probe on Windows as a
    // missing one — telling someone to install a tool they already have, which
    // is the exact confusion this branch exists to prevent.
    const elapsed = Date.now() - started
    return (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || elapsed >= timeoutMs
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

function checkNode(latest: string | null = null): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const supported = major > REQUIRED_NODE_MAJOR
    || (major === REQUIRED_NODE_MAJOR && minor >= REQUIRED_NODE_MINOR)

  return supported
    ? { name: 'node', status: 'ok', detail: withLatest(`v${process.versions.node}`, latest) }
    : {
        name: 'node',
        status: 'fail',
        detail: withLatest(`v${process.versions.node}`, latest),
        remedy: `LoopTroop needs Node ${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}.0 or newer. Install it with nvm: nvm install ${REQUIRED_NODE_MAJOR}`,
      }
}

/**
 * npm, which the engines floor names and which the npm-channel upgrade command
 * is run with — by the reader, not by LoopTroop, which only ever prints it. A
 * too-old or unreachable npm is worth seeing before that command fails rather
 * than after.
 */
function checkNpm(latest: string | null = null): Check {
  const probe = runProbe('npm', ['--version'], PROBE_TIMEOUT_MS)
  if (probe.kind === 'timed-out') {
    return { status: 'warn', ...timedOutCheck('npm', 'npm --version', PROBE_TIMEOUT_MS) }
  }
  if (probe.kind !== 'ok') {
    return {
      name: 'npm',
      status: 'warn',
      missing: true,
      detail: 'not found on PATH',
      remedy: 'npm ships with Node. A Node installed without it cannot run the npm upgrade path.',
    }
  }

  const current = probe.output.trim().split('\n')[0] ?? 'present'
  return { name: 'npm', status: 'ok', detail: withLatest(current, latest) }
}

function checkBinary(
  name: string,
  args: string[],
  required: boolean,
  latest: string | null = null,
): Check {
  const probe = runProbe(name, args, PROBE_TIMEOUT_MS)
  if (probe.kind === 'ok') {
    const line = probe.output.trim().split('\n')[0] ?? 'present'
    // The tools print a sentence, not a version. Compare the number inside it
    // and show that, so `git version 2.47.3` reads as `2.47.3 (latest 2.55.0)`.
    const found = versionIn(line)
    return { name, status: 'ok', detail: found === null ? line : withLatest(found, latest) }
  }

  if (probe.kind === 'timed-out') {
    // Installed, and stuck. Whether that is fatal is the same question as for a
    // missing one: git is not optional, gh is.
    return { status: required ? 'fail' : 'warn', ...timedOutCheck(name, `${name} ${args.join(' ')}`, PROBE_TIMEOUT_MS) }
  }

  return {
    name,
    status: required ? 'fail' : 'warn',
    missing: true,
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
function checkOpenCodeVersion(latest: string | null = null): Check {
  if (resolveSettings().opencodeMode === 'mock') {
    return { name: 'opencode cli', status: 'ok', detail: 'not needed in mock mode' }
  }

  const probe = runProbe('opencode', ['--version'], PROBE_TIMEOUT_MS)
  if (probe.kind === 'ok') {
    const line = probe.output.trim().split('\n')[0] || 'present'
    const found = versionIn(line) ?? line
    return { name: 'opencode cli', status: 'ok', detail: withLatest(found, latest) }
  }

  if (probe.kind === 'timed-out') {
    return { status: 'warn', ...timedOutCheck('opencode cli', 'opencode --version', PROBE_TIMEOUT_MS) }
  }

  return {
    name: 'opencode cli',
    status: 'warn',
    missing: true,
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

/**
 * Whether the Vite dev server is up, which is how a checkout serves the
 * interface without ever registering a daemon.
 *
 * Probed by binding rather than by reading a process list: the port is the thing
 * that actually matters, and it is the same test the port check already trusts.
 */
async function checkDaemon(daemon: DaemonState | null): Promise<Check> {
  if (daemon) {
    return {
      name: 'daemon',
      status: 'ok',
      detail: `running on http://${daemon.host}:${daemon.port} (pid ${daemon.pid})`,
    }
  }

  // "Not running" while the interface is plainly open in a browser is the most
  // confusing thing doctor can say, and it happens to everyone working from a
  // checkout: `npm run dev` serves the interface from Vite and never registers a
  // daemon, so there is genuinely no daemon to report. Say which of the two this
  // is rather than leaving the reader to doubt the tool.
  if (await isDevStackRunning()) {
    return {
      name: 'daemon',
      status: 'ok',
      detail: 'not running — a development server is serving the interface instead',
      note: 'This reports the installed daemon. `npm run dev` serves the interface itself and registers no daemon.',
    }
  }

  return { name: 'daemon', status: 'ok', detail: 'not running' }
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
        detail: `database predates LoopTroop ${schema.SCHEMA_VERSIONING_SINCE} and carries no version marker`,
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
      // "version 1" alone reads as a version of LoopTroop. Name what it counts,
      // and where, so the number means something to whoever is reading it.
      return {
        name: 'schema',
        status: 'ok',
        detail: `database schema v${schema.APP_SCHEMA_VERSION}, matching this LoopTroop`,
        note: facts.databasePath,
        schema: facts,
      }
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
    // Reworded from "no refused start recorded", which read as an empty value
    // rather than as good news. This check only ever reports a *refusal*, so
    // when there is none the useful thing to say is that nothing went wrong.
    // Named for what it reports. This check only ever surfaces a start that was
    // *refused* — there is no record of successful starts to report a time from
    // — and calling it "last start" invited the reasonable reading that it would
    // show when LoopTroop last started, which it cannot.
    return { name: 'last start', label: 'start failures', status: 'ok', detail: 'none recorded' }
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
  const steps = [info.upgradeFirst, info.upgradeCommand, info.postUpgradeCommand]
    .filter((command): command is string => command !== undefined)
    .join(', then ')
  return info.channel === 'unknown'
    ? {
        name: 'install',
        status: 'warn',
        detail: 'could not determine how LoopTroop was installed',
        // A wrong upgrade command is worse than none, so this stays a warning.
        remedy: `${info.upgradeCommand}. To settle it, set "install": { "channel": "npm" } in ${getSettingsPath()}.`,
      }
    : {
        name: 'install',
        label: 'install method',
        status: 'ok',
        detail: info.channel,
        install: {
          channel: info.channel,
          upgradeCommand: info.upgradeCommand,
          ...(info.upgradeFirst === undefined ? {} : { upgradeFirst: info.upgradeFirst }),
          ...(info.postUpgradeCommand === undefined ? {} : { postUpgradeCommand: info.postUpgradeCommand }),
          ...(info.upgradeNote === undefined ? {} : { upgradeNote: info.upgradeNote }),
        },
        // On its own line rather than parenthesised after the channel: this is
        // the command a person came to `doctor` to copy, and burying it inside
        // a sentence next to the channel name made it hard to find and easy to
        // mistype. `note` prints under the detail even when the check is fine.
        note: `upgrade: ${steps}${info.upgradeNote ? ` — ${info.upgradeNote}` : ''}`,
      }
}

/**
 * Re-checks the ignore choice made at attach time, since a repository's
 * .gitignore can be rewritten by anyone long after the project was added.
 */
async function checkProjectIgnores(): Promise<Check> {
  const { APP_DB_PATH } = await import('../db/index')
  if (!existsSync(APP_DB_PATH)) {
    return { name: 'project ignores', label: 'git ignores', status: 'ok', detail: 'no projects attached yet' }
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
    return { name: 'project ignores', label: 'git ignores', status: 'ok', detail: 'skipped, database unreadable' }
  }

  if (rows.length === 0) {
    return { name: 'project ignores', label: 'git ignores', status: 'ok', detail: 'no projects attached yet' }
  }

  const unignored = rows
    .filter((row) => existsSync(row.folderPath) && !areLoopTroopPathsIgnored(row.folderPath))
    .map((row) => row.folderPath)

  return unignored.length === 0
    ? {
        name: 'project ignores',
        label: 'git ignores',
        status: 'ok',
        // Says what is being ignored and why anyone should care. LoopTroop puts
        // its worktrees and per-ticket state inside each attached repository, so
        // a repo that does not ignore those paths will offer them up as changes
        // to commit.
        detail: `LoopTroop's worktrees and state are git-ignored in ${rows.length} project(s)`,
      }
    : {
        name: 'project ignores',
        label: 'git ignores',
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
  // Started first and awaited late: it is a cached network read, and the local
  // probes below should not queue behind it. It never rejects and never blocks
  // longer than one timeout, so the worst case is versions shown without a
  // "latest" beside them.
  const latest = getLatestToolVersions()
  const resolved = await latest
  // Run before the server check, which needs its verdict: an unreachable
  // OpenCode is survivable only when there is a binary left to start one.
  const opencodeCli = checkOpenCodeVersion(resolved.opencode)

  return [
    checkNode(resolved.node),
    checkNpm(resolved.npm),
    checkBinary('git', ['--version'], true, resolved.git),
    checkBinary('gh', ['--version'], false, resolved.gh),
    checkGitHubAuth(),
    checkConfigDir(),
    checkInstallChannel(),
    await checkSchema(),
    await checkLastStart(),
    await checkProjectIgnores(),
    opencodeCli,
    await checkOpenCode(daemon, opencodeCli.status === 'ok'),
    await checkPort(daemon),
    await checkDaemon(daemon),
  ]
}

function versionCheck(update: UpdateStatus): Check {
  // Formatted like every other version on the report, so the whole list reads
  // one way: both numbers always, the current one emphasised only when behind.
  const detail = withLatest(update.currentVersion, update.latestVersion)
  if (!update.updateAvailable) return { name: 'version', label: 'looptroop', status: 'ok', detail }

  const commands = [update.upgradeFirst, update.upgradeCommand, update.postUpgradeCommand]
    .filter((command): command is string => command !== undefined)
    .map((command) => `\`${command}\``)
    .join(', then ')
  return {
    name: 'version',
    label: 'looptroop',
    // `warn`, so it prints `!` — a newer release is worth noticing and is not a
    // failure. Nothing on this machine is broken by being one version behind.
    status: 'warn',
    detail,
    remedy: `${commands}.${update.upgradeNote ? ` ${update.upgradeNote}` : ''}`,
  }
}

/**
 * `update` may be a promise so the caller can start the release lookup before
 * the local checks run and let the two overlap. Awaiting a plain value is
 * harmless, so direct callers can still pass a resolved status.
 */
export async function doctorCommand(
  json: boolean,
  update?: UpdateStatus | null | Promise<UpdateStatus | null>,
): Promise<number> {
  const checks = await runChecks()
  const resolved = (await update) ?? undefined
  const displayedChecks = resolved === undefined ? checks : [versionCheck(resolved), ...checks]
  const failed = checks.some((check) => check.status === 'fail')

  if (json) {
    // Only JSON on stdout, so the output can be piped into a parser.
    process.stdout.write(`${JSON.stringify({
      ok: !failed,
      ...(resolved === undefined ? {} : { update: summarizeUpdateStatus(resolved) }),
      checks: displayedChecks,
    }, null, 2)}\n`)
    return failed ? 1 : 0
  }

  const symbol: Record<Status, string> = { ok: '✓', warn: '!', fail: '✗' }
  for (const check of displayedChecks) {
    // Absent beats degraded: a missing tool reads as `✗` whatever its severity,
    // so "not installed" and "installed but unhappy" are told apart at a glance.
    const mark = check.missing === true ? '✗' : symbol[check.status]
    process.stdout.write(`${mark} ${(check.label ?? check.name).padEnd(15)} ${check.detail}\n`)
    if (check.note) {
      process.stdout.write(`  ↳ ${check.note}\n`)
    }
    if (check.status !== 'ok' && check.remedy) {
      process.stdout.write(`  ↳ ${check.remedy}\n`)
    }
  }

  process.stdout.write(failed
    ? '\nLoopTroop cannot run until the failures above are fixed.\n'
    : '\nThis machine can run LoopTroop.\n')

  return failed ? 1 : 0
}
