import { afterEach, describe, expect, it } from 'vitest'
import { makeTempDir, removeTempDir } from '../server/test/tempDir'
import { getLatestToolVersions, TOOL_CHECK_INTERVAL_MS } from '../server/lib/toolVersions'

const tempDirs: string[] = []

function fixtureFetch(requested: string[]): typeof fetch {
  return async (input) => {
    const url = String(input)
    requested.push(url)
    const body = url.endsWith('/opencode-ai/latest')
      ? { version: '1.18.32' }
      : url.endsWith('/@opencode/cli/latest')
        ? { version: '2.0.16' }
        : url.endsWith('/repos/cli/cli/releases/latest')
          ? { tag_name: 'v2.83.0' }
          : url.endsWith('/repos/git/git/tags?per_page=100')
            ? [{ name: 'v2.50.1' }]
            : { version: '24.8.0' }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) removeTempDir(dir)
  }
})

describe('latest OpenCode version source', () => {
  it.each([
    ['1.18.21', 'https://registry.npmjs.org/opencode-ai/latest', '1.18.32'],
    ['2.0.15', 'https://registry.npmjs.org/@opencode/cli/latest', '2.0.16'],
  ])('uses the v%s installed CLI package', async (installed, expectedSource, latest) => {
    const configDir = makeTempDir('looptroop-tool-versions-')
    tempDirs.push(configDir)
    const requested: string[] = []

    const versions = await getLatestToolVersions({
      configDir,
      fetchImpl: fixtureFetch(requested),
      now: () => Date.parse('2026-09-24T00:00:00.000Z'),
      opencodeVersion: installed,
    })

    expect(versions.opencode).toBe(latest)
    expect(requested).toContain(expectedSource)
    expect(requested.filter((url) => /registry\.npmjs\.org\/(?:@opencode\/cli|opencode-ai)\/latest/.test(url)))
      .toEqual([expectedSource])
  })

  it('does not reuse one major source cache for another major', async () => {
    const configDir = makeTempDir('looptroop-tool-versions-')
    tempDirs.push(configDir)
    const now = () => Date.parse('2026-09-24T00:00:00.000Z')
    const firstRequests: string[] = []

    expect((await getLatestToolVersions({
      configDir,
      fetchImpl: fixtureFetch(firstRequests),
      now,
      opencodeVersion: '1.18.21',
    })).opencode).toBe('1.18.32')

    const secondRequests: string[] = []
    const second = await getLatestToolVersions({
      configDir,
      fetchImpl: fixtureFetch(secondRequests),
      now,
      opencodeVersion: '2.0.15',
    })

    expect(second.opencode).toBe('2.0.16')
    expect(secondRequests).toContain('https://registry.npmjs.org/@opencode/cli/latest')
    expect(secondRequests).not.toContain('https://registry.npmjs.org/opencode-ai/latest')
  })

  it('reuses a fresh cache for the same OpenCode package source without requests', async () => {
    const configDir = makeTempDir('looptroop-tool-versions-')
    tempDirs.push(configDir)
    const now = () => Date.parse('2026-09-24T00:00:00.000Z')

    await getLatestToolVersions({
      configDir,
      fetchImpl: fixtureFetch([]),
      now,
      opencodeVersion: '2.0.15',
    })

    const requested: string[] = []
    const cached = await getLatestToolVersions({
      configDir,
      fetchImpl: fixtureFetch(requested),
      now,
      opencodeVersion: '2.0.16',
    })

    expect(requested).toEqual([])
    expect(cached.opencode).toBe('2.0.16')
  })

  it('keeps a stale same-source OpenCode version when the registry is offline', async () => {
    const configDir = makeTempDir('looptroop-tool-versions-')
    tempDirs.push(configDir)
    let now = Date.parse('2026-09-24T00:00:00.000Z')

    await getLatestToolVersions({
      configDir,
      fetchImpl: fixtureFetch([]),
      now: () => now,
      opencodeVersion: '2.0.15',
    })

    now += TOOL_CHECK_INTERVAL_MS + 1
    const requested: string[] = []
    const offlineFetch: typeof fetch = async (input) => {
      requested.push(String(input))
      throw new Error('offline')
    }
    const stale = await getLatestToolVersions({
      configDir,
      fetchImpl: offlineFetch,
      now: () => now,
      opencodeVersion: '2.0.15',
    })

    expect(requested).toContain('https://registry.npmjs.org/@opencode/cli/latest')
    expect(stale.opencode).toBe('2.0.16')
  })

  it('leaves the latest version unknown when the installed major has no verified package source', async () => {
    const configDir = makeTempDir('looptroop-tool-versions-')
    tempDirs.push(configDir)
    const requested: string[] = []

    const versions = await getLatestToolVersions({
      configDir,
      fetchImpl: fixtureFetch(requested),
      now: () => Date.parse('2026-09-24T00:00:00.000Z'),
      opencodeVersion: '3.0.0',
    })

    expect(versions.opencode).toBeNull()
    expect(requested.some((url) => /registry\.npmjs\.org\/(?:@opencode\/cli|opencode-ai)\/latest/.test(url))).toBe(false)
  })
})
