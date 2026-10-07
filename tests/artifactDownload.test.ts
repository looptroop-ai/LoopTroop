import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

type Step = { id?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string>; run?: string }
type Permissions = Record<string, string> | string
type Job = { steps?: Step[]; permissions?: Permissions; environment?: unknown; env?: Record<string, string> }
type Workflow = { permissions?: Permissions; env?: Record<string, string>; jobs: Record<string, Job> }
const repo = process.cwd()
const actionPath = join(repo, '.github/actions/download-artifact')
const python = process.platform === 'win32' ? 'python' : 'python3'
const workflows = readdirSync(join(repo, '.github/workflows')).filter((name) => /\.ya?ml$/.test(name)).map((file) => ({
  file, workflow: yaml.load(readFileSync(join(repo, '.github/workflows', file), 'utf8')) as Workflow,
}))
const extractor = readFileSync(join(actionPath, 'extract.py'), 'utf8')
const embeddedPython = (run: string) => run.match(/- <<'PY'\n([\s\S]*)\nPY\n?$/)?.[1] + '\n'
const isPrivileged = (workflow: Omit<Workflow, 'jobs'>, job: Job) => {
  const permissions = job.permissions ?? workflow.permissions
  return permissions === undefined || (typeof permissions === 'string' ? permissions !== 'read-all' :
    Object.values(permissions).some((value) => value !== 'read' && value !== 'none')) ||
    Boolean(job.environment) || /\bsecrets\s*(?:\.|\[)/.test(JSON.stringify([workflow.env, job]))
}

describe('verified artifact downloads', () => {
  it('requires explicit read-only permissions and checks every secret scope', () => {
    const readOnly = { permissions: { contents: 'read' } }
    const token = { env: { GH_TOKEN: '${{ github.token }}' } }
    expect(isPrivileged({}, token)).toBe(true)
    expect(isPrivileged({ permissions: 'write-all' }, token)).toBe(true)
    expect(isPrivileged({ permissions: '${{ inputs.permissions }}' }, token)).toBe(true)
    expect(isPrivileged({ permissions: { contents: 'write' } }, token)).toBe(true)
    expect(isPrivileged({ permissions: 'read-all' }, token)).toBe(false)
    expect(isPrivileged(readOnly, token)).toBe(false)
    expect(isPrivileged({ permissions: 'write-all' }, { ...readOnly, ...token })).toBe(false)
    expect(isPrivileged({ permissions: {} }, {})).toBe(false)
    expect(isPrivileged({ ...readOnly, env: { TOKEN: '${{ secrets.TOKEN }}' } }, {})).toBe(true)
    expect(isPrivileged(readOnly, { env: { TOKEN: '${{ secrets["TOKEN"] }}' } })).toBe(true)
    expect(isPrivileged(readOnly, { steps: [{ env: { TOKEN: '${{ secrets.TOKEN }}' } }] })).toBe(true)
    expect(isPrivileged(readOnly, { environment: 'release' })).toBe(true)
  })

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
      for (const [job, definition] of Object.entries(workflow.jobs)) {
        const { steps = [] } = definition
        const privileged = isPrivileged(workflow, definition)
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
    expect(release.jobs.npm!.steps?.find((step) => step.uses?.startsWith('actions/checkout@'))?.with)
      .toMatchObject({ 'sparse-checkout': '.nvmrc', 'sparse-checkout-cone-mode': false, 'persist-credentials': false })
    for (const job of ['attest-binaries', 'attest-release-assets']) {
      expect(release.jobs[job]!.steps?.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(false)
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
workspace, runner_temp = root / 'workspace', root / 'runner-temp'
workspace.mkdir()
runner_temp.mkdir()
os.chdir(workspace)
raw, output = root / 'raw', workspace / 'output'
def extract(entries, merge=False, symlink=False, destination=output, workspace_root=workspace):
    raw.mkdir()
    for archive, name in entries.items():
        path = raw / archive
        path.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(path, 'w') as target:
            entry = zipfile.ZipInfo(name)
            if symlink: entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            target.writestr(entry, 'fixture')
    os.environ.update(ARTIFACT_RAW=str(raw), ARTIFACT_DESTINATION=str(destination), ARTIFACT_MERGE=str(merge).lower(),
                      GITHUB_WORKSPACE=str(workspace_root), RUNNER_TEMP=str(runner_temp))
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
assert extract({'artifact.zip': 'workspace.txt'}, destination='') == ''
assert (workspace / 'workspace.txt').read_text() == 'fixture'
assert extract({'artifact.zip': 'relative.txt'}, destination='relative') == ''
assert (workspace / 'relative/relative.txt').read_text() == 'fixture'
assert extract({'artifact.zip': 'temporary.txt'}, destination=runner_temp / 'nested') == ''
assert (runner_temp / 'nested/temporary.txt').read_text() == 'fixture'
assert 'Artifact destination escapes' in extract({'artifact.zip': 'external.txt'}, destination=root / 'outside')
assert not (root / 'outside').exists()
assert not raw.exists()
for name in ['../escape.txt', '/absolute.txt', r'C:\escape.txt', r'..\escape.txt']:
    assert 'Unsafe artifact path' in extract({'artifact.zip': name}), name
assert 'Unsafe artifact path' in extract({'artifact.zip': 'link'}, symlink=True)
if os.name == 'nt':
    for name in ['report.txt:payload', 'nested/report.txt:payload:$DATA', 'directory:stream/report.txt']:
        assert 'Unsafe artifact path' in extract({'artifact.zip': name}), name
        assert not raw.exists()
else:
    assert extract({'artifact.zip': 'nested/report.txt:payload'}) == ''
    assert (output / 'nested/report.txt:payload').read_text() == 'fixture'
# Exercise native Windows links too whenever this account can create them.
can_symlink = True
probe = root / 'symlink-probe'
try:
    probe.symlink_to(workspace, target_is_directory=True)
except OSError as error:
    if os.name != 'nt' or error.winerror != 1314:
        raise
    can_symlink = False
else:
    probe.unlink()
if can_symlink:
    outside = root / 'outside.txt'
    outside.write_text('untouched')
    (output / 'existing-link').symlink_to(outside)
    assert 'Artifact path escapes destination' in extract({'artifact.zip': 'existing-link'})
    assert outside.read_text() == 'untouched'
    external = root / 'external'
    external.mkdir()
    destination_link = workspace / 'destination-link'
    destination_link.symlink_to(external, target_is_directory=True)
    assert 'Artifact destination escapes' in extract({'artifact.zip': 'escaped.txt'}, destination=destination_link)
    assert not raw.exists()
    assert 'Artifact destination escapes' in extract({'artifact.zip': 'escaped.txt'}, destination=destination_link / 'nested')
    assert not raw.exists()
    assert list(external.iterdir()) == []
    internal_link = workspace / 'internal-link'
    internal_link.symlink_to(output, target_is_directory=True)
    assert 'Artifact destination escapes' in extract({'artifact.zip': 'redirected.txt'}, destination=internal_link)
    assert 'Artifact destination escapes' in extract({'artifact.zip': 'redirected.txt'}, destination=internal_link / 'nested')
    assert not (output / 'redirected.txt').exists()
    assert not (output / 'nested/redirected.txt').exists()
    assert not raw.exists()
    temporary_link = workspace / 'temporary-link'
    temporary_link.symlink_to(runner_temp, target_is_directory=True)
    assert 'Artifact destination escapes' in extract({'artifact.zip': 'escaped.txt'}, destination=temporary_link)
    assert not (runner_temp / 'escaped.txt').exists()
    # Runner roots may themselves use a platform-provided alias, as on macOS.
    alias = root / 'workspace-alias'
    alias.symlink_to(workspace, target_is_directory=True)
    assert extract({'artifact.zip': 'alias.txt'}, destination=alias / 'output', workspace_root=alias) == ''
    assert (output / 'alias.txt').read_text() == 'fixture'
    assert extract({'artifact.zip': 'canonical.txt'}, destination=output.resolve(), workspace_root=alias) == ''
    assert (output / 'canonical.txt').read_text() == 'fixture'
assert not (root / 'escape.txt').exists()
assert 'Artifact destination escapes' in extract({'artifact.zip': 'parent-escape.txt'}, destination=workspace / '..' / 'outside')
assert not (root / 'outside').exists()
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
