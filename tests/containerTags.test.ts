import { describe, expect, it } from 'vitest'
import {
  authoritativeFloating,
  classifyRegistryFailure,
  isOurRelease,
  isRateLimited,
  parseIndex,
  planTags,
  platformDigest,
  platformProblem,
  readImageProvenance,
  restrictFloating,
  servesExactly,
  tagsThatMustNotMove,
} from '../scripts/container-tags'

const AMD64 = `sha256:${'a'.repeat(64)}`
const ARM64 = `sha256:${'b'.repeat(64)}`
const OTHER = `sha256:${'c'.repeat(64)}`

function index(entries: Array<{ digest: string, os?: string, architecture?: string }>): string {
  return JSON.stringify({
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: entries.map((entry) => ({
      digest: entry.digest,
      platform: { os: entry.os ?? 'linux', architecture: entry.architecture ?? 'amd64' },
    })),
  })
}

describe('planTags', () => {
  it('publishes the version, the series and latest for a stable release', () => {
    expect(planTags('0.5.0', 'latest')).toEqual({
      stable: true,
      series: '0.5',
      tags: ['0.5.0', '0.5', 'latest'],
      mustNotMove: ['next'],
    })
  })

  it('publishes only the version and next for a prerelease', () => {
    expect(planTags('0.5.0-rc.1', 'next')).toEqual({
      stable: false,
      series: '0.5',
      tags: ['0.5.0-rc.1', 'next'],
      mustNotMove: ['latest', '0.5'],
    })
  })

  it('never publishes a bare major tag', () => {
    // `looptroopai/looptroop:0` would change meaning under anyone who pinned it
    // on every minor release.
    expect(planTags('1.2.3', 'latest').tags).not.toContain('1')
  })

  it('refuses a prerelease that would take latest', () => {
    expect(() => planTags('0.5.0-rc.1', 'latest')).toThrow(/must not carry the 'latest' tag/)
  })

  it('refuses a stable release whose dist-tag is not latest', () => {
    // The two channels disagreeing about which release is `latest` is the thing
    // this catches; the container channel has no npm gate in front of it.
    expect(() => planTags('0.5.0', 'next')).toThrow(/stable version but its dist-tag/)
  })

  it('refuses a version it cannot route', () => {
    for (const bad of ['v0.5.0', '0.5', '0.5.0+build.1', '', ' 0.5.0', '01.2.3']) {
      expect(() => planTags(bad, 'latest')).toThrow()
    }
  })
})

describe('tagsThatMustNotMove', () => {
  it('protects next during a stable release, which does not write it', () => {
    // The release writes the version, the series and latest. `next` still points
    // at whatever candidate came before, and must keep doing so.
    expect(tagsThatMustNotMove(planTags('0.5.0', 'latest'))).toEqual(['next'])
  })

  it('protects latest and the series during a prerelease', () => {
    expect(tagsThatMustNotMove(planTags('0.5.0-rc.1', 'next'))).toEqual(['latest', '0.5'])
  })

  it('is every floating tag when a run writes none of them', () => {
    const plan = restrictFloating(planTags('0.5.0', 'latest'), [])
    expect(plan.tags).toEqual(['0.5.0'])
    expect(tagsThatMustNotMove(plan)).toEqual(['latest', 'next', '0.5'])
  })
})

describe('restrictFloating', () => {
  it('keeps only the floating tags a repair has evidence for', () => {
    // Repairing 0.5.0 long after 0.8.0 shipped must not drag `latest` back.
    const plan = restrictFloating(planTags('0.5.0', 'latest'), ['0.5'])
    expect(plan.tags).toEqual(['0.5.0', '0.5'])
    expect(plan.mustNotMove).toEqual(['latest', 'next'])
  })

  it('refuses a tag the release rules would never have written', () => {
    expect(() => restrictFloating(planTags('0.5.0-rc.1', 'next'), ['latest'])).toThrow(/may carry/)
    expect(() => restrictFloating(planTags('0.5.0', 'latest'), ['0.4'])).toThrow(/not a floating tag/)
  })
})

describe('authoritativeFloating', () => {
  const versions = ['0.4.9', '0.4.10', '0.5.0', '0.5.1', '0.6.0-rc.1', '0.6.0']

  it('claims latest only when npm already says this version is latest', () => {
    expect(authoritativeFloating('0.6.0', '0.6', { latest: '0.6.0' }, versions)).toContain('latest')
    expect(authoritativeFloating('0.5.0', '0.5', { latest: '0.6.0' }, versions)).not.toContain('latest')
  })

  it('claims next the same way', () => {
    expect(authoritativeFloating('0.6.0-rc.1', '0.6', { next: '0.6.0-rc.1' }, versions)).toEqual(['next'])
  })

  it('claims the series only for the newest stable release in it', () => {
    expect(authoritativeFloating('0.5.1', '0.5', {}, versions)).toEqual(['0.5'])
    expect(authoritativeFloating('0.5.0', '0.5', {}, versions)).toEqual([])
    // Numeric ordering, so 0.4.10 outranks 0.4.9 rather than sorting under it.
    expect(authoritativeFloating('0.4.10', '0.4', {}, versions)).toEqual(['0.4'])
    expect(authoritativeFloating('0.4.9', '0.4', {}, versions)).toEqual([])
  })

  it('claims nothing when npm knows nothing', () => {
    expect(authoritativeFloating('0.5.0', '0.5', {}, [])).toEqual([])
  })
})

describe('platformProblem', () => {
  const entry = (architecture: string, digest: string) => ({ os: 'linux', architecture, digest })

  it('accepts exactly one manifest per supported architecture', () => {
    expect(platformProblem([entry('amd64', AMD64), entry('arm64', ARM64)])).toBeNull()
  })

  it('refuses an index that is missing an architecture or carries a spare', () => {
    expect(platformProblem([entry('amd64', AMD64)])).toMatch(/expected exactly/)
    expect(platformProblem([entry('amd64', AMD64), entry('arm64', ARM64), entry('ppc64le', OTHER)])).toMatch(/expected exactly/)
  })

  it('refuses an index that points both architectures at one manifest', () => {
    expect(platformProblem([entry('amd64', AMD64), entry('arm64', AMD64)])).toMatch(/same manifest/)
  })
})

describe('classifyRegistryFailure', () => {
  it('recognises the ways a registry says there is nothing there', () => {
    for (const stderr of [
      'ERROR: docker.io/looptroopai/looptroop:0.5.0: not found',
      'manifest unknown',
      'MANIFEST_UNKNOWN: manifest unknown',
      'NAME_UNKNOWN: repository name not known to registry',
      'no such manifest: ghcr.io/looptroop-ai/looptroop:0.5.0',
      'the image does not exist',
    ]) {
      expect(classifyRegistryFailure(stderr)).toBe('absent')
    }
  })

  it('treats a rate limit as unknown even when it also says not found', () => {
    // Docker Hub's 429 body has mentioned "not found"; reading that as an
    // absence is how a published tag gets overwritten.
    expect(classifyRegistryFailure('toomanyrequests: too many requests, not found')).toBe('unknown')
    expect(classifyRegistryFailure('unexpected status: 429 Too Many Requests')).toBe('unknown')
  })

  it('treats everything it does not recognise as unknown', () => {
    for (const stderr of [
      'unauthorized: authentication required',
      'dial tcp: lookup registry-1.docker.io: no such host',
      'unexpected status code 500',
      '',
    ]) {
      expect(classifyRegistryFailure(stderr)).toBe('unknown')
    }
  })
})

describe('isRateLimited', () => {
  it('is true only for a refusal to serve this many requests', () => {
    expect(isRateLimited('toomanyrequests: You have reached your pull rate limit.')).toBe(true)
    expect(isRateLimited('unexpected status: 429')).toBe(true)
    expect(isRateLimited('unauthorized: authentication required')).toBe(false)
    // Not a rate limit: a digest or a byte count can contain 429.
    expect(isRateLimited('manifest unknown for sha256:4291')).toBe(false)
  })
})

describe('parseIndex', () => {
  it('reports a single manifest as not an index', () => {
    const manifest = JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json', config: {} })
    expect(parseIndex(manifest)).toEqual({ isIndex: false, platforms: [] })
  })

  it('drops attestation descriptors', () => {
    const raw = index([
      { digest: AMD64, architecture: 'amd64' },
      { digest: ARM64, architecture: 'arm64' },
      { digest: OTHER, os: 'unknown', architecture: 'unknown' },
    ])
    expect(parseIndex(raw).platforms.map((p) => p.digest)).toEqual([AMD64, ARM64])
  })
})

describe('servesExactly', () => {
  it('matches whichever order the registry lists the manifests in', () => {
    const raw = index([{ digest: ARM64, architecture: 'arm64' }, { digest: AMD64 }])
    expect(servesExactly(raw, [AMD64, ARM64]).matches).toBe(true)
  })

  it('does not match a superset or a subset', () => {
    expect(servesExactly(index([{ digest: AMD64 }]), [AMD64, ARM64]).matches).toBe(false)
    const three = index([
      { digest: AMD64 },
      { digest: ARM64, architecture: 'arm64' },
      { digest: OTHER, architecture: 'ppc64le' },
    ])
    expect(servesExactly(three, [AMD64, ARM64]).matches).toBe(false)
  })

  it('does not match a single manifest published under the tag', () => {
    const manifest = JSON.stringify({ mediaType: 'application/vnd.oci.image.manifest.v1+json' })
    const result = servesExactly(manifest, [AMD64, ARM64])
    expect(result.isIndex).toBe(false)
    expect(result.matches).toBe(false)
  })
})

describe('platformDigest', () => {
  const raw = index([{ digest: AMD64 }, { digest: ARM64, architecture: 'arm64' }])

  it('finds the manifest for one platform', () => {
    expect(platformDigest(raw, 'linux', 'arm64')).toBe(ARM64)
  })

  it('is null when the index carries no such platform', () => {
    expect(platformDigest(raw, 'linux', 'ppc64le')).toBeNull()
    expect(platformDigest(raw, 'windows', 'amd64')).toBeNull()
  })
})

describe('readImageProvenance', () => {
  const config = (labels: Record<string, string> | undefined) =>
    JSON.stringify({ architecture: 'amd64', os: 'linux', config: labels ? { Labels: labels } : {} })

  it('reads the version and revision the image was labelled with', () => {
    const raw = config({
      'org.opencontainers.image.version': '0.5.0',
      'org.opencontainers.image.revision': 'c'.repeat(40),
      'org.opencontainers.image.title': 'LoopTroop',
    })
    expect(readImageProvenance(raw)).toEqual({ version: '0.5.0', revision: 'c'.repeat(40) })
  })

  it('is null for each label an image does not carry', () => {
    expect(readImageProvenance(config(undefined))).toEqual({ version: null, revision: null })
    expect(readImageProvenance(config({ 'org.opencontainers.image.version': '0.5.0' })).revision).toBeNull()
  })
})

describe('isOurRelease', () => {
  const SHA = 'c'.repeat(40)

  it('accepts an earlier publish of the same version from the same commit', () => {
    // A rebuild of a released version has different digests by design — the base
    // image and the package repositories move — so the labels are what say
    // whether the image already on the tag is this release's own.
    expect(isOurRelease({ version: '0.5.0', revision: SHA }, '0.5.0', SHA)).toBe(true)
  })

  it('refuses an image built from another commit, or for another version', () => {
    expect(isOurRelease({ version: '0.5.0', revision: 'd'.repeat(40) }, '0.5.0', SHA)).toBe(false)
    expect(isOurRelease({ version: '9.9.9', revision: SHA }, '0.5.0', SHA)).toBe(false)
  })

  it('refuses an unlabelled image rather than assuming it is ours', () => {
    expect(isOurRelease({ version: null, revision: null }, '0.5.0', SHA)).toBe(false)
    expect(isOurRelease({ version: '0.5.0', revision: null }, '0.5.0', SHA)).toBe(false)
  })
})
