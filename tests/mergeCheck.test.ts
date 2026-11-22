import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COVERAGE_ARTIFACT, decide, githubGet, main, workflowFile, type GetJson, type Push } from '../scripts/merge-check'

const REPO = 'looptroop-ai/LoopTroop'
const MERGED = 'a'.repeat(40)
const BEFORE = 'b'.repeat(40)
const HEAD = 'c'.repeat(40)
const TREE = '1'.repeat(40)
const BEFORE_TREE = '2'.repeat(40)
const GITHUB_DIR = '3'.repeat(40)
const push: Push = { repository: REPO, sha: MERGED, before: BEFORE, workflow: 'ci.yml' }

const pullsPath = `/repos/${REPO}/commits/${MERGED}/pulls`
const runsPath = `/repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100`
const artifactsPath = (run: number) => `/repos/${REPO}/actions/runs/${run}/artifacts?name=${COVERAGE_ARTIFACT}`

const pull = (fields: Record<string, unknown> = {}) => ({
  number: 7,
  merged_at: '2026-11-22T07:56:39Z',
  merge_commit_sha: MERGED,
  head: { sha: HEAD, repo: { full_name: REPO } },
  ...fields,
})
const run = (id: number, createdAt: string, fields: Record<string, unknown> = {}) => ({
  id, created_at: createdAt, status: 'completed', conclusion: 'success', head_repository: { full_name: REPO }, ...fields,
})

/** The push merged pull request #7, whose last commit run 99 tested. */
function api(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [pullsPath]: [pull()],
    [`/repos/${REPO}/git/commits/${MERGED}`]: { sha: MERGED, tree: { sha: TREE } },
    [`/repos/${REPO}/git/commits/${HEAD}`]: { sha: HEAD, tree: { sha: TREE } },
    [`/repos/${REPO}/git/commits/${BEFORE}`]: { sha: BEFORE, tree: { sha: BEFORE_TREE } },
    [`/repos/${REPO}/git/trees/${TREE}`]: { tree: [{ path: 'src', sha: '4'.repeat(40) }, { path: '.github', sha: GITHUB_DIR }] },
    [`/repos/${REPO}/git/trees/${BEFORE_TREE}`]: { tree: [{ path: '.github', sha: GITHUB_DIR }, { path: 'src', sha: '5'.repeat(40) }] },
    [runsPath]: { workflow_runs: [run(99, '2026-11-22T07:42:48Z')] },
    [artifactsPath(99)]: { artifacts: [{ name: COVERAGE_ARTIFACT, expired: false }] },
    ...overrides,
  }
  const get: GetJson = async (path) => {
    if (!Object.hasOwn(responses, path)) throw new Error(`unexpected GET ${path}`)
    const value = responses[path]
    if (value instanceof Error) throw value
    return structuredClone(value)
  }
  return get
}

describe('merge check decision', () => {
  it('answers tested for a merge whose pull request run passed on the same code', async () => {
    await expect(decide(push, api())).resolves.toEqual({
      tested: true, runId: 99, pullRequest: 7, reason: "pull request #7's run 99 passed on identical code",
    })
  })

  it('runs in full when the push is not the merge of a pull request', async () => {
    for (const pulls of [
      [],
      [pull({ merged_at: null })],
      // The commit belongs to a pull request that merged as another commit.
      [pull({ merge_commit_sha: 'd'.repeat(40) })],
    ]) {
      await expect(decide(push, api({ [pullsPath]: pulls }))).resolves.toEqual({
        tested: false, reason: 'it is not the merge of a pull request',
      })
    }
  })

  it('runs in full for a pull request from another repository', async () => {
    for (const repo of [{ full_name: 'someone/LoopTroop' }, null]) {
      const decision = await decide(push, api({ [pullsPath]: [pull({ head: { sha: HEAD, repo } })] }))
      expect(decision).toEqual({ tested: false, reason: 'pull request #7 came from another repository' })
    }
  })

  it('runs in full for a push with no earlier commit', async () => {
    await expect(decide({ ...push, before: '0'.repeat(40) }, api())).resolves.toEqual({
      tested: false, reason: 'the push has no earlier commit to compare with',
    })
  })

  it('runs in full when the merged code differs from the pull request head', async () => {
    const other = '6'.repeat(40)
    const decision = await decide(push, api({ [`/repos/${REPO}/git/commits/${HEAD}`]: { tree: { sha: other } } }))
    expect(decision).toEqual({ tested: false, reason: "its code differs from pull request #7's last commit" })
  })

  it('runs in full when the push changes .github', async () => {
    const decision = await decide(push, api({
      [`/repos/${REPO}/git/trees/${BEFORE_TREE}`]: { tree: [{ path: '.github', sha: '7'.repeat(40) }] },
    }))
    expect(decision).toEqual({
      tested: false, reason: 'it changes .github, and a pull request run never exercises the steps only main runs',
    })
  })

  it('judges only the newest run from this repository', async () => {
    const decideWith = (runs: unknown[]) => decide(push, api({ [runsPath]: { workflow_runs: runs } }))
    await expect(decideWith([])).resolves.toEqual({ tested: false, reason: "pull request #7's last commit has no run of this workflow" })
    // A newer run that failed outweighs an older one that passed, whatever order the API lists them in.
    await expect(decideWith([run(99, '2026-11-22T07:42:48Z'), run(100, '2026-11-22T07:50:00Z', { conclusion: 'failure' })]))
      .resolves.toEqual({ tested: false, reason: "run 100 on pull request #7's last commit ended failure" })
    await expect(decideWith([run(101, '2026-11-22T07:55:00Z', { status: 'in_progress', conclusion: null })]))
      .resolves.toEqual({ tested: false, reason: "run 101 on pull request #7's last commit ended in_progress" })
    // A fork's run on the same commit says nothing about this repository's run.
    await expect(decideWith([run(102, '2026-11-22T07:59:00Z', { conclusion: 'failure', head_repository: { full_name: 'someone/LoopTroop' } }), run(99, '2026-11-22T07:42:48Z')]))
      .resolves.toMatchObject({ tested: true, runId: 99 })
  })

  it('runs in full when the coverage report Codecov needs is gone', async () => {
    for (const artifacts of [[], [{ name: COVERAGE_ARTIFACT, expired: true }], [{ name: 'other', expired: false }]]) {
      await expect(decide(push, api({ [artifactsPath(99)]: { artifacts } }))).resolves.toEqual({
        tested: false, reason: "run 99's coverage report has expired",
      })
    }
  })

  it('refuses to compare trees it could not read, rather than finding two missing ones equal', async () => {
    const noTree = api({
      [`/repos/${REPO}/git/commits/${MERGED}`]: { tree: {} },
      [`/repos/${REPO}/git/commits/${HEAD}`]: { tree: {} },
    })
    await expect(decide(push, noTree)).rejects.toThrow(/unexpected tree of/)
    const noGithub = api({ [`/repos/${REPO}/git/trees/${BEFORE_TREE}`]: { tree: [{ path: 'src', sha: '5'.repeat(40) }] } })
    await expect(decide(push, noGithub)).rejects.toThrow(`tree ${BEFORE_TREE} has no .github`)
    await expect(decide(push, api({ [pullsPath]: { message: 'Not Found' } }))).rejects.toThrow('unexpected pull requests')
  })
})

describe('merge check command', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })
  function environment(fields: Record<string, string> = {}) {
    const directory = mkdtempSync(join(tmpdir(), 'looptroop-merge-check-'))
    directories.push(directory)
    const env = {
      GITHUB_REPOSITORY: REPO,
      GITHUB_SHA: MERGED,
      GITHUB_WORKFLOW_REF: `${REPO}/.github/workflows/ci.yml@refs/heads/main`,
      GITHUB_SERVER_URL: 'https://github.com',
      BEFORE,
      GITHUB_OUTPUT: join(directory, 'output'),
      GITHUB_STEP_SUMMARY: join(directory, 'summary'),
      ...fields,
    }
    return { env, read: (name: 'output' | 'summary') => readFileSync(join(directory, name), 'utf8') }
  }

  it('hands the tested run to later jobs and says so in the summary', async () => {
    const { env, read } = environment()
    const lines: string[] = []
    await expect(main(env, api(), (line) => lines.push(line))).resolves.toBe(0)
    expect(read('output')).toBe('tested=true\nrun_id=99\n')
    expect(read('summary')).toContain(`(https://github.com/${REPO}/actions/runs/99)`)
    expect(lines).toEqual([read('summary').trimEnd()])
  })

  it('runs in full, and still succeeds, when the API fails', async () => {
    const { env, read } = environment()
    const failing: GetJson = async () => { throw new Error('GET /x answered HTTP 502') }
    await expect(main(env, failing, () => {})).resolves.toBe(0)
    expect(read('output')).toBe('tested=false\nrun_id=\n')
    expect(read('summary')).toBe('Runs in full: the check could not finish: GET /x answered HTTP 502.\n')
  })

  it('runs in full when it cannot tell which push or workflow it is in', async () => {
    const cases: Array<Record<string, string>> = [{ GITHUB_SHA: '' }, { GITHUB_WORKFLOW_REF: 'garbage' }]
    for (const fields of cases) {
      const { env, read } = environment(fields)
      await expect(main(env, api(), () => {})).resolves.toBe(0)
      expect(read('output')).toBe('tested=false\nrun_id=\n')
    }
  })

  it('fails loudly when it has nowhere to write its answer', async () => {
    const { env } = environment({ GITHUB_OUTPUT: '' })
    await expect(main(env, api(), () => {})).rejects.toThrow('GITHUB_OUTPUT is not set')
  })

  it('reads the workflow file from GITHUB_WORKFLOW_REF', () => {
    expect(workflowFile(`${REPO}/.github/workflows/ci.yml@refs/heads/main`)).toBe('ci.yml')
    expect(() => workflowFile(undefined)).toThrow('cannot tell the workflow file')
  })
})

describe('GitHub API access', () => {
  it('sends the API version and token, and throws on a failed request', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = []
    const fetchStub = (async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> })
      return url.endsWith('/missing')
        ? new Response('{"message":"Not Found"}', { status: 404 })
        : Response.json({ ok: true })
    }) as typeof fetch
    const get = githubGet({ GITHUB_API_URL: 'https://api.example', GITHUB_TOKEN: 'secret' }, fetchStub)
    await expect(get('/present')).resolves.toEqual({ ok: true })
    await expect(get('/missing')).rejects.toThrow('GET /missing answered HTTP 404')
    expect(calls[0]).toEqual({
      url: 'https://api.example/present',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer secret' },
    })
    await githubGet({}, fetchStub)('/present')
    expect(calls[2]?.url).toBe('https://api.github.com/present')
    expect(calls[2]?.headers.Authorization).toBeUndefined()
  })
})
