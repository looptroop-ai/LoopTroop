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

const BRANCH = 'renovate/ci-tools'
const pullsPath = `/repos/${REPO}/commits/${MERGED}/pulls`
const branchPullsPath = `/repos/${REPO}/pulls?head=${encodeURIComponent(`looptroop-ai:${BRANCH}`)}&state=all&per_page=100`
const runsPath = `/repos/${REPO}/actions/workflows/ci.yml/runs?event=pull_request&head_sha=${HEAD}&per_page=100`
const artifactsPath = (run: number) => `/repos/${REPO}/actions/runs/${run}/artifacts?name=${COVERAGE_ARTIFACT}`
const jobsPath = (run: number) => `/repos/${REPO}/actions/runs/${run}/jobs?filter=latest&per_page=100`

const pull = (fields: Record<string, unknown> = {}) => ({
  number: 7,
  merged_at: '2026-11-22T07:56:39Z',
  merge_commit_sha: MERGED,
  head: { sha: HEAD, ref: BRANCH, repo: { full_name: REPO } },
  ...fields,
})
const run = (id: number, createdAt: string, fields: Record<string, unknown> = {}) => ({
  id, created_at: createdAt, run_started_at: createdAt, status: 'completed', conclusion: 'success',
  head_branch: BRANCH, head_repository: { full_name: REPO }, ...fields,
})
const job = (name: string, conclusion: string | null, status = 'completed') => ({ name, conclusion, status })
const jobs = (...list: ReturnType<typeof job>[]) => ({ total_count: list.length, jobs: list })
const passingJobs = jobs(
  job('Packaging', 'success'), job('Merge check', 'skipped'),
  job('Windows gate profile (affected files)', 'skipped'), job('Early warning (ubuntu, next Node major)', 'success'),
)

/** The push merged pull request #7, whose last commit run 99 tested. */
function api(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    [pullsPath]: [pull()],
    [`/repos/${REPO}/git/commits/${MERGED}`]: { sha: MERGED, tree: { sha: TREE } },
    [`/repos/${REPO}/git/commits/${HEAD}`]: { sha: HEAD, tree: { sha: TREE } },
    [`/repos/${REPO}/git/commits/${BEFORE}`]: { sha: BEFORE, tree: { sha: BEFORE_TREE } },
    [`/repos/${REPO}/git/trees/${TREE}`]: { tree: [{ path: 'src', sha: '4'.repeat(40) }, { path: '.github', sha: GITHUB_DIR }] },
    [`/repos/${REPO}/git/trees/${BEFORE_TREE}`]: { tree: [{ path: '.github', sha: GITHUB_DIR }, { path: 'src', sha: '5'.repeat(40) }] },
    // Renovate reuses its branches: an older pull request from the same branch had another head.
    [branchPullsPath]: [pull(), pull({ number: 3, merge_commit_sha: 'e'.repeat(40), head: { sha: 'f'.repeat(40), ref: BRANCH, repo: { full_name: REPO } } })],
    [runsPath]: { workflow_runs: [run(99, '2026-11-22T07:42:48Z')] },
    [jobsPath(99)]: passingJobs,
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
      const decision = await decide(push, api({ [pullsPath]: [pull({ head: { sha: HEAD, ref: BRANCH, repo } })] }))
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

  it('runs in full when another pull request had this commit at the head of the same branch', async () => {
    const twin = pull({ number: 8, merged_at: null, merge_commit_sha: null, base: { ref: 'release' } })
    const decision = await decide(push, api({ [branchPullsPath]: [twin, pull()] }))
    expect(decision).toEqual({ tested: false, reason: "pull request #7's last commit was also the head of pull request #8" })
  })

  it("counts only runs from the pull request's own branch", async () => {
    // Another branch at the same commit has a newer passing run; this branch's own run failed.
    const decision = await decide(push, api({
      [runsPath]: { workflow_runs: [run(100, '2026-11-22T07:50:00Z', { head_branch: 'copy-of-branch' }), run(99, '2026-11-22T07:42:48Z', { conclusion: 'failure' })] },
    }))
    expect(decision).toEqual({ tested: false, reason: "run 99 on pull request #7's last commit ended failure" })
  })

  it('judges runs by their latest attempt, not by when they were first created', async () => {
    const decision = await decide(push, api({
      [runsPath]: { workflow_runs: [
        run(99, '2026-11-22T07:42:48Z'),
        // Created earlier, re-run later, and failed this time.
        run(98, '2026-11-22T07:30:00Z', { run_started_at: '2026-11-22T07:58:00Z', conclusion: 'failure' }),
      ] },
    }))
    expect(decision).toEqual({ tested: false, reason: "run 98 on pull request #7's last commit ended failure" })
  })

  it('runs in full when any job failed, the advisory ones too, though the run itself passed', async () => {
    const advisory = jobs(job('Packaging', 'success'), job('Early warning (ubuntu, next Node major)', 'failure'))
    await expect(decide(push, api({ [jobsPath(99)]: advisory }))).resolves.toEqual({
      tested: false, reason: 'Early warning (ubuntu, next Node major) in run 99 ended failure',
    })
    const unread = { total_count: 150, jobs: passingJobs.jobs }
    await expect(decide(push, api({ [jobsPath(99)]: unread }))).resolves.toEqual({
      tested: false, reason: 'run 99 has more jobs than one page lists',
    })
  })

  it('runs in full when the coverage report Codecov needs is gone', async () => {
    for (const artifacts of [[], [{ name: COVERAGE_ARTIFACT, expired: true }], [{ name: 'other', expired: false }]]) {
      await expect(decide(push, api({ [artifactsPath(99)]: { artifacts } }))).resolves.toEqual({
        tested: false, reason: "run 99's coverage report has expired",
      })
    }
  })

  it('checks every value it puts in a request path before asking anything', async () => {
    const asked: string[] = []
    const recording: GetJson = async (path) => { asked.push(path); return [] }
    for (const [field, value, message] of [
      ['repository', 'looptroop-ai/LoopTroop/../x', 'unexpected repository'],
      ['workflow', '../ci.yml', 'unexpected workflow file'],
      ['sha', 'main', 'unexpected pushed commit'],
      ['before', `${BEFORE}?x=1`, 'unexpected previous commit'],
    ] as const) {
      await expect(decide({ ...push, [field]: value }, recording)).rejects.toThrow(message)
    }
    expect(asked).toEqual([])
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
    // The host is fixed: an API URL from the environment cannot send the token elsewhere.
    const get = githubGet({ GITHUB_API_URL: 'https://api.example', GITHUB_TOKEN: 'secret' }, fetchStub)
    await expect(get('/present')).resolves.toEqual({ ok: true })
    await expect(get('/missing')).rejects.toThrow('GET /missing answered HTTP 404')
    expect(calls[0]).toEqual({
      url: 'https://api.github.com/present',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', Authorization: 'Bearer secret' },
    })
    await expect(get('@evil.example/x')).rejects.toThrow('not an API path: @evil.example/x')
    // A path the URL parser reads as another host.
    await expect(get('//evil.example/x')).rejects.toThrow('not an API path: //evil.example/x')
    expect(calls).toHaveLength(2)
    await githubGet({}, fetchStub)('/present')
    expect(calls[2]?.url).toBe('https://api.github.com/present')
    expect(calls[2]?.headers.Authorization).toBeUndefined()
  })
})
