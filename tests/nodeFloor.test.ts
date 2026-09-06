import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatNodeVersion, parseNodeFloor, parseNodeVersion, satisfiesNodeFloor } from '../shared/nodeFloor'
import { satisfiesFloor } from '../scripts/installer-core.mjs'
import {
  NODE_FLOOR_EXACT,
  NODE_FLOOR_MAJOR,
  renderAurPackage,
  renderHomebrewFormula,
  renderNuspec,
} from '../scripts/package-manifests.ts'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relative: string) => readFileSync(resolve(repoRoot, relative), 'utf8')

const engines = (JSON.parse(read('package.json')) as { engines: { node: string } }).engines.node
const FLOOR = parseNodeFloor(engines)
const FLOOR_LABEL = formatNodeVersion(FLOOR)

const INPUTS = {
  version: '9.9.9',
  url: 'https://github.com/looptroop-ai/LoopTroop/releases/download/v9.9.9/looptroop-9.9.9-bundle.tar.gz',
  sha256: '3c5fe4640000000000000000000000000000000000000000000000000000abcd',
}

/**
 * §11.5: the Node floor was stated in five places with three different answers,
 * and a machine on 24.15–24.17 passed `doctor` and the read-only install
 * verifier before hitting a launcher that refused to start.
 *
 * `engines.node` is now the only place it is written by hand. Everything below
 * is a copy generated from it or derived from it, and this is what keeps them
 * from drifting apart again between releases — `npm run installers:check` only
 * runs in the release workflow.
 */
describe('the Node floor is stated once', () => {
  it('is a patch-level floor, so every consumer has something to compare', () => {
    expect(engines).toMatch(/^>=\d+\.\d+\.\d+$/)
  })

  // The launcher is covered by `cliLauncher.test.ts`, which runs its guard.

  it('is what both installer wrappers tell a reader to install', () => {
    expect(read('install.sh')).toContain(`LoopTroop needs Node.js ${FLOOR_LABEL} or newer`)
    expect(read('install.ps1')).toContain(`LoopTroop needs Node.js ${FLOOR_LABEL} or newer`)
    expect(read('install.sh')).toContain('brew install node')
    // Not `node@<major>`: that formula is keg-only, so it installs Node without
    // putting it on PATH and the reader lands back on the same message.
    expect(read('install.sh')).not.toContain(`brew install node@${FLOOR.major}`)
  })

  /**
   * The verifier predicts what the launcher will do when the shim resolves a
   * Node on PATH, so a runtime the two disagree about is the one case it exists
   * to report clearly and the one it used to get wrong: its private comparison
   * dropped the prerelease suffix, so `24.18.1-rc.1` "met the floor" and the run
   * failed later, at `start succeeds`, as a launcher refusal wearing a read-only
   * failure's clothes.
   *
   * It now asks `installer-core.mjs`, which is what `curl | sh` asks. This holds
   * that answer to `shared/nodeFloor.ts`'s — the launcher's and doctor's — for
   * every runtime either of them can disagree about, so the verifier is correct
   * by construction rather than by a source-text assertion.
   */
  it('is what the read-only install verifier enforces, via the installer comparison', () => {
    // The verifier ends in `await main()`, so it cannot be imported and asked.
    // These two lines are the whole of what a source-text gate can prove: that
    // it delegates, and that it kept no second comparison to drift.
    const verifier = read('scripts/verify-readonly-install.mjs')
    expect(verifier).not.toMatch(/REQUIRED_NODE = \{ major: \d/)
    expect(verifier).toContain('satisfiesFloor(version, NODE_FLOOR_SPEC)')
    expect(verifier).not.toMatch(/have\.(major|minor|patch)/)

    const runtimes = [
      FLOOR_LABEL,
      `${FLOOR_LABEL}-rc.1`,
      `${FLOOR.major}.${FLOOR.minor}.${FLOOR.patch + 1}`,
      `${FLOOR.major}.${FLOOR.minor - 1}.99`,
      `${FLOOR.major + 1}.0.0`,
      `${FLOOR.major + 1}.0.0-nightly20260101`,
      `v${FLOOR_LABEL}`,
      `${FLOOR.major - 1}.99.99`,
    ]
    for (const runtime of runtimes) {
      expect([runtime, satisfiesFloor(runtime, engines)])
        .toEqual([runtime, satisfiesNodeFloor(parseNodeVersion(runtime), FLOOR)])
    }
    // The pair that used to differ, named rather than left to the loop.
    expect(satisfiesFloor(`${FLOOR_LABEL}-rc.1`, engines)).toBe(false)
    expect(satisfiesFloor(FLOOR_LABEL, engines)).toBe(true)
    expect(satisfiesFloor(FLOOR_LABEL, 'not-a-range')).toBe(false)
    expect(satisfiesFloor(FLOOR_LABEL, `>=${FLOOR_LABEL}-rc.1`)).toBe(false)
  })

  /**
   * Only Chocolatey can express a patch level. Homebrew pins a keg and Arch has
   * no versioned package, so both carry the major — a translation of the same
   * floor, which is why they are asserted against it rather than left alone.
   */
  it('is what each package channel declares, in the form that channel allows', () => {
    expect(NODE_FLOOR_EXACT).toBe(FLOOR_LABEL)
    expect(NODE_FLOOR_MAJOR).toBe(String(FLOOR.major))
    expect(renderNuspec(INPUTS)).toContain(`<dependency id="nodejs-lts" version="${FLOOR_LABEL}" />`)
    expect(renderHomebrewFormula(INPUTS)).toContain(`depends_on "node@${FLOOR.major}"`)
    expect(renderAurPackage(INPUTS)['PKGBUILD']).toContain(`nodejs>=${FLOOR.major}`)
  })
})
