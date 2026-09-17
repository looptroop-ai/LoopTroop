import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const repo = process.cwd()

function fixtureScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

describe('release script argument contracts', () => {
  it('uses the pinned native SEA builder without a legacy injector fallback', () => {
    const builder = readFileSync(join(repo, 'scripts/build-binary.mjs'), 'utf8')

    expect(builder).toContain("const EMBEDDED_NODE_VERSION = 'v26.9.0'")
    expect(builder).toContain("['--build-sea', join(work, 'sea-config.json')]")
    expect(builder).toContain("mainFormat: 'commonjs'")
    expect(builder).toContain('output: binaryPath')
    expect(builder).toContain('useCodeCache: false')
    expect(builder).toContain('useSnapshot: false')
    expect(builder).not.toContain('postject')
    expect(builder).not.toContain('--experimental-sea-config')
    expect(builder).not.toContain('sea-prep.blob')
  })

  it('rejects malformed entrypoints before any release or build action', () => {
    const work = mkdtempSync(join(tmpdir(), 'looptroop-release-args-'))
    const marker = join(work, 'invoked')
    const packagePath = join(work, 'package.nupkg')
    const output = join(work, 'binary-output')
    const fixtureBin = join(work, 'bin')
    const fixtureRepo = join(work, 'brew-repository')
    const body = `printf x >> "$MARKER"\nif [ "$1" = "--repository" ]; then printf '%s' "$FIXTURE_REPO"; fi`

    try {
      writeFileSync(packagePath, 'fixture')
      // The named override lets the credential-bearing script be probed without
      // allowing a fake executable to win through its normal trusted PATH.
      mkdirSync(fixtureBin, { recursive: true })
      fixtureScript(join(work, 'choco'), body)
      fixtureScript(join(fixtureBin, 'git'), body)
      fixtureScript(join(fixtureBin, 'brew'), body)
      const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${fixtureBin}${delimiter}${process.env.PATH ?? ''}`,
        MARKER: marker,
        FIXTURE_REPO: fixtureRepo,
        CHOCOLATEY_API_KEY: 'test-only-no-publish',
        AUR_SSH_KEY: 'test-only-key',
        AUR_KNOWN_HOSTS: 'test-only-known-host',
        LOOPTROOP_CHOCO_PATH: join(work, 'choco'),
      }

      const scripts = [
        {
          path: 'scripts/choco-push.ts',
          base: ['--nupkg', packagePath, '--version', '9.9.9'],
          cases: [
            ['unknown option', ['--typo', 'value'], 'Unknown option --typo'],
            ['positional extra', ['stray'], 'Unexpected argument'],
            ['missing value', ['--version'], 'needs a value'],
            ['flag swallowed as value', ['--version', '--nupkg'], 'needs a value, but is followed by --nupkg'],
          ],
        },
        {
          path: 'scripts/aur-push.ts',
          base: ['--version', '9.9.9', '--url', 'https://example.invalid/bundle.tar.gz', '--sha256', 'a'.repeat(64)],
          cases: [
            ['unknown option', ['--typo', 'value'], 'Unknown option --typo'],
            ['positional extra', ['stray'], 'Unexpected argument'],
            ['missing value', ['--version'], 'needs a value'],
            ['flag swallowed as value', ['--version', '--url'], 'needs a value, but is followed by --url'],
          ],
        },
        {
          path: 'scripts/audit-formula.ts',
          base: ['--version', '9.9.9', '--url', 'https://example.invalid/bundle.tar.gz', '--sha256', 'a'.repeat(64)],
          cases: [
            ['unknown option', ['--typo', 'value'], 'Unknown option --typo'],
            ['positional extra', ['stray'], 'Unexpected argument'],
            ['missing value', ['--version'], 'needs a value'],
            ['flag swallowed as value', ['--version', '--url'], 'needs a value, but is followed by --url'],
          ],
        },
        {
          path: 'scripts/build-binary.mjs',
          base: ['--out', output],
          cases: [
            ['unknown option', ['--typo', 'value'], 'Unknown option --typo'],
            ['positional extra', ['stray'], 'Unexpected argument'],
            ['missing value', ['--out'], 'needs a value'],
            ['flag swallowed as value', ['--out', '--typo'], 'needs a value, but is followed by --typo'],
          ],
        },
      ] as const

      for (const script of scripts) {
        for (const [label, extra, diagnostic] of script.cases) {
          rmSync(marker, { force: true })
          const result = spawnSync(process.execPath, [script.path, ...script.base, ...extra], {
            cwd: repo,
            env: baseEnv,
            encoding: 'utf8',
            timeout: 10_000,
          })

          expect(result.error, `${script.path} ${label}`).toBeUndefined()
          expect(result.status, `${script.path} ${label}`).not.toBe(0)
          expect(result.stderr, `${script.path} ${label}`).toContain(diagnostic)
          expect(existsSync(marker) ? readFileSync(marker, 'utf8') : '', `${script.path} ${label}`).toBe('')
          if (script.path === 'scripts/build-binary.mjs') {
            expect(result.stdout, `${script.path} ${label}`).not.toContain('Bundling the entry point')
          }
        }
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }, 45_000)
})
