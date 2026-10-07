import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = { id?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }
type Job = { steps: Step[]; permissions?: Record<string, string>; environment?: unknown }
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, Job> }
const repo = process.cwd()
const actionPath = join(repo, '.github/actions/download-artifact')
const python = process.platform === 'win32' ? 'python' : 'python3'
const workflows = readdirSync(join(repo, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name)).map((file) => ({
  file, workflow: yaml.load(readFileSync(join(repo, '.github/workflows', file), 'utf8')) as Workflow,
}))
const extractor = readFileSync(join(actionPath, 'extract.py'), 'utf8')
const embeddedPython = (run: string) => run.match(/- <<'PY'\n([\s\S]*)\nPY\n?$/)?.[1] + '\n'

describe('verified artifact downloads', () => {
  it('keeps digest checks on every download without running repository tooling beside credentials', () => {
    const action = yaml.load(readFileSync(join(actionPath, 'action.yml'), 'utf8')) as { runs: { steps: Step[] } }
    const download = action.runs.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))
    expect(download?.uses).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/)
    expect(download?.with).toMatchObject({ 'skip-decompress': true, 'digest-mismatch': 'error', 'merge-multiple': false })
    expect(action.runs.steps[0]?.run).toContain('tempfile.mkdtemp(')
    expect(action.runs.steps[0]?.run).toContain('"$python_command" -I -')
    expect(action.runs.steps[2]?.run).toContain('"$python_command" -I "$GITHUB_ACTION_PATH/extract.py"')
    let count = 0
    for (const { file, workflow } of workflows) {
      for (const [job, { steps = [], permissions, environment }] of Object.entries(workflow.jobs)) {
        const privileged = Object.values(permissions ?? workflow.permissions ?? {}).includes('write') ||
          Boolean(environment) || JSON.stringify(steps).includes('secrets.')
        const downloadIds = new Set<string>()
        for (const [index, step] of steps.entries()) {
          const official = step.uses?.startsWith('actions/download-artifact@')
          const local = step.uses?.endsWith('/.github/actions/download-artifact')
          if (!official && !local) continue
          count++
          if (privileged) {
            expect(step.uses, `${file}:${job} cannot execute a checked-out helper`).toMatch(/^actions\/download-artifact@[a-f0-9]{40}$/)
            expect(step.with).toMatchObject({ 'skip-decompress': true, 'digest-mismatch': 'error', 'merge-multiple': false })
            const prepare = steps[index - 1]
            expect(prepare?.id).toMatch(/^artifact_raw_\d+$/)
            expect(downloadIds.has(prepare!.id!)).toBe(false)
            downloadIds.add(prepare!.id!)
            expect(prepare?.run).toContain('tempfile.mkdtemp(')
            expect(prepare?.run).toContain('"$python_command" -I -')
            expect(step.with?.path).toBe('${{ steps.' + prepare!.id + '.outputs.path }}')
            const extraction = steps[index + 1]
            expect(extraction?.env?.ARTIFACT_RAW).toBe(step.with?.path)
            expect(extraction?.env?.ARTIFACT_DESTINATION).toBeDefined()
            expect(extraction?.env?.ARTIFACT_MERGE).toMatch(/^(true|false)$/)
            expect(embeddedPython(extraction?.run ?? '')).toBe(extractor)
            expect(extraction?.run).toContain('"$python_command" -I -')
            continue
          }
          expect(step.uses).toBe('./.github/actions/download-artifact')
          const checkout = steps.slice(0, index).find((candidate) => candidate.uses?.startsWith('actions/checkout@') &&
            candidate.with?.path === undefined)
          expect(checkout, `${file}:${job} checks out its local action first`).toBeDefined()
          if (checkout?.with?.['sparse-checkout']) {
            expect(String(checkout.with['sparse-checkout']).split(/\s+/)).toContain('.github/actions/download-artifact')
          }
        }
      }
    }
    expect(count).toBeGreaterThan(0)
    const arch = readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')
    expect(arch).toMatch(/pacman -Syyu[^\n]*\bpython\b/)
    const release = workflows.find(({ file }) => file === 'release.yml')!.workflow
    expect(release.jobs.npm!.steps.find((step) => step.uses?.startsWith('actions/checkout@'))?.with)
      .toMatchObject({ 'sparse-checkout': '.nvmrc', 'sparse-checkout-cone-mode': false, 'persist-credentials': false })
    for (const job of ['attest-binaries', 'attest-release-assets']) {
      expect(release.jobs[job]!.steps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false)
    }
  })

  it('extracts named, nested and merged artifacts and rejects paths that escape', () => {
    const implementations = [extractor, ...workflows.flatMap(({ workflow }) => {
      const run = Object.values(workflow.jobs).flatMap(({ steps = [] }) => steps)
        .find((step) => step.env?.ARTIFACT_RAW && step.run)?.run
      return run ? [embeddedPython(run)] : []
    })]
    for (const implementation of implementations) {
      const directory = mkdtempSync(join(tmpdir(), 'looptroop-artifact-extraction-'))
      try {
        for (const name of ['zipfile', 'tempfile', 'pathlib']) {
          writeFileSync(join(directory, name + '.py'), 'raise RuntimeError("Untrusted repository module executed")\n')
        }
        const result = spawnSync(python, ['-I', '-c', String.raw`
import os, pathlib, stat, sys, zipfile
root, helper = pathlib.Path(sys.argv[1]), sys.argv[2]
raw, output = root / 'raw', root / 'output'
def extract(entries, merge=False, symlink=False):
    raw.mkdir()
    for archive, name in entries.items():
        path = raw / archive
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, 'w') as target:
            entry = zipfile.ZipInfo(name)
            if symlink: entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            target.writestr(entry, 'fixture')
    os.environ.update(ARTIFACT_RAW=str(raw), ARTIFACT_DESTINATION=str(output), ARTIFACT_MERGE=str(merge).lower())
    try:
        exec(compile(helper, '<artifact extractor>', 'exec'), {'__name__': '__main__'})
    except ValueError as error:
        return str(error)
    return ''
assert extract({'artifact.zip': 'nested/named.txt'}) == ''
assert (output / 'nested/named.txt').read_text() == 'fixture'
assert extract({'artifact': 'without-zip-extension.txt'}) == ''
assert (output / 'without-zip-extension.txt').read_text() == 'fixture'
assert extract({'first/artifact.zip': 'a.txt', 'second/artifact.zip': 'b.txt'}) == ''
assert (output / 'first/a.txt').read_text() == (output / 'second/b.txt').read_text() == 'fixture'
assert extract({'first/artifact.zip': 'merged-a.txt', 'second/artifact.zip': 'merged-b.txt'}, merge=True) == ''
assert (output / 'merged-a.txt').read_text() == (output / 'merged-b.txt').read_text() == 'fixture'
for name in ['../escape.txt', '/absolute.txt', r'C:\escape.txt', r'..\escape.txt']:
    assert 'Unsafe artifact path' in extract({'artifact.zip': name}), name
assert 'Unsafe artifact path' in extract({'artifact.zip': 'link'}, symlink=True)
# Creating filesystem links requires elevation on some Windows runners.
if os.name != 'nt':
    outside = root / 'outside.txt'
    outside.write_text('untouched')
    (output / 'existing-link').symlink_to(outside)
    assert 'Artifact path escapes destination' in extract({'artifact.zip': 'existing-link'})
    assert outside.read_text() == 'untouched'
assert not (root / 'escape.txt').exists()
assert not raw.exists()
assert extract({}) == ''
assert not raw.exists()
`, directory, implementation], { encoding: 'utf8', cwd: directory })
        expect(result.status, result.stderr).toBe(0)
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  })
})
