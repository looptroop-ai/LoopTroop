#!/usr/bin/env node
/**
 * Points this clone's git hooks at `.githooks/`, whose pre-push hook runs the
 * lint and typecheck the required Verify job runs. It is the `prepare` script,
 * so `npm install` and `npm ci` set it up and a fresh clone needs no extra
 * step.
 *
 * It never fails an install: the hook is a convenience for whoever pushes, and
 * every check it runs also runs in CI. It does nothing in CI, where release
 * jobs push tags and nothing should run in between; outside a git work tree;
 * and when core.hooksPath already points somewhere else, which is someone's own
 * setup and not this repository's to replace.
 */
import { existsSync, realpathSync } from 'node:fs'
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
  insideWorkTree: boolean
  /** The configured core.hooksPath, or null when unset. */
  current: string | null
}

export function planHooks(state: HookState): HookPlan {
  if (state.ci) return { action: 'skip', reason: 'CI runs no git hooks.' }
  if (!state.hooksDirExists) return { action: 'skip', reason: `there is no ${HOOKS_PATH}/ directory.` }
  if (!state.insideWorkTree) return { action: 'skip', reason: 'this is not a git work tree.' }
  if (state.current === HOOKS_PATH) return { action: 'keep' }
  if (state.current) return { action: 'skip', reason: `core.hooksPath is already ${state.current}, which is left as it is.` }
  return { action: 'set' }
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

/**
 * To stderr, never stdout: `npm pack --json` runs this script and its callers
 * parse npm's stdout as JSON, so one line there breaks `verify:package` and the
 * install smoke.
 */
function toStderr(line: string): void {
  process.stderr.write(`${line}\n`)
}

export function installGitHooks(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
  log: (line: string) => void = toStderr,
  run: GitRunner = git,
): HookPlan {
  const plan = planHooks({
    ci: Boolean(env.CI),
    hooksDirExists: existsSync(join(root, HOOKS_PATH)),
    insideWorkTree: run(['rev-parse', '--is-inside-work-tree'], root) === 'true',
    current: run(['config', '--get', 'core.hooksPath'], root) || null,
  })
  if (plan.action === 'set') {
    if (run(['config', 'core.hooksPath', HOOKS_PATH], root) === null) {
      log('git hooks: could not set core.hooksPath; lint and typecheck will not run before a push.')
      return { action: 'skip', reason: 'git config failed.' }
    }
    log(`git hooks: ${HOOKS_PATH}/pre-push now runs lint and typecheck before every push (skip one with git push --no-verify).`)
  } else if (plan.action === 'skip' && !env.CI) {
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

/** The `prepare` entry: whatever goes wrong is reported and swallowed, so `npm install` never fails here. */
export function runPrepareScript(
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

if (isMainModule()) runPrepareScript()
