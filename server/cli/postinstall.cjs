'use strict'
/**
 * The two commands to run next, printed once, after a global install.
 *
 * Deliberately quiet unless this is a *global* install: LoopTroop is a CLI, and
 * a package that greets you when it is pulled in as a dependency of something
 * else is noise. Every manager that reports a global install through the
 * environment gets the message; one that does not simply stays silent, which is
 * the right failure — a wrong message is worse than none.
 *
 * ES5 CommonJS and no imports, for the same reason `launcher.cjs` is: this runs
 * under whatever Node the machine happens to have, possibly one too old for the
 * application itself, and a SyntaxError here would fail the install.
 */

function say(line) {
  process.stdout.write(line + '\n')
}

try {
  // `npm_config_user_agent` looks like "npm/11.12.1 node/v24.15.0 linux x64" and
  // is set by npm, pnpm and Yarn Classic alike, so it identifies the manager
  // without asking any of them.
  var agent = process.env.npm_config_user_agent || ''
  var manager = agent.split('/')[0] || ''
  var isGlobal = process.env.npm_config_global === 'true'

  if (isGlobal) {
    say('')
    say('Next: looptroop doctor  - check this machine for anything missing')
    say('      looptroop open    - start LoopTroop and open it')

    // Yarn Classic links global executables into a directory it does not add to
    // PATH, so `yarn global add` reports success and then `looptroop` is not a
    // command. npm, pnpm and bun install somewhere already on PATH, so this is
    // said to Yarn users only, where it is the difference between working and
    // looking broken.
    if (manager === 'yarn') {
      say('')
      say('Yarn does not put its global binaries on PATH. If `looptroop` is not')
      say('found, add Yarn\'s bin directory to your shell profile:')
      say('')
      say('      export PATH="$(yarn global bin):$PATH"')
    }
    say('')
  }
} catch (error) {
  // Never fail an install over a greeting.
}
