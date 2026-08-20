import { parseArgs } from 'node:util'
import { APP_VERSION } from '../lib/appVersion'
import { isSea } from '../lib/isSea'
import { DAEMON_ARGV } from './daemonHandoff'
import { formatUpdateStatusNotice, getUpdateStatus, type UpdateStatus } from '../lib/updateCheck'
import { isEntryPoint } from './entryPoint'

/**
 * Exported so the published CLI reference can be generated from it rather than
 * transcribed. The documentation lives in another repository, which fetches this
 * file at a release tag and rewrites its command block from this string — so the
 * page cannot quietly fall behind a flag added here.
 */
export const USAGE = `LoopTroop — local AI coding orchestration

Usage: looptroop <command> [options]

Commands:
  open           Open the interface, starting LoopTroop if it is not running
  start          Start the daemon in the background
  stop           Stop the running daemon
  restart        Stop and start again
  status         Show whether the daemon is running
  logs           Show the daemon log
  doctor         Check that this machine can run LoopTroop
  setup          Attach a project from the terminal, then open the interface
  clean          List, and optionally remove, abandoned worktrees

Options:
  --port <n>     Port to listen on (start, restart)
  --foreground   Run in this terminal instead of the background (start)
  --opencode-logs=all
                 Include managed OpenCode DEBUG output (open, start)
  --json         Machine-readable output (status, doctor)
  --follow, -f   Keep streaming (logs)
  --lines <n>    Number of log lines to show (logs)
  --apply        Actually remove what clean would delete
  --yes, -y      Accept every default without asking (setup)
  --version      Print the version
  --help         Print this message

Run \`looptroop <command> --help\` for what a single command does and takes.
`

/**
 * Per-command help, for `looptroop <command> --help`.
 *
 * Separate from USAGE on purpose: USAGE is fetched at a release tag and rewritten
 * into the published CLI reference, so it has to stay a single scannable block.
 * The detail a person wants once they have picked a command lives here instead of
 * bloating that block to five screens.
 */
const COMMAND_HELP: Record<string, string> = {
  open: `looptroop open — open the interface

Usage: looptroop open [--print-url] [--opencode-logs=all]

Opens LoopTroop in your browser, starting the daemon first if it is not already
running, and signs the browser in with a single-use link. This is the normal way
to use LoopTroop: it is a graphical application, and one command gets you into it.

Options:
  --print-url    Print the sign-in link instead of opening a browser.
  --opencode-logs=all
                 Include full DEBUG output when LoopTroop starts OpenCode.
                 Follow it with \`looptroop logs --follow\`.

The link is normally kept out of the terminal, because the nonce in it is a live
credential. It is printed anyway when no browser could be opened, or when one was
opened and never arrived — over SSH, in WSL, on a machine with no default
browser — because a page that says "run looptroop open" is no help when open is
what just failed. Paste it into any browser on this machine.

If a daemon is already running, it is reused rather than restarted, so open is
safe to run repeatedly. The OpenCode log option then requires a stop and start.

See also: start (no browser), status (is it running).
`,
  start: `looptroop start — run the daemon in the background

Usage: looptroop start [--port <n>] [--foreground] [--opencode-logs=all]

Options:
  --port <n>     Listen on this port instead of choosing one. When the port is
                 taken, start fails rather than silently moving.
  --foreground   Run in this terminal and log to it, instead of detaching.
                 Ctrl-C stops it. Useful for watching startup, and for running
                 under a service manager that expects a foreground process.
  --opencode-logs=all
                 Include full DEBUG output when LoopTroop starts OpenCode.
                 In background mode, follow it with \`looptroop logs --follow\`.

Without --foreground the daemon detaches, survives the terminal closing, and
writes to the log that \`looptroop logs\` reads.

See also: open (start and open a browser), stop, restart, logs.
`,
  stop: `looptroop stop — stop the running daemon

Usage: looptroop stop

Asks the daemon to exit, waits for it to actually go, and reports if it did not.
Any OpenCode process LoopTroop started is stopped with it; one that was already
running when LoopTroop adopted it is left alone.
`,
  restart: `looptroop restart — stop, then start again

Usage: looptroop restart [--port <n>]

Options:
  --port <n>     Listen on this port after restarting.

The command to run after upgrading through a package manager: the running daemon
is still executing the previous version's code until it is replaced.
`,
  status: `looptroop status — is the daemon running

Usage: looptroop status [--json]

Options:
  --json         Emit a JSON document and nothing else, for scripts.

Reports whether the *installed daemon* is running, its address, port, process id
and the OpenCode it is using. Running LoopTroop from a checkout with
\`npm run dev\` is not the daemon, and is reported as not running even though a
browser can reach that development server.
`,
  logs: `looptroop logs — show the daemon log

Usage: looptroop logs [--follow] [--lines <n>]

Options:
  --follow, -f   Keep streaming as new lines are written. Ctrl-C to stop.
  --lines <n>    How many lines from the end to show. Defaults to a recent tail.

Reads the log the background daemon writes. A daemon started with --foreground
logs to its own terminal instead, and has nothing here.
`,
  doctor: `looptroop doctor — check that this machine can run LoopTroop

Usage: looptroop doctor [--json]

Options:
  --json         Emit a JSON document and nothing else, for scripts.

Checks versions, the tools LoopTroop shells out to, the configuration directory,
the database schema, how this copy was installed and how to upgrade it, whether a
daemon is running, and whether OpenCode can be reached.

Each line is marked: a tick for fine, an exclamation for something worth knowing,
a cross for something that will stop LoopTroop working. Anything not fine carries
the command that fixes it.
`,
  setup: `looptroop setup — attach a project from the terminal

Usage: looptroop setup [--yes]

Options:
  --yes, -y      Accept every default without asking.

Walks through attaching a git repository to LoopTroop, then opens the interface.
Optional: the same thing can be done inside the interface, which is where most
people do it. Reach for this when scripting a new machine, or when you are
already in the project directory.
`,
  clean: `looptroop clean — remove abandoned worktrees

Usage: looptroop clean [--apply]

Options:
  --apply        Actually delete. Without it, nothing is removed.

LoopTroop runs each ticket in its own git worktree. One left behind by an
interrupted run still occupies disk and still shows in \`git worktree list\`.

Lists what it would remove and stops. Re-run with --apply to remove it.
`,
}

/**
 * Never rejects. The lookup is a courtesy attached to commands that have their
 * own job to do, and it is started before that job runs — so a rejection would
 * otherwise surface as an unhandled rejection, which Node treats as a crash,
 * turning a clean failure into a stack trace or a working command into a dead
 * one. `getUpdateStatus` already absorbs network and cache faults; this covers
 * whatever is left.
 */
function checkCliUpdate(): Promise<UpdateStatus | null> {
  return getUpdateStatus({ currentVersion: APP_VERSION }).catch(() => null)
}

/**
 * Notices go to stderr, never stdout.
 *
 * `looptroop --version` is parsed with strict equality by the installer's own
 * post-install check (`scripts/installer-core.mjs`) and by six release smokes.
 * A notice appended to stdout makes a healthy install report as a broken one —
 * and it fires exactly when the installed version is behind the latest release,
 * which is the normal state for a pinned install and for every channel that
 * publishes after the GitHub tag. npm and gh route their notifiers to stderr
 * for the same reason.
 */
function writeUpdateNotice(update: UpdateStatus | null): void {
  if (update !== null) process.stderr.write(formatUpdateStatusNotice(update))
}

async function finishWithUpdate(code: number, update: Promise<UpdateStatus | null>): Promise<number> {
  writeUpdateNotice(await update)
  return code
}

export async function main(argv: string[]): Promise<number> {
  // Before `parseArgs`, and before anything else. Under npm this file is the
  // script Node was given; inside a single-file build it is the executable
  // itself, and in that case there is no second file to spawn — the binary has
  // to be able to become the daemon on request. One handler serves both, so
  // there is no second start implementation to keep in step.
  if (argv[0] === DAEMON_ARGV) {
    const { runDaemonProcess } = await import('./daemonProcess')
    await runDaemonProcess()
    return 0
  }

  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        port: { type: 'string' },
        foreground: { type: 'boolean' },
        json: { type: 'boolean' },
        follow: { type: 'boolean', short: 'f' },
        lines: { type: 'string' },
        apply: { type: 'boolean' },
        yes: { type: 'boolean', short: 'y' },
        'print-url': { type: 'boolean' },
        'opencode-logs': { type: 'string' },
        version: { type: 'boolean' },
        help: { type: 'boolean' },
      },
    })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return 1
  }

  const { values, positionals } = parsed
  const command = positionals[0]

  if (values.version) {
    process.stdout.write(`${APP_VERSION}\n`)
    return finishWithUpdate(0, checkCliUpdate())
  }

  // `looptroop <command> --help` describes that command; a bare `--help`, or no
  // command at all, prints the overview rather than doing something unasked.
  if (values.help) {
    const help = command === undefined ? undefined : COMMAND_HELP[command]
    if (command !== undefined && help === undefined) {
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`)
      return 1
    }
    process.stdout.write(help ?? USAGE)
    return 0
  }
  if (!command) {
    process.stdout.write(USAGE)
    return 0
  }

  const port = values.port === undefined ? undefined : Number(values.port)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    process.stderr.write(`Invalid --port "${values.port}". Expected an integer between 1 and 65535.\n`)
    return 1
  }

  const opencodeLogs = values['opencode-logs']
  if (opencodeLogs !== undefined && opencodeLogs !== 'all') {
    process.stderr.write(`Invalid --opencode-logs "${opencodeLogs}". Expected "all".\n`)
    return 1
  }

  // Imported per command so metadata commands never load the database, the
  // OpenCode client, or anything else with a startup cost.
  switch (command) {
    case 'setup': {
      const { setupCommand } = await import('./setupCommand')
      return setupCommand(values.yes === true ? { yes: true } : {})
    }
    case 'start': {
      const { startCommand } = await import('./commands')
      const update = checkCliUpdate()
      const options = {
        ...(port === undefined ? {} : { port }),
        ...(values.foreground ? { foreground: true } : {}),
        ...(opencodeLogs === 'all' ? { opencodeLogs: 'all' as const } : {}),
      }
      if (values.foreground) {
        writeUpdateNotice(await update)
        return startCommand(options)
      }
      return finishWithUpdate(await startCommand(options), update)
    }
    case 'stop': {
      const { stopCommand } = await import('./commands')
      return stopCommand()
    }
    case 'restart': {
      const { restartCommand } = await import('./commands')
      return restartCommand(port === undefined ? {} : { port })
    }
    case 'status': {
      const { statusCommand } = await import('./commands')
      // Started here, but for human output not awaited until the status itself
      // has printed: a notice must never obscure the answer that was asked for,
      // nor delay it when GitHub is slow or unreachable. JSON has to wait, since
      // the update is part of the document rather than a line after it.
      const update = checkCliUpdate()
      if (values.json === true) return statusCommand(true, await update ?? undefined)
      const code = await statusCommand(false)
      writeUpdateNotice(await update)
      return code
    }
    case 'open': {
      const { openCommand } = await import('./commands')
      const update = checkCliUpdate()
      return finishWithUpdate(
        await openCommand({
          ...(values['print-url'] === true ? { printUrl: true } : {}),
          ...(opencodeLogs === 'all' ? { opencodeLogs: 'all' as const } : {}),
        }),
        update,
      )
    }
    case 'logs': {
      const { logsCommand } = await import('./logsCommand')
      return logsCommand({
        follow: values.follow === true,
        ...(values.lines === undefined ? {} : { lines: Number(values.lines) }),
      })
    }
    case 'doctor': {
      const { doctorCommand } = await import('./doctorCommand')
      // Passed unawaited so the release lookup overlaps the local checks. Doctor
      // reports the version as one of its checks rather than as a trailing
      // notice, so unlike `status` it does have to resolve before printing.
      return doctorCommand(values.json === true, checkCliUpdate())
    }
    case 'clean': {
      const { cleanCommand } = await import('./cleanCommand')
      return cleanCommand({ apply: values.apply === true })
    }
    default: {
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`)
      return 1
    }
  }
}

// Package-manager installs call `main` from the old-syntax launcher. A source
// invocation enters this file directly, while a standalone build has no
// JavaScript entry path at all. The split also lets tests import `main` safely.
if (isEntryPoint(import.meta.url, process.argv[1]) || isSea()) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
