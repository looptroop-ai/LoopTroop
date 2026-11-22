/**
 * Decides whether CI on a push to main has anything left to prove.
 *
 * main takes a pull request only when it is up to date and its required check
 * passed, so a merge normally holds exactly the code that pull request's last
 * run already tested. Running every job again then proves nothing new, and
 * holds the machines the next pull request is waiting for.
 *
 * The answer is "tested" only when all of this holds; anything else, a failed
 * API call included, means CI runs in full:
 * - the push is the merge of a pull request from this repository;
 * - the merged code is the pull request's last commit, git tree for git tree;
 * - nothing under .github changed in the push: the steps that run only on
 *   main are never exercised by a pull request's run;
 * - the newest pull request run of this workflow on that commit finished, and
 *   every job in it passed;
 * - that run's coverage report has not expired, because main's run hands it to
 *   Codecov as the baseline later pull requests are compared with.
 *
 * Usage, in the workflow: node scripts/merge-check.ts
 * Reads GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_WORKFLOW_REF, BEFORE (the commit
 * main held before the push) and GITHUB_TOKEN, which goes to api.github.com
 * and nowhere else; writes `tested` and `run_id` to GITHUB_OUTPUT and one line
 * to the job summary.
 */
import { appendFileSync, realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The artifact the coverage lane uploads and the Codecov job downloads. */
export const COVERAGE_ARTIFACT = 'coverage-report'

export type GetJson = (path: string) => Promise<unknown>

export interface Push {
  /** owner/name */
  repository: string
  /** The pushed commit, now main. */
  sha: string
  /** The commit main held before the push; all zeros for a new branch. */
  before: string
  /** This workflow's file name, such as ci.yml. */
  workflow: string
}

export type Decision =
  | { tested: true; runId: number; pullRequest: number; reason: string }
  | { tested: false; reason: string }

const untested = (reason: string): Decision => ({ tested: false, reason })

export async function decide(push: Push, get: GetJson): Promise<Decision> {
  // Every value that goes into a request path is checked, then encoded.
  const parts = /^([\w.-]+)\/([\w.-]+)$/.exec(push.repository)
  if (!parts) throw new Error(`unexpected repository ${push.repository}`)
  if (!/^[\w.-]+\.ya?ml$/.test(push.workflow)) throw new Error(`unexpected workflow file ${push.workflow}`)
  const sha = objectId(push.sha, 'pushed commit')
  const previous = objectId(push.before, 'previous commit')
  const repo = `/repos/${encodeURIComponent(parts[1]!)}/${encodeURIComponent(parts[2]!)}`

  const pull = list(await get(`${repo}/commits/${encodeURIComponent(sha)}/pulls`), 'pull requests')
    .map(readPull)
    .find((candidate) => candidate.merged && candidate.mergeCommit === sha)
  if (!pull) return untested('it is not the merge of a pull request')
  const name = `pull request #${pull.number}`
  if (pull.headRepository !== push.repository) return untested(`${name} came from another repository`)
  if (/^0+$/.test(previous)) return untested('the push has no earlier commit to compare with')

  const [merged, head, before] = await Promise.all([
    treeOf(get, repo, sha), treeOf(get, repo, pull.headSha), treeOf(get, repo, previous)])
  if (merged !== head) return untested(`its code differs from ${name}'s last commit`)
  const [ciNow, ciBefore] = await Promise.all([githubDirectoryOf(get, repo, merged), githubDirectoryOf(get, repo, before)])
  if (ciNow !== ciBefore) return untested('it changes .github, and a pull request run never exercises the steps only main runs')

  const runs = list(record(await get(
    `${repo}/actions/workflows/${encodeURIComponent(push.workflow)}/runs?event=pull_request&head_sha=${encodeURIComponent(pull.headSha)}&per_page=100`,
  ), 'workflow runs').workflow_runs, 'workflow runs')
    .map(readRun)
    .filter((run) => run.headRepository === push.repository)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  const run = runs[0]
  if (!run) return untested(`${name}'s last commit has no run of this workflow`)
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    return untested(`run ${run.id} on ${name}'s last commit ended ${run.conclusion ?? run.status}`)
  }

  const artifacts = list(record(await get(
    `${repo}/actions/runs/${encodeURIComponent(run.id)}/artifacts?name=${COVERAGE_ARTIFACT}`,
  ), 'artifacts').artifacts, 'artifacts')
  const coverage = artifacts.some((artifact) => {
    const fields = record(artifact, 'artifact')
    return fields.name === COVERAGE_ARTIFACT && fields.expired === false
  })
  if (!coverage) return untested(`run ${run.id}'s coverage report has expired`)
  return { tested: true, runId: run.id, pullRequest: pull.number, reason: `${name}'s run ${run.id} passed on identical code` }
}

/** The root tree of a commit. */
async function treeOf(get: GetJson, repo: string, commit: string): Promise<string> {
  return objectId(record(record(await get(`${repo}/git/commits/${encodeURIComponent(commit)}`), 'commit').tree, 'commit tree').sha, `tree of ${commit}`)
}

/** The tree .github points at inside a root tree. */
async function githubDirectoryOf(get: GetJson, repo: string, tree: string): Promise<string> {
  const entries = list(record(await get(`${repo}/git/trees/${encodeURIComponent(tree)}`), 'tree').tree, 'tree entries')
  const entry = entries.map((candidate) => record(candidate, 'tree entry')).find((candidate) => candidate.path === '.github')
  if (!entry) throw new Error(`tree ${tree} has no .github`)
  return objectId(entry.sha, `.github in ${tree}`)
}

function readPull(value: unknown) {
  const pull = record(value, 'pull request')
  const head = record(pull.head, 'pull request head')
  const headRepository = head.repo === null ? null : record(head.repo, 'head repository').full_name
  return {
    number: integer(pull.number, 'pull request number'),
    merged: typeof pull.merged_at === 'string',
    mergeCommit: pull.merge_commit_sha,
    headSha: objectId(head.sha, 'pull request head'),
    headRepository,
  }
}

function readRun(value: unknown) {
  const run = record(value, 'workflow run')
  return {
    id: integer(run.id, 'run id'),
    status: String(run.status),
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    createdAt: String(run.created_at),
    headRepository: run.head_repository === null ? null : record(run.head_repository, 'run repository').full_name,
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`unexpected ${what} from the API`)
  return value as Record<string, unknown>
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`unexpected ${what} from the API`)
  return value
}

function integer(value: unknown, what: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`unexpected ${what} from the API`)
  return value as number
}

/** Two trees are the same code only if both ids are real: two missing ones would compare equal. */
function objectId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/.test(value)) throw new Error(`unexpected ${what}: ${String(value)}`)
  return value
}

const GITHUB_API = 'https://api.github.com'

/**
 * A GET against the GitHub REST API that throws on anything but success. The
 * host is fixed, so the token cannot be sent anywhere else.
 */
export function githubGet(env: NodeJS.ProcessEnv, fetchImpl: typeof fetch = fetch): GetJson {
  const token = env.GITHUB_TOKEN
  return async (path) => {
    if (!path.startsWith('/')) throw new Error(`not an API path: ${path}`)
    const response = await fetchImpl(GITHUB_API + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GET ${path} answered HTTP ${response.status}`)
    return response.json() as Promise<unknown>
  }
}

/** ci.yml from owner/name/.github/workflows/ci.yml@refs/heads/main. */
export function workflowFile(workflowRef: string | undefined): string {
  const match = /\/\.github\/workflows\/([^/@]+)@/.exec(workflowRef ?? '')
  if (!match) throw new Error(`cannot tell the workflow file from GITHUB_WORKFLOW_REF=${workflowRef ?? ''}`)
  return match[1]!
}

export async function main(
  env: NodeJS.ProcessEnv = process.env,
  get: GetJson = githubGet(env),
  out: (line: string) => void = console.log,
): Promise<number> {
  let decision: Decision
  try {
    const push = {
      repository: env.GITHUB_REPOSITORY ?? '',
      sha: env.GITHUB_SHA ?? '',
      before: env.BEFORE ?? '',
      workflow: workflowFile(env.GITHUB_WORKFLOW_REF),
    }
    if (!push.repository || !push.sha) throw new Error('GITHUB_REPOSITORY and GITHUB_SHA are required')
    decision = await decide(push, get)
  } catch (error) {
    decision = untested(`the check could not finish: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is not set')
  appendFileSync(env.GITHUB_OUTPUT, `tested=${decision.tested}\nrun_id=${decision.tested ? decision.runId : ''}\n`)
  const runUrl = decision.tested
    ? `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${env.GITHUB_REPOSITORY}/actions/runs/${decision.runId}`
    : ''
  const line = decision.tested
    ? `Already tested: ${decision.reason} (${runUrl}), so this run only hands its coverage report to Codecov.`
    : `Runs in full: ${decision.reason}.`
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`)
  out(line)
  return 0
}

/** Through realpath, as in test-shards.ts, so a symlinked checkout still runs the CLI. */
function isMainModule(): boolean {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked)
  } catch {
    return import.meta.url === pathToFileURL(invoked).href
  }
}

if (isMainModule()) process.exitCode = await main()
