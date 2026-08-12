#!/usr/bin/env node
/**
 * Tags a released container image, in every registry, from the per-architecture
 * manifests a build already pushed by digest.
 *
 *   node scripts/container-manifest.ts \
 *     --version 0.5.0 --dist-tag latest \
 *     --image docker.io/looptroopai/looptroop \
 *     --image ghcr.io/looptroop-ai/looptroop \
 *     --digest sha256:<amd64> --digest sha256:<arm64>
 *
 * Called by the release run and by the repair dispatch, which is the reason it
 * is a script rather than two copies of the same shell. What it decides — which
 * tags a release publishes, and whether an existing tag may be written — is in
 * ./container-tags.ts, under test.
 *
 * One process for the whole sequence, so the snapshot of the floating tags is
 * taken by the same code that later proves they did not move, rather than
 * handed between workflow steps through the environment.
 *
 * Assumes `docker login` has already happened for every registry named. It has
 * no credentials of its own and reads none.
 */
import { appendFileSync } from 'node:fs'

import { ABSENT, docker, fatal, inspectRaw, log, requireDigest, resolveDigest } from './container-docker.ts'
import { DIGEST_PATTERN, planTags, servesExactly, tagsThatMustNotMove } from './container-tags.ts'

interface Options {
  version: string
  distTag: string
  images: string[]
  digests: string[]
}

function parseArgs(argv: string[]): Options {
  let version = ''
  let distTag = ''
  const images: string[] = []
  const digests: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = (name: string): string => {
      const value = argv[i + 1] ?? ''
      i += 1
      if (value.trim() === '') throw new Error(`${name} needs a value`)
      return value.trim()
    }
    if (arg === '--version') version = take('--version')
    else if (arg === '--dist-tag') distTag = take('--dist-tag')
    else if (arg === '--image') images.push(take('--image'))
    else if (arg === '--digest') digests.push(take('--digest'))
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (version === '') throw new Error('--version is required')
  if (distTag === '') throw new Error('--dist-tag is required')
  if (images.length === 0) throw new Error('at least one --image is required')
  if (new Set(images).size !== images.length) throw new Error('the same --image was given twice')
  // Exactly two, because that is what this project builds. A third architecture
  // is a deliberate change to the release, not something to accept silently from
  // a miscounted artefact download — and one digest would publish an index that
  // works for half the world.
  if (digests.length !== 2) throw new Error(`expected exactly 2 --digest values, got ${digests.length}`)
  for (const digest of digests) {
    if (!DIGEST_PATTERN.test(digest)) throw new Error(`'${digest}' is not a sha256 digest`)
  }
  if (new Set(digests).size !== digests.length) {
    throw new Error('the two --digest values are identical; the two architectures cannot be the same manifest')
  }
  return { version, distTag, images, digests }
}

/**
 * Whether the version tag may be written, asked before anything is written.
 *
 * A published version tag is immutable here on purpose, so the four possible
 * answers are kept apart rather than collapsed:
 *
 *   absent          -> first publish of this version; create the tags
 *   already ours    -> a previous run got this far; re-tagging is safe
 *   different bytes -> hard stop, something outside this run published it
 *   anything else   -> hard stop, printing what the registry said (in inspectRaw)
 */
function preflight(image: string, version: string, digests: string[]): void {
  const reference = `${image}:${version}`
  const raw = inspectRaw(reference)
  if (raw === null) {
    log(`    ${reference} is absent; it will be created.`)
    return
  }

  let comparison
  try {
    comparison = servesExactly(raw, digests)
  } catch {
    fatal(`${reference} exists but what the registry served is not valid JSON.`, raw)
  }
  if (!comparison.isIndex) {
    fatal(
      `${reference} exists but is a single manifest, not a multi-architecture index.`,
      'Something other than this workflow published that tag. Release a new version.',
    )
  }
  if (!comparison.matches) {
    fatal(`${reference} already exists and serves different bytes.`, [
      `  registry: ${comparison.present.join(' ') || '(no platform manifests)'}`,
      `  this run: ${[...digests].sort().join(' ')}`,
      'A released version tag is immutable. Release a new version rather than retagging.',
    ].join('\n'))
  }
  log(`    ${reference} already serves exactly these ${digests.length} manifests.`)
}

let options: Options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  log('usage: node scripts/container-manifest.ts --version <x.y.z> --dist-tag <latest|next>')
  log('         --image <registry/repo> [--image ...] --digest <sha256:...> --digest <sha256:...>')
  process.exit(2)
}

let plan
try {
  plan = planTags(options.version, options.distTag)
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error))
}

log(`Version:   ${options.version} (${plan.stable ? 'stable' : 'prerelease'})`)
log(`Tags:      ${plan.tags.join(' ')}`)
log(`Manifests: ${options.digests.join(' ')}`)
log(`Registries:\n  ${options.images.join('\n  ')}`)

log('\n[1] Immutability pre-flight')
for (const image of options.images) {
  log(`  --- ${image}`)
  preflight(image, options.version, options.digests)
}

// Taken after the pre-flight, which has already ended the run on any registry
// error, so a tag that does not resolve here really is absent rather than a
// transient fault being recorded as an absence.
const mustNotMove = tagsThatMustNotMove(plan)
const before = new Map<string, string>()
if (mustNotMove.length > 0) {
  log('\n[2] Snapshot the tags a prerelease must not move')
  for (const image of options.images) {
    for (const tag of mustNotMove) {
      const reference = `${image}:${tag}`
      const digest = resolveDigest(reference)
      before.set(reference, digest)
      log(`  ${reference} -> ${digest}`)
    }
  }
}

// Run even when the pre-flight found the tag already serving these bytes. The
// create is idempotent for identical sources — same manifests in the same order,
// same index, same digest — and a previous run that died partway through tagging
// left some of these tags unwritten. Skipping would preserve exactly that damage.
//
// One call per registry, with every tag in it. Splitting the sources across
// registries would make buildx copy blobs from one to the other; keeping each
// call within a single registry means it only writes a manifest.
log('\n[3] Create the tags')
let indexDigest = ''
for (const image of options.images) {
  const args = ['buildx', 'imagetools', 'create']
  for (const tag of plan.tags) args.push('--tag', `${image}:${tag}`)
  // In the order given, never the order an artefact download happened to
  // produce: the index bytes are built from that order, so a fixed one is what
  // makes the index digest identical in every registry and identical again on a
  // re-run.
  for (const digest of options.digests) args.push(`${image}@${digest}`)

  log(`  --- ${image}`)
  const created = docker(args)
  process.stdout.write(created.stdout)
  process.stderr.write(created.stderr)
  if (created.code !== 0) {
    fatal(`Creating the tags on ${image} failed (exit ${created.code}).`)
  }

  const resolved = requireDigest(`${image}:${options.version}`)
  log(`    index ${resolved}`)
  if (indexDigest === '') {
    indexDigest = resolved
  } else if (indexDigest !== resolved) {
    // Every index is built from the same manifest digests in the same order, so
    // their bytes — and therefore their digests — must match. A difference means
    // one registry altered what it was given.
    fatal(`The registries report different index digests: ${indexDigest} and ${resolved}.`)
  }
}

// The tags a user will actually pull, every one of them, in every registry —
// not just the one the create step happened to read back.
log('\n[4] Every tag resolves to the new index')
for (const image of options.images) {
  for (const tag of plan.tags) {
    const reference = `${image}:${tag}`
    const resolved = resolveDigest(reference)
    if (resolved !== indexDigest) {
      fatal(`${reference} resolves to ${resolved}, expected ${indexDigest}.`)
    }
    log(`  ${reference} -> ${resolved}`)
  }
}

if (mustNotMove.length > 0) {
  // A prerelease publishes its own version tag and `next`, and nothing else. If
  // `latest` or the `X.Y` series moved anyway then a plain `docker pull` now
  // serves a release candidate to everyone — the same failure the npm job
  // refuses, on the channel that has no npm job in front of it.
  log('\n[5] The prerelease moved no floating tag')
  for (const [reference, snapshot] of before) {
    const now = resolveDigest(reference)
    if (now !== snapshot) {
      const was = snapshot === ABSENT ? 'absent' : snapshot
      fatal(`${reference} moved from ${was} to ${now} during a prerelease publish.`)
    }
    log(`  ${reference} is unchanged at ${snapshot}`)
  }
}

const outputPath = process.env.GITHUB_OUTPUT
if (outputPath) {
  appendFileSync(outputPath, `index_digest=${indexDigest}\ntags=${plan.tags.join(' ')}\n`)
}
log(`\nIndex: ${indexDigest}`)
log(`Tags:  ${plan.tags.join(' ')}`)
