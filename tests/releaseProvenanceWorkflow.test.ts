import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = {
  id?: string
  if?: string
  name?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}
type Job = {
  needs?: string[]
  permissions?: Record<string, unknown>
  steps?: Step[]
}
type Workflow = { jobs?: Record<string, Job> }

const githubExpression = (value: string) => `\${{ ${value} }}`
const shellExpansion = (value: string) => `\${${value}}`

const workflow = load(readFileSync('.github/workflows/release.yml', 'utf8')) as Workflow
const attestationJob = workflow.jobs?.['attest-release-assets']
const draftJob = workflow.jobs?.['draft-release']
if (!attestationJob || !draftJob) throw new Error('Release workflow jobs are missing')
const draftSteps = draftJob.steps
if (!draftSteps) throw new Error('Draft release workflow steps are missing')

const step = (job: Job, name: string): Step => {
  const found = job.steps?.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`Release workflow step missing: ${name}`)
  return found
}

const runScript = (job: Job, name: string): string => {
  const run = step(job, name).run
  if (!run) throw new Error(`Release workflow step has no run command: ${name}`)
  return run
}

const verifyRun = runScript(draftJob, 'Verify the release provenance')
const draftRun = runScript(draftJob, 'Create or update the draft release')
const uploadRun = runScript(draftJob, 'Attach the provenance bundle to the draft')

type Scenario = {
  dryRun?: boolean
  version?: string
  verifyStatus?: number
  draftStatus?: number
  viewStatus?: number
  isDraft?: boolean
  uploadStatus?: number
}

const runScenario = (options: Scenario = {}) => {
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
    '    printf "node" >> "$GH_CALLS"',
    '    printf " <%s>" "$@" >> "$GH_CALLS"',
    '    printf "\\n" >> "$GH_CALLS"',
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
    VERSION: options.version ?? '1.2.3',
    GH_CALLS: calls,
    VERIFY_STATUS: String(options.verifyStatus ?? 0),
    DRAFT_STATUS: String(options.draftStatus ?? 0),
    VIEW_STATUS: String(options.viewStatus ?? 0),
    RELEASE_IS_DRAFT: String(options.isDraft !== false),
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
      path: githubExpression('steps.provenance.outputs.bundle-path'),
      'if-no-files-found': 'error',
    })

    expect(draftJob.needs).toContain('attest-release-assets')
    const downloads = draftSteps.filter((candidate) => candidate.name === 'Download the provenance bundle')
    expect(downloads).toHaveLength(1)
    const download = downloads[0]
    if (!download) throw new Error('Provenance bundle download step is missing')
    expect(download.with).toMatchObject({
      name: 'release-provenance',
      path: expect.stringMatching(/^\$\{\{ steps\.artifact_raw_\d+\.outputs\.path \}\}$/),
      'skip-decompress': true,
      'digest-mismatch': 'error',
    })
    const extraction = draftSteps.find((candidate) => candidate.env?.ARTIFACT_DESTINATION === 'release-provenance')
    if (!extraction) throw new Error('Provenance bundle extraction step is missing')
    expect(extraction.env?.ARTIFACT_RAW).toBe(download.with?.path)
    const extractIndex = draftSteps.indexOf(extraction)
    const verifyIndex = draftSteps.indexOf(step(draftJob, 'Verify the release provenance'))
    const createIndex = draftSteps.indexOf(step(draftJob, 'Create or update the draft release'))
    expect(draftSteps.indexOf(download)).toBeLessThan(extractIndex)
    expect(extractIndex).toBeLessThan(verifyIndex)
    expect(verifyIndex).toBeLessThan(createIndex)
    expect(verifyRun).toContain('gh attestation verify release-manifest.json')
    expect(verifyRun).toContain('cp release-provenance/attestation.json release-provenance.sigstore.json')
    expect(draftJob.permissions).toEqual({ contents: 'write' })
    expect(attestationJob.permissions).toMatchObject({ 'id-token': 'write', attestations: 'write' })
  })

  it('uploads only the sidecar after a fresh check confirms the release is still a draft', () => {
    const upload = step(draftJob, 'Attach the provenance bundle to the draft')
    const create = step(draftJob, 'Create or update the draft release')
    expect(upload.if).toBe("needs.detect.outputs.dry_run == 'false'")
    expect(create.if).toBe("needs.detect.outputs.dry_run == 'false'")
    expect(draftSteps.indexOf(upload)).toBeGreaterThan(draftSteps.indexOf(create))
    expect(uploadRun).toContain(`gh release view "v${shellExpansion('VERSION')}" --json isDraft --jq`)
    expect(uploadRun).toContain(`gh release upload "v${shellExpansion('VERSION')}" release-provenance.sigstore.json --clobber`)

    const result = runScenario()
    expect(result.verification.status).toBe(0)
    expect(
      result.draft?.status,
      `draft stderr: ${result.draft?.stderr || '(empty or subprocess did not run)'}`,
    ).toBe(0)
    expect(result.upload?.status).toBe(0)
    expect(result.calls.split('\n').filter((line) => line.startsWith('node '))).toEqual([
      'node <scripts/release-draft.ts> <--version> <1.2.3> <--manifest> <release-manifest.json> <--dir> <.> <--notes> </tmp/notes.md>',
    ])
    expect(result.calls).toContain('release view v1.2.3 --json isDraft --jq .isDraft')
    expect(result.calls).toContain('release upload v1.2.3 release-provenance.sigstore.json --clobber')
    expect(result.calls.split('\n').filter((line) => line.startsWith('gh attestation verify '))).toEqual([
      'gh attestation verify release-manifest.json --repo looptroop-ai/LoopTroop --bundle release-provenance/attestation.json --signer-workflow looptroop-ai/LoopTroop/.github/workflows/release.yml --source-digest 0123456789abcdef0123456789abcdef01234567',
    ])
    expect(result.copiedBundle).toBe('{"fixture":"native signed bundle"}\n')
  })

  it('passes one prerelease flag for a prerelease version', () => {
    const result = runScenario({ version: '1.2.3-rc.1' })

    expect(
      result.draft?.status,
      `draft stderr: ${result.draft?.stderr || '(empty or subprocess did not run)'}`,
    ).toBe(0)
    expect(result.calls.split('\n').filter((line) => line.startsWith('node '))).toEqual([
      'node <scripts/release-draft.ts> <--version> <1.2.3-rc.1> <--manifest> <release-manifest.json> <--dir> <.> <--notes> </tmp/notes.md> <--prerelease>',
    ])
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
    ['verification fails', { verifyStatus: 1 }, { verification: 1, draft: undefined, upload: undefined }],
    ['draft creation fails', { draftStatus: 1 }, { verification: 0, draft: 1, upload: undefined }],
    ['release-state lookup fails', { viewStatus: 1 }, { verification: 0, draft: 0, upload: 1 }],
    ['release is already published', { isDraft: false }, { verification: 0, draft: 0, upload: 1 }],
  ] as const)('%s without uploading the sidecar', (_name, options, expected) => {
    const result = runScenario(options)
    expect(result.verification.status).toBe(expected.verification)
    expect(result.draft?.status).toBe(expected.draft)
    expect(result.upload?.status).toBe(expected.upload)
    expect(result.calls).not.toContain('release upload v1.2.3 release-provenance.sigstore.json --clobber')
  })

  it('fails the draft job if uploading the sidecar fails', () => {
    const result = runScenario({ uploadStatus: 1 })
    expect(
      result.upload?.status,
      `upload stderr: ${result.upload?.stderr || '(empty or subprocess did not run)'}; draft stderr: ${result.draft?.stderr || '(empty)'}`,
    ).toBe(1)
    expect(result.calls).toContain('release upload v1.2.3 release-provenance.sigstore.json --clobber')
  })
})
