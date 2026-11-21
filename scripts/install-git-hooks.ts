#!/usr/bin/env node
/**
 * Points this clone's git hooks at `.githooks/`, whose pre-push hook runs the
 * lint and typecheck the required Verify job runs. `npm run dev` runs it first
 * (`predev`), and `npm run hooks` runs it on its own.
 *
 * Not the `prepare` script: npm keeps `prepare` in the published manifest,
 * where this file is not shipped, and npm 12 then warns every user who installs
 * the package from a tarball that an install script was blocked.
 *
 * It never fails the command that runs it: the hook is a convenience for
 * whoever pushes, and every check it runs also runs in CI. It changes nothing
 * in CI; when this project is not the top of its own git work tree (a source
 * copy inside another repository must not touch that repository's settings);
 * when core.hooksPath already points somewhere else; or when `.git/hooks`
 * holds hooks of the developer's own, which setting core.hooksPath would
 * silently switch off.
 */
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execTool } from './tool-path.ts'

export const HOOKS_PATH = '.githooks'

export type HookPlan =
  | { action: 'set' }
  | { action: 'keep' }
  | { action: 'skip'; reason: string }

export interface HookState {
  ci: boolean
  hooksDirExists: boolean
  /**
   * `own`: this project's root is the top of its own git work tree. `other`:
   * it is a folder inside someone else's. `none`: git names no work tree here,
   * or could not run at all (missing, or refusing a repository it distrusts).
   */
  workTree: 'own' | 'other' | 'none'
  /** The configured core.hooksPath, or null when unset. */
  current: string | null
  /** Hooks already in git's default hooks directory, other than git's samples. */
  existingHooks: readonly string[]
}

export function planHooks(state: HookState): HookPlan {
  if (state.ci) return { action: 'skip', reason: 'CI runs no git hooks.' }
  if (!state.hooksDirExists) return { action: 'skip', reason: `there is no ${HOOKS_PATH}/ directory.` }
  if (state.workTree === 'none') return { action: 'skip', reason: 'git reports no work tree here, or could not run (see git rev-parse --show-toplevel).' }
  if (state.workTree === 'other') return { action: 'skip', reason: 'this directory is not the top of its own git work tree.' }
  if (state.current === HOOKS_PATH) return { action: 'keep' }
  if (state.current) return { action: 'skip', reason: `core.hooksPath is already ${state.current}, which is left as it is.` }
  if (state.existingHooks.length > 0) {
    return {
      action: 'skip',
      reason: `your own hooks (${state.existingHooks.join(', ')}) would stop running; to use ${HOOKS_PATH}/ anyway, run git config core.hooksPath ${HOOKS_PATH}.`,
    }
  }
  return { action: 'set' }
}

/** CI providers set CI=true (some CI=1); CI=false is the usual way to say "not CI". */
export function isCi(env: NodeJS.ProcessEnv): boolean {
  return /^(?:1|true)$/i.test(env.CI ?? '')
}

/** Runs git and returns its trimmed output, or null when it cannot start or exits non-zero. */
export type GitRunner = (args: readonly string[], cwd: string) => string | null

function git(args: readonly string[], cwd: string): string | null {
  try {
    return execTool('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

/** To stderr, so nothing that parses a command's stdout ever reads these lines. */
function toStderr(line: string): void {
  process.stderr.write(`${line}\n`)
}

/**
 * `.native`: on Windows git reports the long path (`C:/Users/runneradmin/…`)
 * while the temp directory is often its 8.3 form (`C:\Users\RUNNER~1\…`), and
 * only the native realpath expands short names. Both sides go through it.
 */
function samePath(a: string, b: string): boolean {
  try {
    return realpathSync.native(a) === realpathSync.native(b)
  } catch {
    return false
  }
}

function existingHooks(hooksDir: string): string[] {
  try {
    return readdirSync(hooksDir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && !entry.name.endsWith('.sample'))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export function installGitHooks(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = toStderr,
  run: GitRunner = git,
): HookPlan {
  const ci = isCi(env)
  const hooksDirExists = existsSync(join(root, HOOKS_PATH))
  // Asks git nothing when the answer cannot change the plan.
  const topLevel = ci || !hooksDirExists ? null : run(['rev-parse', '--show-toplevel'], root)
  const workTree = topLevel === null ? 'none' : samePath(topLevel, root) ? 'own' : 'other'
  const own = workTree === 'own'
  const current = own ? run(['config', '--get', 'core.hooksPath'], root) || null : null
  const defaultHooks = own && current === null ? run(['rev-parse', '--git-path', 'hooks'], root) : null
  const plan = planHooks({
    ci,
    hooksDirExists,
    workTree,
    current,
    existingHooks: defaultHooks === null ? [] : existingHooks(resolve(root, defaultHooks)),
  })
  if (plan.action === 'set') {
    if (run(['config', '--local', 'core.hooksPath', HOOKS_PATH], root) === null) {
      log('git hooks: could not set core.hooksPath; lint and typecheck will not run before a push.')
      return { action: 'skip', reason: 'git config failed.' }
    }
    log(`git hooks: ${HOOKS_PATH}/pre-push now runs lint and typecheck before every push (skip one with git push --no-verify).`)
  } else if (plan.action === 'skip' && !ci) {
    log(`git hooks: not installed, because ${plan.reason}`)
  }
  return plan
}

function isMainModule(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked)
  } catch {
    return import.meta.url === pathToFileURL(invoked).href
  }
}

/** Whatever goes wrong is reported and swallowed, so `npm run dev` never fails here. */
export function runHookInstaller(
  root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  install: (root: string) => unknown = installGitHooks,
  log: (line: string) => void = toStderr,
): void {
  try {
    install(root)
  } catch (error) {
    log(`git hooks: not installed (${error instanceof Error ? error.message : String(error)}).`)
  }
}

if (isMainModule()) runHookInstaller()
