import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatNodeVersion, parseNodeFloor } from '../shared/nodeFloor'

const LAUNCHER = resolve(process.cwd(), 'server/cli/launcher.cjs')

const FLOOR = parseNodeFloor(
  (JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
    engines: { node: string }
  }).engines.node,
)
const FLOOR_LABEL = formatNodeVersion(FLOOR)

/** The guard half of the launcher, with the shebang stripped so `node -e` accepts it. */
function readGuardSource(): string {
  const source = readFileSync(LAUNCHER, 'utf8')
  const guard = source.split("import('./cli.js')")[0] ?? ''
  return guard.replace(/^#![^\n]*\n/, '')
}

function runGuard(
  nodeVersion: string,
  trailer = '',
  platform?: NodeJS.Platform,
): { stdout: string; stderr: string; exitCode: number } {
  const script = [
    `Object.defineProperty(process.versions, "node", { value: "${nodeVersion}", configurable: true });`,
    ...(platform ? [`Object.defineProperty(process, "platform", { value: "${platform}", configurable: true });`] : []),
    readGuardSource(),
    trailer,
  ].join('\n')

  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { stdout, stderr: '', exitCode: 0 }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.status ?? 0 }
  }
}

/**
 * 2.9 contract: the bin entry must run on a Node too old to parse the real CLI,
 * so it stays ES5 CommonJS and checks the version before importing anything.
 */
describe('cli launcher', () => {
  it('exists at the path package.json points bin at', () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as {
      bin?: Record<string, string>
    }

    expect(manifest.bin?.looptroop).toBe('dist/server/cli/launcher.cjs')
    expect(existsSync(LAUNCHER)).toBe(true)
  })

  it('starts with a shebang so a shell can execute it directly', () => {
    const source = readFileSync(LAUNCHER, 'utf8')
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('parses under an ES5 syntax target', () => {
    const source = readFileSync(LAUNCHER, 'utf8')

    // A version check that cannot be parsed by the runtime it is guarding would
    // produce a SyntaxError instead of the intended message.
    expect(source).not.toMatch(/\bconst\b|\blet\b|=>|\?\?|\?\./)
    expect(source).toMatch(/\bvar\b/)
  })

  it('rejects an unsupported runtime before importing the CLI', () => {
    const result = runGuard('22.9.0')

    expect(result.exitCode).toBe(1)
    // The exact floor, patch level included. The guard used to compare major
    // and minor only and print the floor's major.minor with a zero patch, so a
    // user on 24.18.0 was refused by a message naming 24.18.0.
    expect(result.stderr).toContain(`requires Node.js ${FLOOR_LABEL} or newer`)
    expect(result.stderr).toContain('22.9.0')
  })

  it('accepts exactly the floor', () => {
    expect(runGuard(FLOOR_LABEL, 'process.stdout.write("passed");').stdout).toBe('passed')
  })

  it('accepts the patch just above the floor', () => {
    const justAbove = formatNodeVersion({ ...FLOOR, patch: FLOOR.patch + 1 })
    expect(runGuard(justAbove, 'process.stdout.write("passed");').stdout).toBe('passed')
  })

  /**
   * The case the old major.minor comparison got wrong in both directions: it
   * accepted this runtime and then told anyone it refused to install it.
   */
  it('rejects the patch just below the floor', () => {
    const justBelow = FLOOR.patch > 0
      ? formatNodeVersion({ ...FLOOR, patch: FLOOR.patch - 1 })
      : formatNodeVersion({ ...FLOOR, minor: FLOOR.minor - 1, patch: 99 })
    expect(runGuard(justBelow).exitCode).toBe(1)
  })

  it('accepts a newer major', () => {
    expect(runGuard(`${FLOOR.major + 1}.0.0`, 'process.stdout.write("passed");').stdout).toBe('passed')
  })

  it('rejects a same-major but older minor', () => {
    expect(runGuard(`${FLOOR.major}.${FLOOR.minor - 1}.99`).exitCode).toBe(1)
  })

  /**
   * A prerelease of the floor is below the floor, which is how npm reads
   * `engines.node` and therefore the only reading that agrees with whatever
   * installed the runtime. The comparison waved `24.18.1-rc.1` through because
   * the three numbers matched, so a nightly missing the fix the floor exists for
   * started the app and failed later, somewhere unrelated.
   */
  it('rejects a prerelease of the floor', () => {
    expect(runGuard(`${FLOOR_LABEL}-rc.1`).exitCode).toBe(1)
  })

  it('accepts a prerelease of a version above the floor', () => {
    const above = `${FLOOR.major + 1}.0.0-nightly20260101`
    expect(runGuard(above, 'process.stdout.write("passed");').stdout).toBe('passed')
  })

  /**
   * The refusal is the only thing a user on an old Node ever sees from
   * LoopTroop, so it has to name a way forward that exists on their machine.
   * It named nvm unconditionally, which is not how anyone installs Node on
   * Windows and not how most people do on macOS.
   */
  it.each([
    ['darwin' as const, `brew install node@${FLOOR.major}`],
    ['win32' as const, 'winget install OpenJS.NodeJS.LTS'],
    ['linux' as const, 'nvm'],
  ])('tells a %s user how to install Node', (platform, hint) => {
    const result = runGuard('22.9.0', '', platform)

    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain(hint)
    // Always offered as well: a package manager is not always an option.
    expect(result.stderr).toContain('https://nodejs.org/')
  })

  /**
   * §11.5: the floor was written by hand in five places with three different
   * answers. `engines.node` is the only one left; these constants are generated
   * from it by `scripts/sync-installers.mjs`, and this is what catches a drift
   * between releases — `installers:check` runs only in the release workflow.
   */
  it('enforces the floor package.json declares', () => {
    const source = readFileSync(LAUNCHER, 'utf8')
    expect({
      major: Number(/var REQUIRED_MAJOR = (\d+)/.exec(source)?.[1]),
      minor: Number(/var REQUIRED_MINOR = (\d+)/.exec(source)?.[1]),
      patch: Number(/var REQUIRED_PATCH = (\d+)/.exec(source)?.[1]),
      // The generated block carries three numbers; a floor is never itself a
      // prerelease, and `parseNodeFloor` says so.
      prerelease: FLOOR.prerelease,
    }).toEqual(FLOOR)
    expect(FLOOR.prerelease).toBe(false)
  })
})
