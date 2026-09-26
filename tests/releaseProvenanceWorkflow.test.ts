import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
}
type Job = {
  needs?: string[]
  permissions?: Record<string, unknown>
  steps?: Step[]
}
type Workflow = { jobs?: Record<string, Job> }

const workflow = yaml.load(readFileSync('.github/workflows/release.yml', 'utf8')) as Workflow
const attestationJob = workflow.jobs?.['attest-release-assets']
const draftJob = workflow.jobs?.['draft-release']

function step(job: Job | undefined, name: string): Step {
  const found = job?.steps?.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Release workflow step missing: ${name}`)
  return found
}

const verifyRun = step(draftJob, 'Verify the release provenance').run!
const draftRun = step(draftJob, 'Create or update the draft release').run!
const uploadRun = step(draftJob, 'Attach the provenance bundle to the draft').run!

type Scenario = {
  dryRun?: boolean
  verifyStatus?: number
  draftStatus?: number
  viewStatus?: number
  isDraft?: boolean
  uploadStatus?: number
}

function runScenario(options: Scenario = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'looptroop-provenance-'))
  const provenance = join(directory, 'release-provenance')
  const bundle = '{"fixture":"native signed bundle"}\n'
  mkdirSync(provenance)
  writeFileSync(join(provenance, 'attestation.json'), bundle)
  const calls = join(directory, 'calls')
  const fixture = [
    'gh() {',
    '  printf "gh" >> "$GH_CALLS"',
    '  printf " %s" "$@" >> "$GH_CALLS"',
    '  printf "\\n" >> "$GH_CALLS"',
    '  if [ "$1 $2" = "attestation verify" ]; then return "$VERIFY_STATUS"; fi',
    '  if [ "$1 $2" = "release view" ]; then',
    '    if [ "$VIEW_STATUS" -ne 0 ]; then return "$VIEW_STATUS"; fi',
    '    printf "%s\\n" "$RELEASE_IS_DRAFT"',
    '    return 0',
    '  fi',
    '  if [ "$1 $2" = "release upload" ]; then return "$UPLOAD_STATUS"; fi',
    '  return 99',
    '}',
    'node() {',
    '  if [ "$1" = "scripts/release-draft.ts" ]; then',
    '    printf "node %s\\n" "$*" >> "$GH_CALLS"',
    '    return "$DRAFT_STATUS"',
    '  fi',
    '  command node "$@"',
    '}',
    '',
  ].join('\n')
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: 'looptroop-ai/LoopTroop',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    VERSION: '1.2.3',
    GH_CALLS: calls,
    VERIFY_STATUS: String(options.verifyStatus ?? 0),
    DRAFT_STATUS: String(options.draftStatus ?? 0),
    VIEW_STATUS: String(options.viewStatus ?? 0),
    RELEASE_IS_DRAFT: options.isDraft === false ? 'false' : 'true',
    UPLOAD_STATUS: String(options.uploadStatus ?? 0),
  }
  const execute = (run: string) => spawnSync('bash', ['-euo', 'pipefail', '-c', fixture + run], {
    cwd: directory,
    encoding: 'utf8',
    env,
  })

  try {
    const verification = execute(verifyRun)
    let draft: ReturnType<typeof execute> | undefined
    let upload: ReturnType<typeof execute> | undefined
    if (verification.status === 0 && options.dryRun !== true) {
      draft = execute(draftRun)
      if (draft.status === 0) upload = execute(uploadRun)
    }
    return {
      verification,
      draft,
      upload,
      calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '',
      copiedBundle: existsSync(join(directory, 'release-provenance.sigstore.json'))
        ? readFileSync(join(directory, 'release-provenance.sigstore.json'), 'utf8')
        : null,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('release provenance workflow', () => {
  it('preserves the native bundle and verifies it in the draft job before release creation', () => {
    const attest = step(attestationJob, 'Attest the release assets')
    const preserve = step(attestationJob, 'Preserve the provenance bundle')
    expect(attest.id).toBe('provenance')
    expect(preserve.uses).toMatch(/^actions\/upload-artifact@/)
    expect(preserve.with).toMatchObject({
      name: 'release-provenance',
      path: '${{ steps.provenance.outputs.bundle-path }}',
      'if-no-files-found': 'error',
    })

    expect(draftJob?.needs).toContain('attest-release-assets')
    const steps = draftJob!.steps!
    const downloads = steps.filter((candidate) => candidate.name === 'Download the provenance bundle')
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.with).toMatchObject({ name: 'release-provenance', path: 'release-provenance' })
    const verifyIndex = steps.indexOf(step(draftJob, 'Verify the release provenance'))
    const createIndex = steps.indexOf(step(draftJob, 'Create or update the draft release'))
    expect(verifyIndex).toBeLessThan(createIndex)
    expect(verifyRun).toContain('gh attestation verify release-manifest.json')
    expect(verifyRun).toContain('--bundle release-provenance/attestation.json')
    expect(verifyRun).toContain('--signer-workflow "${GITHUB_REPOSITORY}/.github/workflows/release.yml"')
    expect(verifyRun).toContain('--source-digest "${GITHUB_SHA}"')
    expect(verifyRun).toContain('cp release-provenance/attestation.json release-provenance.sigstore.json')
    expect(draftJob?.permissions).toEqual({ contents: 'write' })
    expect(attestationJob?.permissions).toMatchObject({ 'id-token': 'write', attestations: 'write' })
  })

  it('uploads only the sidecar after a fresh check confirms the release is still a draft', () => {
    const upload = step(draftJob, 'Attach the provenance bundle to the draft')
    const steps = draftJob!.steps!
    expect(upload.if).toBe("needs.detect.outputs.dry_run == 'false'")
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(step(draftJob, 'Create or update the draft release')))
    expect(uploadRun).toContain('gh release view "v${VERSION}" --json isDraft --jq')
    expect(uploadRun).toContain('gh release upload "v${VERSION}" release-provenance.sigstore.json --clobber')

    const result = runScenario()
    expect(result.verification.status).toBe(0)
    expect(result.draft?.status).toBe(0)
    expect(result.upload?.status).toBe(0)
    expect(result.calls).toContain('release view v1.2.3 --json isDraft --jq .isDraft')
    expect(result.calls).toContain('release upload v1.2.3 release-provenance.sigstore.json --clobber')
    expect(result.copiedBundle).toBe('{"fixture":"native signed bundle"}\n')
  })

  it('verifies during dry runs without creating or uploading a GitHub release', () => {
    const result = runScenario({ dryRun: true })
    expect(result.verification.status).toBe(0)
    expect(result.calls).toContain('attestation verify release-manifest.json')
    expect(result.calls).not.toMatch(/release (?:view|upload)/)
    expect(result.calls).not.toContain('scripts/release-draft.ts')
    expect(result.copiedBundle).toBe('{"fixture":"native signed bundle"}\n')
  })

  it.each([
    ['verification fails', { verifyStatus: 1 }],
    ['draft creation fails', { draftStatus: 1 }],
    ['release-state lookup fails', { viewStatus: 1 }],
    ['release is already published', { isDraft: false }],
  ] as const)('%s without uploading the sidecar', (_name, options) => {
    const result = runScenario(options)
    expect(result.upload?.status).not.toBe(0)
    expect(result.calls).not.toContain('release upload v1.2.3 release-provenance.sigstore.json --clobber')
  })

  it('fails the draft job if uploading the sidecar fails', () => {
    const result = runScenario({ uploadStatus: 1 })
    expect(result.upload?.status).toBe(1)
    expect(result.calls).toContain('release upload v1.2.3 release-provenance.sigstore.json --clobber')
  })
})
