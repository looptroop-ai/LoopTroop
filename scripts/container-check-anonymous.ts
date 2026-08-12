#!/usr/bin/env node
/**
 * Does a client with no credentials at all get this release from this registry?
 *
 *   node scripts/container-check-anonymous.ts \
 *     --image docker.io/looptroopai/looptroop \
 *     --version 0.5.0 --index-digest sha256:<index>
 *
 * That is the point of it. A private repository is inspectable by the account
 * that pushed to it and by nobody else, so an authenticated check would pass
 * happily on a repository from which every `docker pull` in the README fails.
 * The check runs after an explicit logout from the registry being checked.
 *
 * Not the same question as "did the tag get written": container-manifest.ts
 * already proved that, with credentials. This one is about visibility.
 */
import { docker, fatal, log } from './container-docker.ts'
import { DIGEST_PATTERN, isRateLimited } from './container-tags.ts'

/** Docker Hub rate-limits anonymous requests per IP, and hosted runners share
 * IPs with everyone else on them. Six attempts, backing off, is roughly three
 * minutes of a limit that is usually measured in seconds. */
const ATTEMPTS = 6

interface Options {
  image: string
  version: string
  indexDigest: string
}

function parseArgs(argv: string[]): Options {
  let image = ''
  let version = ''
  let indexDigest = ''
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
    else if (arg === '--index-digest') indexDigest = take('--index-digest')
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`)
  }
  if (image === '') throw new Error('--image is required')
  if (version === '') throw new Error('--version is required')
  if (!DIGEST_PATTERN.test(indexDigest)) throw new Error(`--index-digest '${indexDigest}' is not a sha256 digest`)
  if (!image.includes('/')) throw new Error(`--image '${image}' has no registry host`)
  return { image, version, indexDigest }
}

/** Blocking, because everything else here is synchronous and a promise would
 * only move the same wait somewhere less obvious. */
function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

let options: Options
try {
  options = parseArgs(process.argv.slice(2))
} catch (error) {
  log(error instanceof Error ? error.message : String(error))
  log('usage: node scripts/container-check-anonymous.ts --image <registry/repo>')
  log('         --version <x.y.z> --index-digest <sha256:...>')
  process.exit(2)
}

const host = options.image.slice(0, options.image.indexOf('/'))
const reference = `${options.image}:${options.version}`

// Ignored on purpose: a logout with nothing to log out of is a non-zero exit and
// exactly the state this check wants to be in.
docker(['logout', host])

let resolved = ''
for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
  // `imagetools inspect` rather than `docker manifest inspect`: the latter is
  // still gated behind the experimental CLI flag in some Docker versions and
  // would fail for a reason that has nothing to do with this release.
  const result = docker(['buildx', 'imagetools', 'inspect', '--format', '{{.Manifest.Digest}}', reference])
  const digest = result.stdout.trim()
  if (result.code === 0 && DIGEST_PATTERN.test(digest)) {
    resolved = digest
    break
  }

  // Only a rate limit is retried. A missing tag or a private repository fails on
  // the first attempt, because neither gets better by waiting.
  if (!isRateLimited(result.stderr)) {
    fatal(
      `${host} does not serve ${reference} without credentials.`,
      ['If the repository or package is private, every documented docker pull fails for users.', result.stderr].join('\n'),
    )
  }
  log(`Attempt ${attempt}: ${host} is rate-limiting this runner's shared IP.`)
  if (attempt < ATTEMPTS) sleep(attempt * 20_000)
}

if (resolved === '') {
  fatal(`${host} kept rate-limiting; could not confirm ${reference} is public.`)
}
if (resolved !== options.indexDigest) {
  fatal(`${reference} serves ${resolved}, this release published ${options.indexDigest}.`)
}
log(`${reference} -> ${resolved} (anonymous)`)
