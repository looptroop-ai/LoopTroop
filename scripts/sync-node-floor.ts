#!/usr/bin/env node
/**
 * Writes the Node floor from `engines.node` into every file that states it, or,
 * with `--check`, fails if any of them disagrees.
 *
 * `engines.node` is the one copy that is changed on purpose: by Renovate, which
 * raises it once a Node release is 90 days old, or by hand for a new major.
 * Everything else follows from it:
 *
 * - `package-lock.json`'s root entry, which npm would otherwise rewrite on the
 *   next install, in whatever unrelated change happened to run it;
 * - the launcher guard and both install scripts, through `sync-installers.mjs`;
 * - the Chocolatey fixture, whose `nodejs-lts` dependency is the floor;
 * - `README.md`'s prerequisite sentences — "Node X.Y.Z or newer", "Node `X.Y.Z+`"
 *   — and the Homebrew keg `node@N`, and nothing else there. The same README
 *   names the standalone builder's own Node, which a pattern for "any version
 *   of this major" would overwrite the day the floor reached that major.
 *   `tests/nodeFloor.test.ts` fails if README states the floor any other way.
 *
 * Node built-ins only, because it runs on a Renovate branch where nothing has
 * been installed, so no dependency's install script runs alongside it.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatNodeVersion, parseNodeFloor } from '../shared/nodeFloor.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const engines = (JSON.parse(read('package.json')) as { engines: Record<string, string> }).engines
const floor = parseNodeFloor(engines.node ?? '')
const label = formatNodeVersion(floor)
const stale: string[] = []

function update(path: string, next: (text: string) => string) {
  const text = read(path)
  const updated = next(text)
  if (updated === text) return
  if (check) stale.push(path)
  else writeFileSync(resolve(root, path), updated)
}

// npm writes the root entry's `engines` verbatim from package.json. Compared as
// data, so a formatting change in some future npm cannot make an unchanged floor
// look stale. When it does differ, the file is written the way npm writes it:
// two-space JSON with a trailing newline, which a round trip reproduces byte for
// byte today.
update('package-lock.json', (text) => {
  const lock = JSON.parse(text) as { packages: Record<string, { engines?: unknown }> }
  const rootEntry = lock.packages['']
  if (!rootEntry) throw new Error('package-lock.json has no root package entry.')
  if (JSON.stringify(rootEntry.engines) === JSON.stringify(engines)) return text
  rootEntry.engines = engines
  return `${JSON.stringify(lock, null, 2)}\n`
})

update('tests/fixtures/channels/looptroop.nuspec', (text) =>
  text.replace(/(<dependency id="nodejs-lts" version=")[^"]*(" \/>)/, `$1${label}$2`))

update('README.md', (text) =>
  text
    .replace(/(Node )\d+\.\d+\.\d+( or newer)/g, `$1${label}$2`)
    .replace(/(Node `)\d+\.\d+\.\d+(\+`)/g, `$1${label}$2`)
    .replace(/(`node@)\d+(`)/g, `$1${floor.major}$2`))

const installers = spawnSync(
  process.execPath,
  [resolve(root, 'scripts', 'sync-installers.mjs'), ...(check ? ['--check'] : [])],
  { cwd: root, encoding: 'utf8' },
)
if (installers.status !== 0) {
  process.stderr.write(`${installers.stdout}${installers.stderr}`)
  if (check) stale.push('scripts/install.sh', 'scripts/install.ps1', 'server/cli/launcher.cjs')
  else process.exit(1)
}

if (stale.length > 0) {
  process.stderr.write(`FAIL: these do not state the floor in engines.node (${label}):\n`)
  for (const path of stale) process.stderr.write(`  ${path}\n`)
  process.stderr.write('Run `node scripts/sync-node-floor.ts` to write it into every copy.\n')
  process.exit(1)
}

process.stdout.write(`${check ? 'PASS: every copy states' : 'Wrote'} the Node floor ${label}.\n`)
