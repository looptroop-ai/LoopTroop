import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const repo = process.cwd()
const digest = 'a'.repeat(64)

function manifest(extraAssets: Record<string, unknown> = {}) {
  return {
    name: 'looptroop',
    version: '1.2.3',
    commit: 'b'.repeat(40),
    tarball: 'looptroop-1.2.3.tgz',
    bytes: 1,
    sha256: digest,
    integrity: 'sha512-test',
    assets: {
      'looptroop-1.2.3.tgz': { bytes: 1, sha256: digest, integrity: 'sha512-test' },
      'looptroop-1.2.3-bundle.tar.gz': { bytes: 2, sha256: digest },
      ...extraAssets,
    },
  }
}

function run(manifestValue: unknown, ...args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'looptroop-channel-inputs-'))
  const path = join(directory, 'release-manifest.json')
  writeFileSync(path, JSON.stringify(manifestValue))
  const env: NodeJS.ProcessEnv = { ...process.env, GITHUB_REPOSITORY: 'owner/name' }
  delete env.GITHUB_OUTPUT
  try {
    return spawnSync(process.execPath, ['scripts/channel-inputs.ts', '--manifest', path, ...args], {
      cwd: repo,
      env,
      encoding: 'utf8',
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('channel-inputs', () => {
  it('renders channel values from a valid manifest', () => {
    const result = run(manifest())
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('version=1.2.3')
    expect(result.stdout).toContain('bundle=looptroop-1.2.3-bundle.tar.gz')
    expect(result.stdout).toContain('url=https://github.com/owner/name/releases/download/v1.2.3/looptroop-1.2.3-bundle.tar.gz')
  })

  it.each([
    'looptroop-1.2.3-bundle$(touch marker)-bundle.tar.gz',
    'looptroop-1.2.3-bundle name-bundle.tar.gz',
    'looptroop-1.2.3-bundle"quote-bundle.tar.gz',
  ])('rejects unsafe manifest asset basename %j', (name) => {
    const result = run(manifest({ [name]: { bytes: 1, sha256: digest } }))
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unsafe asset name')
  })

  it('rejects unknown options and positional arguments', () => {
    expect(run(manifest(), '--typo', 'value').status).not.toBe(0)
    expect(run(manifest(), 'stray').status).not.toBe(0)
  })
})
