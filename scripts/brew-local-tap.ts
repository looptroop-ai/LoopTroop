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
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** `user/name` as brew spells a tap. */
export type TapName = `${string}/${string}`

export function tapDirectory(tap: TapName): string {
  const [user, name] = tap.split('/') as [string, string]
  const repository = execFileSync('brew', ['--repository'], { encoding: 'utf8' }).trim()
  return join(repository, 'Library', 'Taps', user, `homebrew-${name}`)
}

export function createLocalTap(tap: TapName): string {
  const directory = tapDirectory(tap)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(join(directory, 'Formula'), { recursive: true })

  // Homebrew expects a tap to be a git repository and several commands warn or
  // misbehave without one. The identity is supplied per-command so nothing has
  // to be configured on the machine, and it is never committed anywhere real.
  const git = (args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' })
  git(['init', '--quiet'])
  git(['-c', 'user.email=ci@localhost', '-c', 'user.name=ci', 'commit', '--allow-empty', '--quiet', '-m', 'local tap'])

  return directory
}

export function removeLocalTap(tap: TapName): void {
  rmSync(tapDirectory(tap), { recursive: true, force: true })
}
