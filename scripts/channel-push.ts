#!/usr/bin/env node
/**
 * Publishes a descriptor to a package channel's repository.
 *
 *   node scripts/channel-push.ts --channel homebrew \
 *     --repo looptroop-ai/homebrew-tap --version X.Y.Z \
 *     --url https://github.com/looptroop-ai/LoopTroop/releases/download/vX.Y.Z/looptroop-X.Y.Z-bundle.tar.gz \
 *     --sha256 … [--force] [--dry-run]
 *
 * Every value above is deliberately a placeholder that cannot publish. This
 * example previously read `--version 9.9.9` against `--repo owner/name`, and on
 * 2026-09-14 somebody pasted and ran it: those values became the live Scoop
 * descriptor, whose URL 404s, and the downgrade rule then refused to let
 * anyone put the real one back. `X.Y.Z` fails the URL check on the first
 * attempt instead. The tap is also named correctly here now; the old example
 * pointed at `homebrew-looptroop`, which does not exist.
 *
 * `--repo` is where the descriptor is *written* — a tap or a bucket. Where the
 * bytes users download come from is not an argument at all: `--url` must equal
 * this project's bundle URL for `--version`, and that release must really
 * carry the asset.
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
import { DESCRIPTOR_PATH, bundleFileName, parseDescriptor, renderDescriptor } from './package-manifests.ts'
import { SOURCE_REPOSITORY, checkDescriptorUrl, decideChannelWrite, writes } from './channel-state.ts'
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

// Only the two channels this script actually writes. `DESCRIPTOR_PATH` also
// carries chocolatey, which is built and pushed by `build-choco.ts` and
// `choco-push.ts` and never reaches here, so accepting it only made the check
// disagree with the usage line above it.
const CHANNELS = ['homebrew', 'scoop'] as const
const channel = flag('channel') as Channel
if (!(CHANNELS as readonly string[]).includes(channel)) fail(`--channel must be one of ${CHANNELS.join(', ')}.`)

const repo = flag('repo')
const version = flag('version')
const url = flag('url')
const sha256 = flag('sha256')
const force = args.switch('force')
const dryRun = args.switch('dry-run')
const path = DESCRIPTOR_PATH[channel]

// Everything that can be judged from the arguments alone, before the `gh`
// resolution below and the network calls after it. Both of those can fail for
// their own reasons, and when the arguments were never publishable that is the
// wrong reason to report — the operator changes a token or a PATH and runs the
// same unpublishable command again.
const badUrl = checkDescriptorUrl(url, version)
if (badUrl !== null) fail(`Refusing to write ${version} to ${repo}.`, badUrl, 'Nothing was changed.')

// `renderDescriptor` throws on a malformed hash, which reaches the operator as
// an uncaught stack trace after the network work rather than as a refusal.
if (!/^[0-9a-f]{64}$/.test(sha256)) fail(`Refusing to write ${version} to ${repo}.`, '--sha256 must be 64 lowercase hex characters.', 'Nothing was changed.')

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

/**
 * That the release this descriptor points at actually has the asset.
 *
 * `checkDescriptorUrl` proves the URL has the right *shape*; it cannot prove
 * the bytes exist, because the version and the URL both come from the same
 * caller and a consistent invented pair satisfies it. That gap is what the
 * 2026-09-14 incident published: a descriptor whose URL 404s, and which the
 * downgrade rule then refused to let anyone replace.
 *
 * Fail-closed only on a definite answer. A release that resolves and does not
 * list the asset is a refusal; anything else — `gh` erroring, the API
 * unreachable, output that will not parse — is a warning and the publish
 * continues, because this is a last check on a release the workflow has
 * already built and drafted, and it must not be the thing that strands one.
 */
function requireReleaseAsset(): void {
  const raw = gh(['release', 'view', `v${version.replace(/^v/, '')}`, '--repo', SOURCE_REPOSITORY, '--json', 'assets'], true).trim()
  if (raw === '') {
    log(`::warning::Could not read the v${version} release to confirm ${bundleFileName(version)} exists. Continuing.`)
    return
  }

  let names: string[]
  try {
    names = (JSON.parse(raw) as { assets?: { name?: string }[] }).assets?.map((asset) => asset.name ?? '') ?? []
  } catch {
    log(`::warning::Could not parse the v${version} release assets. Continuing.`)
    return
  }

  const wanted = bundleFileName(version.replace(/^v/, ''))
  if (names.includes(wanted)) return

  fail(
    `Refusing to write ${version} to ${repo}.`,
    `The v${version} release of ${SOURCE_REPOSITORY} does not carry ${wanted}, so this descriptor would point at a 404.`,
    `It lists: ${names.join(', ') || '(no assets)'}`,
    'Nothing was changed.',
  )
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
requireReleaseAsset()

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
