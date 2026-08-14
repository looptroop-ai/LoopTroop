import { parseArgs } from 'node:util'
import { APP_VERSION } from '../lib/appVersion'
import { DAEMON_ARGV } from './daemonHandoff'

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
    return 0
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
      return startCommand({
        ...(port === undefined ? {} : { port }),
        ...(values.foreground ? { foreground: true } : {}),
      })
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
      return statusCommand(values.json === true)
    }
    case 'open': {
      const { openCommand } = await import('./commands')
      return openCommand()
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
      return doctorCommand(values.json === true)
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

main(process.argv.slice(2))
  .then((code) => { process.exitCode = code })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
