#!/usr/bin/env node
/**
 * Publishes a descriptor to a package channel's repository.
 *
 *   node scripts/channel-push.ts --channel homebrew \
 *     --repo looptroop-ai/homebrew-looptroop --version 1.2.3 \
 *     --url https://github.com/looptroop-ai/LoopTroop/releases/download/v1.2.3/looptroop-1.2.3-bundle.tar.gz \
 *     --sha256 … [--force] [--dry-run]
 *
 * `--repo` is where the descriptor is *written* — a tap or a bucket. Where the
 * bytes users download come from is not an argument at all; `--url` is checked
 * against this project's release for `--version` and nothing else. The example
 * above used to read `--version 9.9.9` with an elided URL, and on 2026-09-14
 * somebody ran it: those placeholders became the live Scoop descriptor.
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
import { checkDescriptorUrl, decideChannelWrite, writes } from './channel-state.ts'
import { resolveTrustedTool } from './trusted-tool.ts'
import { ArgumentError, parseArgs, requireNoPositional } from './cli-args.ts'

function fail(message: string, ...detail: string[]): never {
  process.stderr.write(`::error::${message}\n`)
  for (const line of detail) process.stderr.write(`  ${line}\n`)
  process.exit(1)
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

const USAGE = 'Usage: node scripts/channel-push.ts --channel <homebrew|scoop> --repo <tap-or-bucket> --version X.Y.Z --url <release asset URL for that version> --sha256 <hex> [--force] [--dry-run]'

// Through the shared parser, like every other release script. The hand-rolled
// version ignored unknown flags, so a typo on a job holding a write token ran
// the default behaviour — and `--force`, the one power this script is careful
// about, was read with `includes`, which a misspelling silently turns off.
const args = (() => {
  try {
    const parsed = parseArgs(process.argv.slice(2), {
      channel: 'value',
      repo: 'value',
      version: 'value',
      url: 'value',
      sha256: 'value',
      force: 'switch',
      'dry-run': 'switch',
    })
    requireNoPositional(parsed)
    return parsed
  } catch (error) {
    if (!(error instanceof ArgumentError)) throw error
    fail(error.message, USAGE)
  }
})()

function flag(name: string): string {
  const value = args.value(name)
  if (value === null) fail(`--${name} is required.`, USAGE)
  return value
}

const channel = flag('channel') as Channel
if (!(channel in DESCRIPTOR_PATH)) fail(`--channel must be one of ${Object.keys(DESCRIPTOR_PATH).join(', ')}.`)

const repo = flag('repo')
const version = flag('version')
const url = flag('url')
const sha256 = flag('sha256')
const force = args.switch('force')
const dryRun = args.switch('dry-run')
const path = DESCRIPTOR_PATH[channel]

/**
 * `gh`, resolved once from a directory the runner owns.
 *
 * This script runs with a token that can write to the Homebrew tap and the
 * Scoop bucket, so which program receives it is not something to leave to
 * whichever directory happens to come first on PATH. Same helper, and same
 * reasoning, as `release-draft.ts`.
 */
const ghPath = (() => {
  const resolved = resolveTrustedTool('gh')
  if ('refusal' in resolved) fail('Cannot run gh safely.', resolved.refusal)
  return resolved.path
})()

function gh(args: string[], allowFailure = false): string {
  try {
    return execFileSync(ghPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
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
 * Says what the token can do before anything is decided from what it can read.
 *
 * A token that has expired or lost a scope answers 404 to the read below, which
 * looks exactly like "this channel has nothing published yet". The contents API
 * refuses to replace an existing file without its blob SHA, so that mistake
 * cannot actually overwrite anything — but it can produce a baffling failure
 * halfway through a release, and this names the cause up front.
 *
 * A denial is fatal; silence is not. Not every token shape reports
 * `permissions` on a repository, and refusing to publish because a field was
 * absent would block a release over a diagnostic.
 */
function preflight(): void {
  const probe = gh(['api', `repos/${repo}`, '--jq', '.permissions.push'], true).trim()

  if (probe === 'false') {
    fail(`The token cannot push to ${repo}.`, 'It is valid but read-only for this repository.')
  }
  if (probe === 'true') {
    log(`Token can push to ${repo}.`)
    return
  }

  log(`::warning::Could not confirm push access to ${repo} (permissions reported "${probe || 'nothing'}").`)
  log('Continuing: the contents API refuses to replace a file without its blob SHA, so a read that failed for')
  log('lack of access cannot overwrite anything. A push that is genuinely unauthorised will fail below.')
}

interface RemoteFile { text: string, blobSha: string }

function readRemote(): RemoteFile | null {
  const raw = gh(['api', `repos/${repo}/contents/${path}`, '--jq', '{content: .content, sha: .sha}'], true).trim()
  if (raw === '') return null

  const parsed = JSON.parse(raw) as { content?: string, sha?: string }
  if (typeof parsed.content !== 'string' || typeof parsed.sha !== 'string') return null

  return { text: Buffer.from(parsed.content, 'base64').toString('utf8'), blobSha: parsed.sha }
}

// Ahead of `preflight`, which is the first thing here that reaches the network:
// a descriptor pointing somewhere other than this project's bundle for this
// version is refused whatever is already published and whatever `--force` says,
// so it should not depend on a token being present or a probe answering. A
// read-only token or an unreachable API would otherwise fail first and report
// the wrong reason for a URL that was never publishable.
const badUrl = checkDescriptorUrl(url, version)
if (badUrl !== null) fail(`Refusing to write ${version} to ${repo}.`, badUrl, 'Nothing was changed.')

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
