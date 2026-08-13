#!/usr/bin/env node
/**
 * Submits this version's WinGet manifests as a pull request into
 * `microsoft/winget-pkgs`.
 *
 *   node scripts/winget-submit.ts --version 1.2.3 --url https://…/looptroop-1.2.3-win-x64.zip --sha256 …
 *
 * Unlike Homebrew, Scoop and Chocolatey, this is not a write we control. It is
 * a pull request into a repository Microsoft owns, reviewed by people on their
 * schedule — so this reports a submission and never waits for an outcome, the
 * same bargain the Chocolatey job makes with moderation.
 *
 * ## Retry-safe by construction
 *
 * A re-run of a release must not open a second pull request for the same
 * version. Before pushing, this looks for an open one from our fork for this
 * exact version and stops if it finds it. The branch name is derived from the
 * version too, so a re-push updates the same branch rather than accumulating
 * new ones.
 *
 * ## Why `git` and the API rather than wingetcreate
 *
 * `wingetcreate` builds manifests by inspecting an installer and interviewing
 * the user. Ours are rendered from the release manifest by the same code that
 * renders the other three descriptors, and that property — one place decides
 * what a version's bytes are — is worth more than the convenience. So this
 * pushes files we already have and opens the pull request itself.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderWingetManifests, WINGET_IDENTIFIER, wingetManifestDir } from './package-manifests.ts'

const UPSTREAM = 'microsoft/winget-pkgs'
const FORK = 'looptroop-ai/winget-pkgs'

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function flag(name: string): string {
  const index = process.argv.indexOf(`--${name}`)
  const value = index === -1 ? undefined : process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} is required.`)
  return value
}

function run(command: string, args: string[], options: { cwd?: string, allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(command, args, { cwd: options.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (options.allowFailure === true) return ''
    const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
    fail(`${command} ${args.join(' ')} failed.`, detail)
  }
}

const token = process.env.WINGET_TOKEN ?? fail('WINGET_TOKEN is not set.')
const version = flag('version')
const url = flag('url')
const sha256 = flag('sha256')

const branch = `looptroop-${version}`
const work = mkdtempSync(join(tmpdir(), 'looptroop-winget-submit-'))

try {
  // Already open? A release re-run must reconcile rather than duplicate.
  const existing = run('gh', [
    'pr', 'list', '--repo', UPSTREAM, '--state', 'open',
    '--head', `${FORK.split('/')[0]}:${branch}`, '--json', 'number,url',
  ], { allowFailure: true }).trim()

  if (existing !== '' && existing !== '[]') {
    log(`A pull request for ${version} is already open: ${existing}`)
    log('Nothing to do; a re-run must not open a second one.')
    process.exit(0)
  }

  // A shallow clone of the fork's default branch. The repository is enormous —
  // a full history would be gigabytes for a directory of three small files.
  log(`Cloning ${FORK} (shallow)...`)
  const repo = join(work, 'winget-pkgs')
  run('git', ['clone', '--depth', '1', `https://x-access-token:${token}@github.com/${FORK}.git`, repo])

  // Reset onto upstream so the fork being stale cannot carry unrelated changes
  // into the pull request.
  run('git', ['remote', 'add', 'upstream', `https://github.com/${UPSTREAM}.git`], { cwd: repo })
  run('git', ['fetch', '--depth', '1', 'upstream', 'master'], { cwd: repo })
  run('git', ['checkout', '-B', branch, 'upstream/master'], { cwd: repo })

  const directory = join(repo, wingetManifestDir(version))
  mkdirSync(directory, { recursive: true })
  for (const [name, contents] of Object.entries(renderWingetManifests({ version, url, sha256 }))) {
    writeFileSync(join(directory, name), contents)
  }
  log(`Wrote ${wingetManifestDir(version)}`)

  run('git', ['config', 'user.name', 'looptroop-ai'], { cwd: repo })
  run('git', ['config', 'user.email', 'noreply@looptroop.ovh'], { cwd: repo })
  run('git', ['add', wingetManifestDir(version)], { cwd: repo })
  run('git', ['commit', '-m', `New version: ${WINGET_IDENTIFIER} version ${version}`], { cwd: repo })
  run('git', ['push', '--force-with-lease', 'origin', branch], { cwd: repo })

  const pr = run('gh', [
    'pr', 'create',
    '--repo', UPSTREAM,
    '--head', `${FORK.split('/')[0]}:${branch}`,
    '--base', 'master',
    '--title', `New version: ${WINGET_IDENTIFIER} version ${version}`,
    '--body', [
      `Adds ${WINGET_IDENTIFIER} ${version}.`,
      '',
      'Manifests are generated from the release manifest by the same code that',
      'renders this project\'s Homebrew, Scoop and Chocolatey descriptors, so the',
      'installer URL and checksum come from one source of truth.',
      '',
      'The installer is a portable executable in a zip; it carries its own Node',
      'runtime, so only git is declared as a dependency.',
    ].join('\n'),
  ], { cwd: repo }).trim()

  log(`\nSubmitted: ${pr}`)
  log('Acceptance is a review queue, not a result. Nothing waits on it.')
} finally {
  rmSync(work, { recursive: true, force: true })
}
