#!/usr/bin/env node
/**
 * Publishes this version to the AUR.
 *
 *   node scripts/aur-push.ts --version 1.2.3 --url https://…/looptroop-1.2.3-bundle.tar.gz --sha256 …
 *
 * ## Dormant on purpose
 *
 * The AUR closed new registrations after a security incident, so there is no
 * account to push with and this has never run. It exists finished rather than
 * planned because the alternative is writing it under release pressure, months
 * from now, against a registry with no staging environment — and because
 * everything it depends on *can* be validated without an account, which
 * `smoke-aur.ts` does on every change.
 *
 * The workflow calling this skips when `AUR_SSH_KEY` is empty. It skips rather
 * than fails: a channel nobody can publish to must not be able to fail a
 * release.
 *
 * ## Why the host key is a secret rather than a constant
 *
 * Pushing over SSH to a host we have not authenticated is how a package ends up
 * somewhere it was not meant to go. The obvious fix — pinning the key in this
 * file — means shipping a fingerprint that is wrong the day the AUR rotates
 * theirs, and the failure would land during a release. So the operator supplies
 * it, having checked it against the fingerprints Arch publishes, and this
 * refuses to run without it rather than accepting whatever answers.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderAurPackage, AUR_PACKAGE_NAME } from './package-manifests.ts'

const REMOTE = `ssh://aur@aur.archlinux.org/${AUR_PACKAGE_NAME}.git`

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

const key = process.env.AUR_SSH_KEY ?? fail(
  'AUR_SSH_KEY is not set.',
  'The workflow is supposed to skip this job when it is empty rather than run it.',
)
const knownHosts = process.env.AUR_KNOWN_HOSTS ?? fail(
  'AUR_KNOWN_HOSTS is not set.',
  'Produce it with `ssh-keyscan aur.archlinux.org`, check what it returns against the',
  'fingerprints published at https://wiki.archlinux.org/title/AUR_submission_guidelines,',
  'and store it beside AUR_SSH_KEY. This will not accept an unverified host key.',
)

const version = flag('version')
const url = flag('url')
const sha256 = flag('sha256')

const work = mkdtempSync(join(tmpdir(), 'looptroop-aur-'))
const ssh = join(work, 'ssh')

function run(command: string, args: string[], options: { cwd?: string, allowFailure?: boolean } = {}): string {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Not the ambient agent or `~/.ssh`: this is the one identity that may
        // reach the AUR, and the host it may reach is the one we verified.
        GIT_SSH_COMMAND: `ssh -i ${join(ssh, 'id')} -o IdentitiesOnly=yes -o UserKnownHostsFile=${join(ssh, 'known_hosts')} -o StrictHostKeyChecking=yes`,
      },
    })
  } catch (error) {
    if (options.allowFailure === true) return ''
    const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
    fail(`${command} ${args.join(' ')} failed.`, detail)
  }
}

try {
  mkdirSync(ssh, { recursive: true, mode: 0o700 })
  // A trailing newline, because OpenSSH rejects a key file without one — and
  // the message it gives for that is "invalid format", which reads like a
  // corrupt secret rather than a missing byte.
  writeFileSync(join(ssh, 'id'), key.endsWith('\n') ? key : `${key}\n`, { mode: 0o600 })
  chmodSync(join(ssh, 'id'), 0o600)
  writeFileSync(join(ssh, 'known_hosts'), knownHosts.endsWith('\n') ? knownHosts : `${knownHosts}\n`)

  const repo = join(work, AUR_PACKAGE_NAME)
  log(`Cloning ${REMOTE}...`)
  run('git', ['clone', REMOTE, repo])

  const rendered = renderAurPackage({ version, url, sha256 })

  // Already published? A release re-run must reconcile rather than fail, and
  // the AUR rejects a push that does not advance `pkgver` anyway.
  const current = run('git', ['show', 'HEAD:.SRCINFO'], { cwd: repo, allowFailure: true })
  if (current.trim() === rendered['.SRCINFO']!.trim()) {
    log(`The AUR already carries ${AUR_PACKAGE_NAME} ${version}, byte for byte.`)
    log('Nothing to do.')
    process.exit(0)
  }
  const published = /^\tpkgver = (.+)$/m.exec(current)?.[1]
  if (published !== undefined && published !== version) {
    log(`The AUR currently carries ${published}; publishing ${version}.`)
  }

  for (const [name, contents] of Object.entries(rendered)) {
    writeFileSync(join(repo, name), contents)
  }

  run('git', ['config', 'user.name', 'looptroop-ai'], { cwd: repo })
  run('git', ['config', 'user.email', 'noreply@looptroop.ovh'], { cwd: repo })
  run('git', ['add', 'PKGBUILD', '.SRCINFO'], { cwd: repo })

  // Nothing staged means the rendering matched what is already there in every
  // byte that matters; treat it as done rather than committing an empty change.
  if (run('git', ['diff', '--cached', '--name-only'], { cwd: repo }).trim() === '') {
    log('Nothing changed. Nothing to push.')
    process.exit(0)
  }

  run('git', ['commit', '-m', `Update to ${version}`], { cwd: repo })
  run('git', ['push', 'origin', 'HEAD:master'], { cwd: repo })

  log(`\nPublished ${AUR_PACKAGE_NAME} ${version} to the AUR.`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
