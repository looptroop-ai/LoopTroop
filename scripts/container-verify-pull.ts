#!/usr/bin/env node
/**
 * Pulls a published tag the way a user pulls it, on the architecture running
 * this script, and proves the bytes that arrive are the ones this release built.
 *
 *   node scripts/container-verify-pull.ts \
 *     --image ghcr.io/looptroop-ai/looptroop \
 *     --version 0.5.0 --arch amd64 --expect-digest sha256:<amd64 manifest>
 *
 * By tag rather than by the digest being asserted, because the tag is the thing
 * that could be wrong. Checking the index first is what makes pulling the tag a
 * test of the released bytes instead of a leap of faith.
 *
 * Run per architecture on a runner of that architecture, so `docker pull` is
 * doing the same platform resolution a user's would.
 */
import { docker, fatal, log } from './container-docker.ts'
import { DIGEST_PATTERN, platformDigest } from './container-tags.ts'

interface Options {
  image: string
  version: string
  arch: string
  expectDigest: string
}

function parseArgs(argv: string[]): Options {
  let image = ''
  let version = ''
  let arch = ''
  let expectDigest = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = (name: string): string => {
      const value = argv[i + 1] ?? ''
      i += 1
      if (value.trim() === '') throw new Error(`${name} needs a value`)
      return value.trim()
    }
    if (arg === '--image') image = take('--image')
    else if (arg === '--version') version = take('--version')
    else if (arg === '--arch') arch = take('--arch')
    else if (arg === '--expect-digest') expectDigest = take('--expect-digest')
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (image === '') throw new Error('--image is required')
  if (version === '') throw new Error('--version is required')
  if (arch !== 'amd64' && arch !== 'arm64') throw new Error(`--arch must be amd64 or arm64, got '${arch}'`)
  if (!DIGEST_PATTERN.test(expectDigest)) throw new Error(`--expect-digest '${expectDigest}' is not a sha256 digest`)
  return { image, version, arch, expectDigest }
}

let options: Options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  log('usage: node scripts/container-verify-pull.ts --image <registry/repo> --version <x.y.z>')
  log('         --arch <amd64|arm64> --expect-digest <sha256:...>')
  process.exit(2)
}

const reference = `${options.image}:${options.version}`

// The index entry for this architecture must be the manifest this architecture's
// build pushed. Read from the registry's own index rather than from `docker image
// inspect`'s RepoDigests, which records the index digest in some Docker versions
// and the platform manifest digest in others — an ambiguity that has no place in
// a release assertion.
const raw = docker(['buildx', 'imagetools', 'inspect', '--raw', reference])
if (raw.code !== 0) {
  fatal(`Could not read the published index for ${reference} (exit ${raw.code}).`, raw.stderr)
}

let entry: string | null
try {
  entry = platformDigest(raw.stdout, 'linux', options.arch)
} catch {
  fatal(`What the registry served for ${reference} is not valid JSON.`, raw.stdout)
}
if (entry === null) {
  fatal(`The published index has no linux/${options.arch} manifest.`, raw.stdout)
}
if (entry !== options.expectDigest) {
  fatal(`linux/${options.arch} is ${entry}, the tagging step published ${options.expectDigest}.`)
}
log(`linux/${options.arch} -> ${entry}`)

const pulled = docker(['pull', '--platform', `linux/${options.arch}`, reference])
process.stdout.write(pulled.stdout)
process.stderr.write(pulled.stderr)
if (pulled.code !== 0) {
  fatal(`docker pull ${reference} failed (exit ${pulled.code}).`)
}

// The daemon's own view of what it unpacked. A wrong answer here means the
// platform resolution served something this machine cannot run, which is
// precisely the failure a single-architecture tag would cause.
const inspected = docker(['image', 'inspect', '--format', '{{.Architecture}}', reference])
const architecture = inspected.stdout.trim()
if (inspected.code !== 0) {
  fatal(`Could not inspect the pulled image (exit ${inspected.code}).`, inspected.stderr)
}
if (architecture !== options.arch) {
  fatal(`Pulled linux/${options.arch} but the image reports ${architecture}.`)
}
log(`Pulled ${reference} (${architecture})`)
