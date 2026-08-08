import { parseArgs } from 'node:util'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = `LoopTroop — local AI coding orchestration

Usage: looptroop <command> [options]

Commands:
  setup          Attach a project and open the interface
  start          Start the daemon in the background
  stop           Stop the running daemon
  restart        Stop and start again
  status         Show whether the daemon is running
  open           Open the interface in your browser
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

function readVersion(): string {
  try {
    // dist/server/cli/cli.js -> package root is three levels up.
    const manifestPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: string }
    return manifest.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function main(argv: string[]): Promise<number> {
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
    process.stdout.write(`${readVersion()}\n`)
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
