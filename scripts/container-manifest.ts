#!/usr/bin/env node
/**
 * Tags a released container image, in every registry, from the per-architecture
 * manifests a build already pushed by digest.
 *
 *   node scripts/container-manifest.ts \
 *     --version 0.5.0 --dist-tag latest --revision <commit> \
 *     --image docker.io/looptroopai/looptroop \
 *     --image ghcr.io/looptroop-ai/looptroop \
 *     --digest sha256:<amd64> --digest sha256:<arm64>
 *
 * Called by the release run and by the repair dispatch, which is the reason it
 * is a script rather than two copies of the same shell. What it decides — which
 * tags a release publishes, whether an existing tag may be written, and whether
 * an image already on that tag is this release's own — is in ./container-tags.ts,
 * under test.
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
import { DIGEST_PATTERN, isOurRelease, parseIndex, planTags, readImageProvenance, tagsThatMustNotMove } from './container-tags.ts'

interface Options {
  version: string
  distTag: string
  /** The commit the release was built from, which the image carries as a label. */
  revision: string
  images: string[]
  digests: string[]
}

function parseArgs(argv: string[]): Options {
  let version = ''
  let distTag = ''
  let revision = ''
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
    else if (arg === '--revision') revision = take('--revision')
    else if (arg === '--image') images.push(take('--image'))
    else if (arg === '--digest') digests.push(take('--digest'))
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (version === '') throw new Error('--version is required')
  if (distTag === '') throw new Error('--dist-tag is required')
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error(`--revision '${revision}' is not a commit sha`)
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
  return { version, distTag, revision, images, digests }
}

interface RegistryState {
  image: string
  /** The platform manifests already on the version tag, or null when absent. */
  published: string[] | null
  /** The index digest already on the version tag, or null when absent. */
  indexDigest: string | null
}

function survey(image: string, version: string): RegistryState {
  const reference = `${image}:${version}`
  const raw = inspectRaw(reference)
  if (raw === null) {
    log(`  ${reference} is absent.`)
    return { image, published: null, indexDigest: null }
  }

  let parsed
  try {
    parsed = parseIndex(raw)
  } catch {
    fatal(`${reference} exists but what the registry served is not valid JSON.`, raw)
  }
  if (!parsed.isIndex) {
    fatal(
      `${reference} exists but is a single manifest, not a multi-architecture index.`,
      'Nothing in this repository publishes one. Release a new version.',
    )
  }
  const indexDigest = requireDigest(reference)
  const published = parsed.platforms.map((platform) => platform.digest)
  log(`  ${reference} exists: index ${indexDigest}, ${published.length} manifests.`)
  return { image, published, indexDigest }
}

const sorted = (digests: string[]): string => [...digests].sort().join(' ')

let options: Options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  log('usage: node scripts/container-manifest.ts --version <x.y.z> --dist-tag <latest|next>')
  log('         --revision <commit> --image <registry/repo> [--image ...]')
  log('         --digest <sha256:...> --digest <sha256:...>')
  process.exit(2)
}

let plan
try {
  plan = planTags(options.version, options.distTag)
} catch (error) {
  fatal(error instanceof Error ? error.message : String(error))
}

log(`Version:   ${options.version} (${plan.stable ? 'stable' : 'prerelease'})`)
log(`Revision:  ${options.revision}`)
log(`Tags:      ${plan.tags.join(' ')}`)
log(`Built:     ${options.digests.join(' ')}`)
log(`Registries:\n  ${options.images.join('\n  ')}`)

// ---------------------------------------------------------------------------
// What is on the version tag already, and may this run write it?
// ---------------------------------------------------------------------------
// A published version tag is immutable here on purpose. The states are kept
// apart rather than collapsed, because the interesting one is neither "absent"
// nor "stop":
//
//   absent everywhere  -> first publish; tag what was just built
//   already these bytes-> a previous run got this far; re-tagging is safe
//   an earlier publish -> a repair; adopt those bytes rather than the new build
//   anything else      -> hard stop, printing what the registry said
//
// The third is why a repair can work at all. A rebuild of an already-released
// version does not reproduce its digests — the base image and the package
// repositories it installs from all move — so a repair that insisted on
// publishing its own build would be refused by the registry that already has
// the tag, and the registry that is missing it would never be fixed. Whether an
// existing publish is this release's own is decided by the labels the image
// carries, not by trusting whatever is there.
log('\n[1] What the registries already serve')
const states = options.images.map((image) => survey(image, options.version))
const present = states.filter((state) => state.published !== null)

if (present.length > 1 && new Set(present.map((state) => sorted(state.published!))).size !== 1) {
  fatal(
    'The registries already serve this version, and they disagree about what it is.',
    present.map((state) => `  ${state.image}:${options.version} -> ${sorted(state.published!)}`).join('\n'),
  )
}

/** Where the manifests being tagged come from, per registry. */
let sourceFor: (image: string) => string[]
/** Known in advance only when adopting an existing index. */
let expectedIndex: string | null = null

if (present.length === 0) {
  log('\n[2] First publish of this version; tagging what this run built.')
  sourceFor = (image) => options.digests.map((digest) => `${image}@${digest}`)
} else if (sorted(present[0]!.published!) === sorted(options.digests)) {
  log('\n[2] Already serving exactly these manifests; re-tagging is safe.')
  sourceFor = (image) => options.digests.map((digest) => `${image}@${digest}`)
} else {
  const source = present[0]!
  const reference = `${source.image}@${source.published![0]}`
  const config = docker(['buildx', 'imagetools', 'inspect', '--format', '{{json .Image}}', reference])
  if (config.code !== 0) {
    fatal(`${source.image}:${options.version} exists, but its image config could not be read.`, config.stderr)
  }

  let provenance
  try {
    provenance = readImageProvenance(config.stdout)
  } catch {
    fatal(`${reference} returned an image config that is not valid JSON.`, config.stdout)
  }
  if (!isOurRelease(provenance, options.version, options.revision)) {
    fatal(`${source.image}:${options.version} already exists and was not published by this release.`, [
      `  it says version ${provenance.version ?? '(unlabelled)'} revision ${provenance.revision ?? '(unlabelled)'}`,
      `  this run is    version ${options.version} revision ${options.revision}`,
      `  registry: ${sorted(source.published!)}`,
      `  this run: ${sorted(options.digests)}`,
      'A released version tag is immutable. Release a new version rather than retagging.',
    ].join('\n'))
  }

  // The released bytes are the published ones, not this run's. A rebuild of the
  // same commit is a different image — same source, newer base and packages —
  // and republishing it under a tag users may already have pulled would make
  // the digest they recorded meaningless.
  expectedIndex = source.indexDigest
  log(`\n[2] ${source.image}:${options.version} is this release's own earlier publish.`)
  log(`    Adopting its index ${expectedIndex} and discarding this run's build.`)
  log('    Registries missing the tag are filled from it, so all of them serve identical bytes.')
  sourceFor = () => [`${source.image}@${expectedIndex}`]
}

// Taken after the survey, which has already ended the run on any registry
// error, so a tag that does not resolve here really is absent rather than a
// transient fault being recorded as an absence.
const mustNotMove = tagsThatMustNotMove(plan)
const before = new Map<string, string>()
if (mustNotMove.length > 0) {
  log('\n[3] Snapshot the tags a prerelease must not move')
  for (const image of options.images) {
    for (const tag of mustNotMove) {
      const reference = `${image}:${tag}`
      const digest = resolveDigest(reference)
      before.set(reference, digest)
      log(`  ${reference} -> ${digest}`)
    }
  }
}

// Run even where the tag already serves the right bytes. The create is
// idempotent for identical sources — same manifests in the same order, same
// index, same digest — and a previous run that died partway through tagging
// left some of these tags unwritten. Skipping would preserve exactly that
// damage, which is the situation a repair is usually in.
//
// One call per registry, with every tag in it. Within a registry this only
// writes a manifest; the one case where blobs move between registries is the
// adopted-index case, which is a copy on purpose.
log('\n[4] Create the tags')
let indexDigest = expectedIndex ?? ''
for (const image of options.images) {
  const args = ['buildx', 'imagetools', 'create']
  for (const tag of plan.tags) args.push('--tag', `${image}:${tag}`)
  // In the order given, never the order an artefact download happened to
  // produce: the index bytes are built from that order, so a fixed one is what
  // makes the index digest identical in every registry and identical again on a
  // re-run.
  for (const source of sourceFor(image)) args.push(source)

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
    // Every index is built from the same manifests in the same order, so their
    // bytes — and therefore their digests — must match. A difference means one
    // registry altered what it was given, or that a copy did not land whole.
    fatal(`The registries do not agree on the index digest: expected ${indexDigest}, ${image} serves ${resolved}.`)
  }
}

// The tags a user will actually pull, every one of them, in every registry —
// not just the one the create step happened to read back.
log('\n[5] Every tag resolves to the index')
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
  log('\n[6] The prerelease moved no floating tag')
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
