import { createInterface } from 'node:readline/promises'
import { basename } from 'node:path'
import { resolveAppConfigDir } from '../lib/appConfigDir'
import { getSettingsPath } from '../lib/appSettings'
import { getDaemonLogPath, getDaemonStatePath, type DaemonState } from '../lib/daemonPaths'
import { resolveAppDbPath } from '../db/appDbPath'
import { mintBootstrapUrl, openInBrowser, readRunningDaemon, startCommand, type BrowserLaunch } from './commands'
import type { IgnoreMode } from '../git/repository'

/** Asks one question. Returns `fallback` when the user just presses enter. */
export type SetupPrompt = (question: string, fallback: string) => Promise<string>

export interface SetupOptions {
  /** Answer every question with its default instead of asking. */
  yes?: boolean
  cwd?: string
  configDir?: string
  /** Injected by tests. `null` runs the non-interactive report. */
  prompt?: SetupPrompt | null
  out?: (text: string) => void
  /** Injected by tests so no browser is launched. */
  open?: (url: string) => BrowserLaunch | Promise<BrowserLaunch>
}

interface ProjectSummary {
  name: string
  shortname: string
  folderPath: string
}

interface ProfileDefaults {
  ignoreMode?: IgnoreMode
}

interface GitCheck {
  status?: string
  repoRoot?: string
  message?: string
}

const IGNORE_MODE_LABELS: Record<IgnoreMode, string> = {
  repo: 'added to .gitignore',
  local: 'added to .git/info/exclude',
  skip: 'left to you',
}

/**
 * What a step was asked to do and could not, or null when there is nothing to
 * report.
 *
 * Declining a step is not one of these, and neither is the report a
 * non-interactive run prints instead of asking: in both cases nothing was
 * requested, so nothing failed.
 */
type Unfinished = string | null

/**
 * Walks a new install through the three things it cannot infer: which
 * repository to work on, where its own files live, and how to reach the
 * interface.
 *
 * Every step is skippable and the whole command is re-runnable, so it is safe
 * to run again after a partial answer, on a second machine, or years later to
 * attach a second project. Nothing here verifies OpenCode: `doctor` reports on
 * it, and the daemon supervises it.
 */
export async function setupCommand(options: SetupOptions = {}): Promise<number> {
  const out = options.out ?? ((text: string) => { process.stdout.write(text) })
  const configDir = options.configDir ?? resolveAppConfigDir()
  const cwd = options.cwd ?? process.cwd()
  const session = openPrompt(options)

  try {
    out('LoopTroop setup\n\n')
    const daemon = await stepDaemon(session.prompt, out, configDir)
    const project = await stepProject(session.prompt, out, daemon.state, cwd)
    stepPaths(out, configDir)
    const browser = await stepBrowser(session.prompt, out, daemon.state, options.open ?? openInBrowser)

    const unfinished = [daemon.problem, project, browser].filter((problem) => problem !== null)
    if (unfinished.length === 0) {
      out('\nRun `looptroop setup` again at any time; it changes nothing you have not asked for.\n')
      return 0
    }

    // Non-zero, because something that was asked for did not happen. Every one
    // of these used to be printed and then reported as success, which is what
    // made `looptroop setup --yes` unusable in a provisioning script: a daemon
    // that failed to start read exactly like a clean run.
    out('\nSetup did not finish everything:\n')
    for (const problem of unfinished) out(`  - ${problem}\n`)
    out('Fix those and run `looptroop setup` again.\n')
    return 1
  } finally {
    session.close()
  }
}

/**
 * A prompt reads from the terminal, so there has to be one. Piped into a
 * script or run from CI, the command reports instead of asking, because a
 * question nobody can answer is a hang.
 */
function openPrompt(options: SetupOptions): { prompt: SetupPrompt | null; close: () => void } {
  const noop = { close: () => undefined }

  if (options.prompt !== undefined) return { prompt: options.prompt, ...noop }
  if (options.yes) return { prompt: async (_question, fallback) => fallback, ...noop }
  if (!process.stdin.isTTY) return { prompt: null, ...noop }

  const reader = createInterface({ input: process.stdin, output: process.stdout })
  return {
    prompt: async (question, fallback) => {
      const answer = (await reader.question(`${question} `)).trim()
      return answer === '' ? fallback : answer
    },
    close: () => { reader.close() },
  }
}

function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim())
}

async function stepDaemon(
  prompt: SetupPrompt | null,
  out: (text: string) => void,
  configDir: string,
): Promise<{ state: DaemonState | null; problem: Unfinished }> {
  out('1. Daemon\n')

  const running = await readRunningDaemon(configDir)
  if (running) {
    out(`   Already running on http://${running.host}:${running.port} (pid ${running.pid}).\n\n`)
    return { state: running, problem: null }
  }

  if (!prompt) {
    out('   Not running. Start it with `looptroop start`.\n\n')
    // A report, not a failed attempt: nothing here asked for it to be started.
    return { state: null, problem: null }
  }

  if (!isYes(await prompt('   Not running. Start it now? [Y/n]', 'y'))) {
    out('   Skipped. The steps below that need a daemon are skipped too.\n\n')
    return { state: null, problem: null }
  }

  // Prints its own report, including the sign-in link.
  if (await startCommand({}) !== 0) {
    return { state: null, problem: 'the daemon did not start' }
  }
  out('\n')

  const started = await readRunningDaemon(configDir)
  return started
    ? { state: started, problem: null }
    // `start` reported success and the daemon is still not answering: whatever
    // is wrong, the steps below cannot run and this is not a clean setup.
    : { state: null, problem: 'the daemon started but is not answering' }
}

async function stepProject(
  prompt: SetupPrompt | null,
  out: (text: string) => void,
  daemon: DaemonState | null,
  cwd: string,
): Promise<Unfinished> {
  out('2. Project\n')

  if (!daemon) {
    out('   Skipped: attaching a project needs a running daemon.\n\n')
    // The daemon step already reported whatever went wrong there; saying it
    // twice would turn one problem into two.
    return null
  }

  const attached = await api<ProjectSummary[]>(daemon, '/api/projects')
  if (!attached.ok || !Array.isArray(attached.body)) {
    out('   Could not read the project list from the daemon.\n\n')
    return 'the project list could not be read from the daemon'
  }
  const profile = await api<ProfileDefaults | null>(daemon, '/api/profile')
  const configuredIgnoreMode = profile.ok && profile.body && isIgnoreMode(profile.body.ignoreMode)
    ? profile.body.ignoreMode
    : 'local'

  if (!prompt) {
    out(attached.body.length > 0
      ? `   ${attached.body.length} project(s) attached.\n\n`
      : '   Nothing attached yet. Run `looptroop setup` in a terminal to attach a repository.\n\n')
    return null
  }

  if (!isYes(await prompt('   Attach a git repository? [Y/n]', 'y'))) {
    out('   Skipped.\n\n')
    return null
  }

  const folderPath = await prompt(`   Repository path [${cwd}]:`, cwd)
  const check = await api<GitCheck>(daemon, `/api/projects/check-git?path=${encodeURIComponent(folderPath)}`)
  if (!check.ok || check.body?.status !== 'valid') {
    out(`   ${check.body?.message ?? 'That folder could not be checked.'}\n`)
    out('   Nothing was attached. Fix that and run `looptroop setup` again.\n\n')
    return `${folderPath} could not be attached`
  }

  // The repository root, not the folder that was typed: attaching a subfolder
  // twice under different names is exactly the duplicate this avoids.
  const repoRoot = check.body.repoRoot ?? folderPath
  const existing = attached.body.find((project) => project.folderPath === repoRoot)
  if (existing) {
    out(`   Already attached as ${existing.name} (${existing.shortname}).\n\n`)
    return null
  }

  const name = await prompt(`   Name [${basename(repoRoot)}]:`, basename(repoRoot))
  const suggested = suggestShortname(name)
  const shortname = (await prompt(`   Short code, 3-5 letters or digits [${suggested}]:`, suggested)).toUpperCase()
  const ignoreMode = await askIgnoreMode(prompt, out, configuredIgnoreMode)

  const created = await api<{ error?: string; message?: string }>(daemon, '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, shortname, folderPath: repoRoot, ignoreMode }),
  })

  if (created.ok) {
    out(`   Attached ${name} (${shortname}); LoopTroop's files ${IGNORE_MODE_LABELS[ignoreMode]}.\n\n`)
    return null
  }

  const reason = created.body?.message ?? created.body?.error ?? `HTTP ${created.status}`
  out(`   Could not attach: ${reason}\n\n`)
  return `${name} was not attached: ${reason}`
}

/**
 * LoopTroop writes into the repository it works on, so where those rules go is
 * the user's call: .gitignore is a tracked file their colleagues will see in a
 * diff, and some repositories have a policy about it.
 */
async function askIgnoreMode(
  prompt: SetupPrompt,
  out: (text: string) => void,
  configuredDefault: IgnoreMode,
): Promise<IgnoreMode> {
  out('   LoopTroop keeps .looptroop/ and .ticket/ inside the repository.\n')
  out('     1) add them to .gitignore, shared with everyone who clones it\n')
  out('     2) add them to .git/info/exclude, this clone only\n')
  out('     3) leave git alone, the repository already handles it\n')

  const defaultChoice = configuredDefault === 'repo' ? '1' : configuredDefault === 'local' ? '2' : '3'
  const answer = (await prompt(`   Choice [${defaultChoice}]:`, defaultChoice)).trim().toLowerCase()
  if (answer === '2' || answer === 'local') return 'local'
  if (answer === '3' || answer === 'skip') return 'skip'
  return 'repo'
}

function isIgnoreMode(value: unknown): value is IgnoreMode {
  return value === 'repo' || value === 'local' || value === 'skip'
}

/** A shortname is 3-5 uppercase letters or digits; the API rejects anything else. */
export function suggestShortname(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return letters.padEnd(3, 'X').slice(0, 4)
}

function stepPaths(out: (text: string) => void, configDir: string): void {
  out('3. Where things live\n')
  out(`   Settings: ${getSettingsPath(configDir)}\n`)
  out(`   Database: ${resolveAppDbPath(configDir)}\n`)
  out(`   Log:      ${getDaemonLogPath(configDir)}\n`)
  out(`   Daemon:   ${getDaemonStatePath(configDir)}\n\n`)
}

async function stepBrowser(
  prompt: SetupPrompt | null,
  out: (text: string) => void,
  daemon: DaemonState | null,
  open: (url: string) => BrowserLaunch | Promise<BrowserLaunch>,
): Promise<Unfinished> {
  out('4. Browser\n')

  if (!daemon) {
    out('   Skipped: there is nothing to open until the daemon runs.\n')
    return null
  }

  if (!prompt) {
    out('   Run `looptroop open` for a signed-in link.\n')
    return null
  }

  if (!isYes(await prompt('   Open LoopTroop in your browser? [Y/n]', 'y'))) {
    out('   Skipped. Run `looptroop open` whenever you want it.\n')
    return null
  }

  const link = await mintBootstrapUrl(daemon)
  if (!link) {
    out('   Could not obtain a sign-in link. Run `looptroop open` to try again.\n')
    // A running daemon that will not mint a nonce leaves no way in at all.
    return 'no sign-in link could be obtained from the daemon'
  }

  const launch = await open(link.url)
  if (!launch.opened) {
    // Same reasoning as `open`: the nonce is a credential and normally stays out
    // of scrollback, but a browser that did not open leaves nothing else to go
    // on, and setup has just told the user this is how they get in.
    out(`   No browser could be opened${launch.reason === undefined ? '' : ` (${launch.reason})`}. Sign in with this link:\n`)
    out(`   ${link.url}\n`)
    return null
  }

  // The origin, never the URL: the nonce in it is a credential, and this line
  // ends up in scrollback, in screenshots and in pasted bug reports.
  out(`   Opened http://${daemon.host}:${daemon.port}\n`)
  return null
}

/** Every call carries the daemon's own bearer token; nothing here is public. */
async function api<T>(
  daemon: DaemonState,
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; body: T | null }> {
  try {
    const response = await fetch(`http://${daemon.host}:${daemon.port}${path}`, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${daemon.apiToken}` },
      signal: AbortSignal.timeout(30_000),
    })
    const body = await response.json().catch(() => null) as T | null
    return { ok: response.ok, status: response.status, body }
  } catch {
    return { ok: false, status: 0, body: null }
  }
}
