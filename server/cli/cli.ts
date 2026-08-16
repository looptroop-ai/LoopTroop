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
  setup          Attach a project and open the interface
  start          Start the daemon in the background
  stop           Stop the running daemon
  restart        Stop and start again
  status         Show whether the daemon is running
  open           Open the interface, starting LoopTroop if it is not running
  logs           Show the daemon log
  doctor         Check that this machine can run LoopTroop
  clean          List, and optionally remove, abandoned worktrees

Options:
  --port <n>     Port to listen on (start, restart)
  --foreground   Run in this terminal instead of the background (start)
  --json         Machine-readable output (status, doctor)
  --follow, -f   Keep streaming (logs)
  --lines <n>    Number of log lines to show (logs)
  --apply        Actually remove what clean would delete
  --yes, -y      Accept every default without asking (setup)
  --version      Print the version
  --help         Print this message
`

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

  // Bare invocation prints help rather than doing something unasked.
  if (values.help || !command) {
    process.stdout.write(USAGE)
    return 0
  }

  const port = values.port === undefined ? undefined : Number(values.port)
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    process.stderr.write(`Invalid --port "${values.port}". Expected an integer between 1 and 65535.\n`)
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
      return finishWithUpdate(await openCommand(), update)
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
