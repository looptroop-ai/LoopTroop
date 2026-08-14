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
 * version — and must be able to *correct* the one that is open, which is a
 * different thing. So this finds the open pull request for this version,
 * re-renders the manifests, and pushes them to the same branch when they differ,
 * leaving it alone when they do not. Walking away on sight of an open pull
 * request, which is what this did first, made every correction to a submitted
 * manifest unreachable: the `Architecture: neutral` error was found while
 * #417030 was open and there was no way to deliver the fix.
 *
 * The branch name is derived from the version, so a re-push updates that branch
 * rather than accumulating new ones.
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

const token = process.env.WINGET_TOKEN ?? fail('WINGET_TOKEN is not set.')

/**
 * `GH_TOKEN` is set from `WINGET_TOKEN` for every child, because `gh` reads
 * that name and this job deliberately does not have the workflow's own token:
 * the pull request is opened against a repository we do not own, by a
 * credential that exists for exactly that purpose.
 */
function run(command: string, args: string[], options: { cwd?: string, allowFailure?: boolean, quiet?: true }): string
function run(command: string, args: string[], options?: { cwd?: string, allowFailure?: boolean }): string
function run(command: string, args: string[], options: { cwd?: string, allowFailure?: boolean, quiet?: true } = {}): string | null {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GH_TOKEN: token },
    })
  } catch (error) {
    // `quiet` distinguishes "this failed" from "this produced nothing", which
    // matters for a probe whose whole answer is the exit code.
    if (options.quiet === true) return null
    if (options.allowFailure === true) return ''
    const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
    fail(`${command} ${args.join(' ')} failed.`, detail)
  }
}

const version = flag('version')
/** `manifests/l/LoopTroopAI/LoopTroop` — the package, without the version. */
const identifierDir = wingetManifestDir(version).replace(/\/[^/]+$/, '')
const url = flag('url')
const sha256 = flag('sha256')

const branch = `looptroop-${version}`
const work = mkdtempSync(join(tmpdir(), 'looptroop-winget-submit-'))

try {
  // Already open? A release re-run must reconcile rather than duplicate — and
  // reconcile means *bring it up to date*, not walk away. Exiting here on sight
  // of an open pull request was wrong: it made every correction to a submitted
  // manifest unreachable. The `Architecture: neutral` mistake was found while
  // #417030 was open, and there was no way to push the fix to it.
  const existing = JSON.parse(run('gh', [
    'pr', 'list', '--repo', UPSTREAM, '--state', 'open',
    '--head', `${FORK.split('/')[0]}:${branch}`, '--json', 'number,url',
  ], { allowFailure: true }).trim() || '[]') as { number: number, url: string }[]

  const open = existing[0] ?? null
  if (open !== null) log(`A pull request for ${version} is already open: ${open.url}`)

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

  /**
   * `New package:` for the first submission of an identifier, `New version:`
   * afterwards.
   *
   * The convention is upstream's, and their own labeller applies `New-Package`
   * regardless of what we call it — which is how the mismatch showed up on
   * #417030, titled `New version:` for a package that did not exist yet.
   * Decided by asking whether the manifest directory exists on `upstream/master`
   * rather than by remembering, so this is right on the first release and every
   * one after it.
   */
  const alreadyPublished = run('git', ['cat-file', '-e', `upstream/master:${identifierDir}`], {
    cwd: repo,
    allowFailure: true,
    quiet: true,
  }) !== null
  const title = `${alreadyPublished ? 'New version' : 'New package'}: ${WINGET_IDENTIFIER} version ${version}`

  run('git', ['config', 'user.name', 'looptroop-ai'], { cwd: repo })
  run('git', ['config', 'user.email', 'noreply@looptroop.ovh'], { cwd: repo })
  run('git', ['add', wingetManifestDir(version)], { cwd: repo })

  // Against the branch the open pull request is *actually* built on, not against
  // `upstream/master` — this working tree was just reset onto master, where these
  // files do not exist yet, so a staged diff there always reports a change and
  // would never detect a no-op.
  if (open !== null && run('git', ['fetch', 'origin', branch], { cwd: repo, quiet: true }) !== null) {
    const unchanged = run('git', [
      'diff', '--quiet', `origin/${branch}`, '--', wingetManifestDir(version),
    ], { cwd: repo, quiet: true }) !== null

    if (unchanged) {
      log('The open pull request already carries exactly these manifests. Nothing to do.')
      process.exit(0)
    }
    log('The manifests have changed; updating the pull request.')
  }

  run('git', ['commit', '-m', title], { cwd: repo })
  run('git', ['push', '--force-with-lease', 'origin', branch], { cwd: repo })

  // An open pull request is updated by the push above; all that is left is to
  // make its title right, since a first submission that was opened as
  // `New version:` needs correcting in place.
  if (open !== null) {
    run('gh', ['pr', 'edit', String(open.number), '--repo', UPSTREAM, '--title', title], { allowFailure: true })
    log(`\nUpdated ${open.url}`)
    log('Acceptance is a review queue, not a result. Nothing waits on it.')
    process.exit(0)
  }

  const pr = run('gh', [
    'pr', 'create',
    '--repo', UPSTREAM,
    '--head', `${FORK.split('/')[0]}:${branch}`,
    '--base', 'master',
    '--title', title,
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
