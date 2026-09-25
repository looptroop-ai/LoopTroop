import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { getOpenCodeServeLogArgs } from '../server/lib/opencodeServeLogArgs'

function cliFixture(options: string[]) {
  const help = `opencode serve\nOptions:\n${options.map((option) => `  ${option}`).join('\n')}`
  const source = [
    'const args = process.argv.slice(1)',
    `const options = new Set(${JSON.stringify(options.map((option) => option.split(' ')[0]))})`,
    `if (args[0] === 'serve' && args[1] === '--help') { process.stdout.write(${JSON.stringify(help)}); process.exit(0) }`,
    "if (args[0] !== 'serve') process.exit(2)",
    'for (let i = 1; i < args.length; i += 1) {',
    '  if (!options.has(args[i])) { process.stderr.write(`unknown option: ${args[i]}`); process.exit(2) }',
    "  if (['--hostname', '--port', '--log-level'].includes(args[i])) i += 1",
    '}',
    '',
  ].join('\n')
  const launch = (args: string[]) => ({
    file: process.execPath,
    args: ['-e', source, ...args],
    windowsVerbatimArguments: false,
  })
  return { helpLaunch: launch(['serve', '--help']), launch }
}

describe('OpenCode serve log arguments', () => {
  it('keeps v1 log-level flags and omits them for v2', () => {
    const v1 = cliFixture(['--log-level <level>', '--print-logs', '--hostname <host>', '--port <port>'])
    const v2 = cliFixture(['--print-logs', '--hostname <host>', '--port <port>'])
    const launches = [
      { fixture: v1, mode: 'default' as const, expected: ['--log-level', 'DEBUG'] },
      { fixture: v1, mode: 'all' as const, expected: ['--print-logs', '--log-level', 'DEBUG'] },
      { fixture: v2, mode: 'default' as const, expected: [] },
      { fixture: v2, mode: 'all' as const, expected: ['--print-logs'] },
    ]

    for (const { fixture, mode, expected } of launches) {
      const logArgs = getOpenCodeServeLogArgs(mode, fixture.helpLaunch)
      expect(logArgs).toEqual(expected)
      const serverLaunch = fixture.launch(['serve', ...logArgs, '--hostname', '127.0.0.1', '--port', '4096'])
      const result = spawnSync(serverLaunch.file, serverLaunch.args, { encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }

    const rejected = v2.launch(['serve', '--log-level', 'DEBUG'])
    expect(spawnSync(rejected.file, rejected.args, { encoding: 'utf8' }).status).toBe(2)
  })
})
