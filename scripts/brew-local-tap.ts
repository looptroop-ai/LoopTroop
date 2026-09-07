/**
 * A throwaway Homebrew tap on the local filesystem.
 *
 * Both the audit and the install proof need a formula to live in a tap — `brew`
 * will not look at one that does not — and neither may go anywhere near the
 * public tap. Built by hand rather than with `brew tap-new`, which makes an
 * initial commit and therefore fails on a runner with no `user.email`
 * configured; the two `-c` flags below make that irrelevant.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** `user/name` as brew spells a tap. */
export type TapName = `${string}/${string}`

/**
 * Proof that a tap directory was made by one of these runs and not by a person.
 *
 * `createLocalTap` starts by deleting the directory it is about to build, and
 * `removeLocalTap` deletes it again unconditionally. Both are correct for a
 * throwaway tap and destructive for anything else: a developer who happens to
 * have tapped a repository under either of these names loses it, without being
 * asked and without being told. The marker is what tells the two apart, and it
 * is checked before either destructive step.
 */
const OWNERSHIP_MARKER = '.looptroop-throwaway-tap'

export function tapDirectory(tap: TapName): string {
  const [user, name] = tap.split('/') as [string, string]
  const repository = execFileSync('brew', ['--repository'], { encoding: 'utf8' }).trim()
  return join(repository, 'Library', 'Taps', user, `homebrew-${name}`)
}

/** Whether this directory is one of ours to delete. */
export function isOwnedTap(directory: string): boolean {
  return existsSync(join(directory, OWNERSHIP_MARKER))
}

/**
 * An empty, marked tap directory at `directory`, or a refusal.
 *
 * Separated from `createLocalTap` so the ownership rule can be tested without
 * Homebrew installed: everything above it is `brew --repository`, and this is
 * the part that deletes things.
 */
export function claimTapDirectory(directory: string): void {
  // A leftover from an earlier run of this script is fine to remove; a tap
  // somebody else created under the same name is not, and there is no way to
  // ask. Refusing names the directory, so it can be moved and the run retried.
  if (existsSync(directory) && !isOwnedTap(directory)) {
    throw new Error(
      `${directory} already exists and was not created by this script. `
      + 'Refusing to delete it. Move or remove it yourself, then run this again.',
    )
  }

  rmSync(directory, { recursive: true, force: true })
  mkdirSync(join(directory, 'Formula'), { recursive: true })
  writeFileSync(
    join(directory, OWNERSHIP_MARKER),
    'Created by scripts/brew-local-tap.ts for a throwaway audit or smoke run, and safe to delete.\n',
  )
}

export function createLocalTap(tap: TapName): string {
  const directory = tapDirectory(tap)
  claimTapDirectory(directory)

  // Homebrew expects a tap to be a git repository and several commands warn or
  // misbehave without one. The identity is supplied per-command so nothing has
  // to be configured on the machine, and it is never committed anywhere real.
  const git = (args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' })
  git(['init', '--quiet'])
  git(['-c', 'user.email=ci@localhost', '-c', 'user.name=ci', 'commit', '--allow-empty', '--quiet', '-m', 'local tap'])

  return directory
}

/** Removes a tap this script created, and leaves anything else alone. */
export function removeLocalTap(tap: TapName): void {
  const directory = tapDirectory(tap)
  if (!isOwnedTap(directory)) return
  rmSync(directory, { recursive: true, force: true })
}
