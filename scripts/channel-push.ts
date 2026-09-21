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
 * anyone put the real one back. `X.Y.Z` is refused by the version check
 * below, before any network call — note that it does *not* fail the URL
 * check, because that check builds what it expects out of `--version`, so a
 * placeholder version and a URL built around the same placeholder agree with
 * each other. The tap is also named correctly here now; the old example
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
import { isGhNotFound } from './release-state.ts'
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
// Normalised once, here. A leading `v` is accepted because that is how tags
// are written and how operators paste them, but everything downstream — the
// URL the guard builds, the tag the release probe queries, and
// `renderDescriptor`, which throws `Not a version` on anything else — has to
// see the bare number. Stripping it at each use instead let a `v`-prefixed
// version pass every check and then die in the renderer with an uncaught
// stack trace, after three authenticated calls.
const version = flag('version').replace(/^v/, '')
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
//
// The version first, and with the same rule `renderDescriptor` applies, so the
// refusal here and the throw there can never disagree about what a version is.
// It has to be checked in its own right: `checkDescriptorUrl` builds what it
// expects *from* `--version`, so a placeholder version and a URL built around
// the same placeholder agree with each other and pass. The usage example above
// did exactly that, reaching three network calls before the renderer threw
// `Not a version: X.Y.Z` as an uncaught stack trace.
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  fail(`Refusing to write ${version} to ${repo}.`, '--version must be MAJOR.MINOR.PATCH, optionally with a prerelease suffix.', 'Nothing was changed.')
}

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

/**
 * A `gh` run that failed, told apart from one that answered "no".
 *
 * `gh(args, true)` collapses every non-zero exit to an empty string, which
 * makes "this release does not exist" identical to "the API did not answer".
 * For a probe whose whole purpose is to establish that something exists, those
 * two must not be the same value: the first has to refuse and the second has
 * to be survivable.
 */
function ghTry(args: string[]): { stdout: string, stderr: string, failed: boolean } {
  try {
    return { stdout: execFileSync(ghPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', failed: false }
  } catch (error) {
    const stderr = error instanceof Error && 'stderr' in error ? String((error as { stderr?: unknown }).stderr ?? '') : ''
    return { stdout: '', stderr: stderr.trim(), failed: true }
  }
}

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
 * That the release this descriptor points at really exists, is one users can
 * download, and carries these exact bytes.
 *
 * `checkDescriptorUrl` proves the URL has the right *shape*; it cannot prove
 * anything is behind it, because the version and the URL both come from the
 * same caller and a consistent invented pair satisfies it. That gap is what
 * the 2026-09-14 incident published: a descriptor whose URL 404s, and which
 * the downgrade rule then refused to let anyone replace.
 *
 * The distinction that matters here is "no" versus "cannot tell". An earlier
 * version of this check asked `gh` through a helper that collapses every
 * non-zero exit to an empty string, so `release not found` — the one answer
 * that means the incident is happening again — was indistinguishable from an
 * unreachable API, and warned and continued. Publishing `--version 99.99.99`
 * with its canonical URL reproduced the incident end to end.
 *
 * So: a definite negative refuses, and only a genuinely unreadable answer
 * warns and continues. The fallback stays because this runs last against a
 * release the workflow has already built, and an API that will not answer must
 * not be the thing that strands one.
 */
function requireReleaseAsset(): void {
  const release = version
  const wanted = bundleFileName(release)
  // The REST endpoint rather than `gh release view --json`. Both expose the
  // per-asset digest on a current `gh`, but `--json` only returns the fields
  // that build of `gh` knows about, so an older one on a runner would silently
  // drop `digest` and quietly turn the checksum comparison below into a
  // warning — a security check that stops working without saying so. The REST
  // shape does not depend on the client, and a missing tag answers HTTP 404,
  // which `isGhNotFound` already matches.
  const probe = ghTry(['api', `repos/${SOURCE_REPOSITORY}/releases/tags/v${release}`])

  if (probe.failed) {
    // `isGhNotFound` is what `release-detect.ts` already uses to tell a missing
    // release from a broken one. It is not enough on its own here: this job
    // runs with the tap-and-bucket token, which is not the token that made the
    // release, and GitHub answers 404 rather than 403 for a repository a
    // credential cannot see. So a 404 alone cannot tell "there is no such
    // release" — which must refuse — from "this token cannot read the source
    // repository" — which must not, or a scope change silently fails every
    // release. Asking whether the repository itself is visible separates them,
    // and only runs on the 404 path.
    if (isGhNotFound(probe.stderr)) {
      const repoProbe = ghTry(['api', `repos/${SOURCE_REPOSITORY}`])

      // The *only* reason to carry on from here is a positively established
      // "this credential cannot see that repository". Anything else — a rate
      // limit, an outage, a socket closed mid-request — leaves an unexplained
      // 404 on the release itself, and continuing would publish exactly the
      // descriptor this check exists to stop. The asymmetry settles it: a
      // wrong refusal costs a re-run of a repair job, while a wrong publish is
      // a 404 on a live channel that the downgrade rule then refuses to let
      // anyone replace.
      if (repoProbe.failed && isGhNotFound(repoProbe.stderr)) {
        log(`::warning::This token cannot read ${SOURCE_REPOSITORY}, so v${release} could not be confirmed. Continuing.`)
        return
      }

      fail(
        `Refusing to write ${version} to ${repo}.`,
        repoProbe.failed
          ? `${SOURCE_REPOSITORY} answered 404 for v${release}, and whether it has that release could not be established.`
          : `${SOURCE_REPOSITORY} has no v${release} release, so this descriptor would point at a 404.`,
        'Nothing was changed.',
      )
    }
    log(`::warning::Could not read the v${release} release to confirm ${wanted} exists. Continuing.`)
    return
  }

  let parsed: { assets?: { name?: string, digest?: string | null }[], draft?: boolean, prerelease?: boolean }
  try {
    parsed = JSON.parse(probe.stdout.trim()) as typeof parsed
  } catch {
    log(`::warning::Could not parse the v${release} release. Continuing.`)
    return
  }

  // Both refusals the republish workflow already makes, carried into the script
  // so a hand-run cannot walk around them. A draft's assets are not anonymously
  // downloadable — `gh` resolves them for an authenticated token and every user
  // gets a 404 — and `brew upgrade` and `scoop update` have no concept of a
  // prerelease, so the managed channels only ever carry stable releases.
  if (parsed.draft === true) {
    fail(`Refusing to write ${version} to ${repo}.`, `v${release} is still a draft; its assets are not downloadable.`, 'Nothing was changed.')
  }
  if (parsed.prerelease === true) {
    fail(`Refusing to write ${version} to ${repo}.`, `v${release} is a prerelease; the managed channels only carry stable releases.`, 'Nothing was changed.')
  }

  const assets = parsed.assets ?? []
  const asset = assets.find((candidate) => candidate.name === wanted)
  if (asset === undefined) {
    fail(
      `Refusing to write ${version} to ${repo}.`,
      `The v${release} release of ${SOURCE_REPOSITORY} does not carry ${wanted}, so this descriptor would point at a 404.`,
      `It lists: ${assets.map((candidate) => candidate.name ?? '?').join(', ') || '(no assets)'}`,
      'Nothing was changed.',
    )
  }

  // The existence proof turned into a bytes proof. A real URL with an invented
  // or stale hash breaks installs exactly as a 404 does, and nothing else here
  // would catch it: `decideChannelWrite` only compares the hash against what is
  // already published, never against the release. The incident's descriptor
  // carried a fabricated hash as well as a fabricated URL.
  const digest = asset.digest ?? ''
  if (digest === '') {
    log(`::warning::The v${release} release does not publish a digest for ${wanted}; could not verify --sha256. Continuing.`)
    return
  }
  if (digest !== `sha256:${sha256}`) {
    fail(
      `Refusing to write ${version} to ${repo}.`,
      `--sha256 does not match the ${wanted} asset published in v${release}.`,
      `The release says ${digest}.`,
      'Nothing was changed.',
    )
  }
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
