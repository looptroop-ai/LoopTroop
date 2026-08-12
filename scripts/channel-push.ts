#!/usr/bin/env node
/**
 * Publishes a descriptor to a package channel's repository.
 *
 *   node scripts/channel-push.ts --channel homebrew \
 *     --repo looptroop-ai/homebrew-looptroop --version 9.9.9 \
 *     --url https://…/looptroop-9.9.9-bundle.tar.gz --sha256 … [--force] [--dry-run]
 *
 * Through the contents API rather than a clone and a push, for one reason: the
 * API takes the blob SHA the file had when it was read and rejects the write if
 * it has changed. A tap is a repository other people can also push to, and
 * `git push --force` after a read is exactly the race that silently loses
 * somebody else's change.
 *
 * What to do about whatever is already published is decided in
 * `channel-state.ts`, which is pure and tested. This reads, calls it, and does
 * as it says.
 */
import { execFileSync } from 'node:child_process'
import type { Channel } from './package-manifests.ts'
import { DESCRIPTOR_PATH, parseDescriptor, renderDescriptor } from './package-manifests.ts'
import { decideChannelWrite, writes } from './channel-state.ts'

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function flag(name: string, required = true): string | null {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) {
    if (required) fail(`--${name} is required.`)
    return null
  }
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value.`)
  return value
}

const channel = flag('channel') as Channel
if (!(channel in DESCRIPTOR_PATH)) fail(`--channel must be one of ${Object.keys(DESCRIPTOR_PATH).join(', ')}.`)

const repo = flag('repo')!
const version = flag('version')!
const url = flag('url')!
const sha256 = flag('sha256')!
const force = process.argv.includes('--force')
const dryRun = process.argv.includes('--dry-run')
const path = DESCRIPTOR_PATH[channel]

function gh(args: string[], allowFailure = false): string {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    if (allowFailure) return ''
    const detail = error instanceof Error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
    // Never the arguments: a `gh api` invocation carries no secret, but the
    // habit of echoing a failed command's full argv is how tokens end up in
    // logs elsewhere.
    fail(`gh ${args[0]} ${args[1] ?? ''} failed.`, detail.trim())
  }
}

/**
 * Fails now, loudly, rather than halfway through a release.
 *
 * A token that has expired or lost a scope produces a 404 on the read below,
 * which is indistinguishable from "this channel has nothing published yet" —
 * and that mistake publishes a first version over an existing one.
 */
function preflight(): void {
  const probe = gh(['api', `repos/${repo}`, '--jq', '.permissions.push'], true).trim()
  if (probe !== 'true') {
    fail(
      `The token cannot push to ${repo}.`,
      probe === '' ? 'The repository did not answer; the token may be expired or missing a scope.' : `push permission: ${probe}`,
    )
  }
  log(`Token can push to ${repo}.`)
}

interface RemoteFile { text: string, blobSha: string }

function readRemote(): RemoteFile | null {
  const raw = gh(['api', `repos/${repo}/contents/${path}`, '--jq', '{content: .content, sha: .sha}'], true).trim()
  if (raw === '') return null

  const parsed = JSON.parse(raw) as { content?: string, sha?: string }
  if (typeof parsed.content !== 'string' || typeof parsed.sha !== 'string') return null

  return { text: Buffer.from(parsed.content, 'base64').toString('utf8'), blobSha: parsed.sha }
}

preflight()

const desired = { version, url, sha256 }
const descriptor = renderDescriptor(channel, desired)
const remote = readRemote()
const decision = decideChannelWrite(desired, remote === null ? null : parseDescriptor(channel, remote.text), { force })

log(`${channel}: ${decision.action} — ${decision.reason}`)

if (decision.action === 'refuse' || decision.action === 'conflict') {
  fail(
    `Refusing to write ${version} to ${repo}: ${decision.reason}`,
    ...('differences' in decision ? decision.differences : []),
    decision.action === 'conflict'
      ? 'If this is a repair of a descriptor that was published wrong, dispatch the repair workflow with the force option.'
      : 'Nothing was changed.',
  )
}

if (!writes(decision)) {
  log('Nothing to do.')
  process.exit(0)
}

if (dryRun) {
  log(`Dry run: would write ${path} to ${repo}.\n`)
  process.stdout.write(descriptor)
  process.exit(0)
}

const body: Record<string, string> = {
  message: `looptroop ${version}`,
  content: Buffer.from(descriptor, 'utf8').toString('base64'),
}
// Present only when replacing: the API takes it as the compare-and-swap token
// and rejects the write if the file changed since it was read.
if (remote !== null) body.sha = remote.blobSha

gh([
  'api', '--method', 'PUT', `repos/${repo}/contents/${path}`,
  ...Object.entries(body).flatMap(([key, value]) => ['-f', `${key}=${value}`]),
  '--jq', '.commit.sha',
])

log(`Wrote ${path} to ${repo}.`)
