import { describe, expect, it } from 'vitest'
import {
  classifyRegistryFailure,
  isRateLimited,
  parseIndex,
  planTags,
  platformDigest,
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
    })
  })

  it('publishes only the version and next for a prerelease', () => {
    expect(planTags('0.5.0-rc.1', 'next')).toEqual({
      stable: false,
      series: '0.5',
      tags: ['0.5.0-rc.1', 'next'],
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
  it('is empty for a stable release, which moves both floating tags', () => {
    expect(tagsThatMustNotMove(planTags('0.5.0', 'latest'))).toEqual([])
  })

  it('protects latest and the series during a prerelease', () => {
    expect(tagsThatMustNotMove(planTags('0.5.0-rc.1', 'next'))).toEqual(['latest', '0.5'])
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
