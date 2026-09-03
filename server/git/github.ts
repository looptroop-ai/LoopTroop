import { getCurrentBranch } from './repository'
import { EXCLUDE_LOOPTROOP_DIR, REPO_SCOPE_PATHSPECS } from './pathspecs'
import {
  runCommand,
  runCommandSync,
  runGitSync,
  runGitSyncOrThrow,
  type RunCommandOptions,
  type RunCommandResult,
} from './runCommand'

const GIT_PATCH_MAX_BUFFER_BYTES = 2 * 1024 * 1024
const GITHUB_PERMISSION_CHECK_TIMEOUT_MS = 5_000

/**
 * Ceiling for a `gh` call, which had none at all before.
 *
 * Longer than the 30s local-git default because these are round trips to the
 * GitHub API — a merge on a busy repository is measured in seconds, not
 * milliseconds — and short enough that a hung request cannot hold a phase open.
 */
const GITHUB_COMMAND_TIMEOUT_MS = 60_000

type CommandAttempt =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: string }

function toAttempt(result: RunCommandResult): CommandAttempt {
  return result.ok
    ? { ok: true, stdout: result.stdout, stderr: result.stderr }
    : { ok: false, error: result.errorDetail ?? `exit code ${result.status ?? '?'}` }
}

/**
 * `gh` talks to github.com on every call, so all of them are asynchronous;
 * the plain git reads in this module are local and stay synchronous.
 */
async function runGh(args: string[], options?: RunCommandOptions): Promise<string> {
  const result = await runCommand('gh', args, { timeoutMs: GITHUB_COMMAND_TIMEOUT_MS, ...options })
  if (!result.ok) throw new Error(result.errorDetail)
  return result.stdout
}

async function tryGh(args: string[], options?: RunCommandOptions): Promise<CommandAttempt> {
  return toAttempt(await runCommand('gh', args, { timeoutMs: GITHUB_COMMAND_TIMEOUT_MS, ...options }))
}

function trySyncCommand(bin: string, args: string[], options?: RunCommandOptions): CommandAttempt {
  return toAttempt(runCommandSync(bin, args, options))
}

function runGit(projectPath: string, args: string[]): string {
  return runGitSyncOrThrow(projectPath, args)
}

function tryGit(projectPath: string, args: string[], options?: RunCommandOptions): CommandAttempt {
  return toAttempt(runGitSync(projectPath, args, options))
}

/** Reaches the remote, so it is asynchronous unlike the other git helpers here. */
async function tryRemoteGit(projectPath: string, args: string[], options?: RunCommandOptions): Promise<CommandAttempt> {
  return toAttempt(await runCommand('git', ['-C', projectPath, ...args], options))
}

async function runRemoteGit(projectPath: string, args: string[], options?: RunCommandOptions): Promise<string> {
  const result = await runCommand('git', ['-C', projectPath, ...args], options)
  if (!result.ok) throw new Error(result.errorDetail)
  return result.stdout
}

export interface GitHubRepoRef {
  owner: string
  repo: string
  slug: string
  remoteUrl: string
}

export interface GitHubRepoWriteAccess {
  status: 'writable' | 'read_only' | 'unknown'
  permission: string | null
  error?: string
}

export type PullRequestState = 'draft' | 'open' | 'merged' | 'closed'

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  body: string | null
  state: PullRequestState
  baseRefName: string
  headRefName: string
  headRefOid: string | null
  createdAt: string | null
  updatedAt: string | null
  closedAt: string | null
  mergedAt: string | null
}

export interface GitDiffSummary {
  stat: string
  nameStatus: string
  patch: string
  patchTruncated: boolean
  patchError: string | null
}

export interface RemoteBaseVerification {
  baseBranch: string
  verifiedCommitSha: string
  remoteBaseHead: string
}

export interface GitRecoveryReceipt {
  phase: string
  step: string
  capturedAt: string
  error: string
  projectPath: string
  branch: string
  baseBranch: string
  headSha: string | null
  candidateSha: string | null
  stagedFiles: string[]
  unstagedFiles: string[]
  untrackedFiles: string[]
  prNumber: number | null
  prUrl: string | null
  prState: PullRequestState | null
  nextSafeActions: string[]
}

interface GitHubPullRecord {
  number?: unknown
  html_url?: unknown
  title?: unknown
  body?: unknown
  state?: unknown
  draft?: unknown
  created_at?: unknown
  updated_at?: unknown
  closed_at?: unknown
  merged_at?: unknown
  head?: {
    ref?: unknown
    sha?: unknown
  } | null
  base?: {
    ref?: unknown
  } | null
}

interface GhAuthStatusEntry {
  active?: unknown
  state?: unknown
  login?: unknown
  error?: unknown
}

interface GhAuthStatusPayload {
  hosts?: Record<string, unknown>
}

// Deliberately excludes only `.looptroop`: this is the "is the worktree clean"
// probe, and a change under `.ticket` is a change the delivery flow must see.
const FILTERED_STATUS_ARGS = ['status', '--porcelain=1', '--untracked-files=all', '--', '.', EXCLUDE_LOOPTROOP_DIR]
const SSH_HOSTNAME_CACHE = new Map<string, string | null>()

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildGitHubRepoRef(owner: string, repo: string, remoteUrl: string): GitHubRepoRef | null {
  const normalizedOwner = owner.trim()
  const normalizedRepo = repo.trim().replace(/\.git$/i, '')
  if (!normalizedOwner || !normalizedRepo) return null
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    slug: `${normalizedOwner}/${normalizedRepo}`,
    remoteUrl,
  }
}

function resolveSshHostname(host: string): string | null {
  const normalizedHost = host.trim().toLowerCase()
  if (!normalizedHost) return null
  if (normalizedHost === 'github.com') return 'github.com'
  if (SSH_HOSTNAME_CACHE.has(normalizedHost)) {
    return SSH_HOSTNAME_CACHE.get(normalizedHost) ?? null
  }

  const result = trySyncCommand('ssh', ['-G', host])
  if (!result.ok) {
    SSH_HOSTNAME_CACHE.set(normalizedHost, null)
    return null
  }

  const hostname = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().startsWith('hostname '))

  const resolved = hostname ? hostname.slice('hostname '.length).trim().toLowerCase() : null
  SSH_HOSTNAME_CACHE.set(normalizedHost, resolved || null)
  return resolved || null
}

function isGitHubHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase()
  if (!normalizedHost) return false
  if (normalizedHost === 'github.com') return true
  return resolveSshHostname(host) === 'github.com'
}

function parseScpLikeGitHubRemoteUrl(remoteUrl: string): GitHubRepoRef | null {
  const match = remoteUrl.match(/^(?<user>[^@]+)@(?<host>[^:/]+):(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/)
  const host = match?.groups?.host?.trim()
  const owner = match?.groups?.owner?.trim()
  const repo = match?.groups?.repo?.trim()
  if (!host || !owner || !repo || !isGitHubHost(host)) return null
  return buildGitHubRepoRef(owner, repo, remoteUrl)
}

function parseUrlLikeGitHubRemoteUrl(remoteUrl: string): GitHubRepoRef | null {
  let parsed: URL
  try {
    parsed = new URL(remoteUrl)
  } catch {
    return null
  }

  if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol)) return null
  if (!isGitHubHost(parsed.hostname)) return null

  const pathSegments = parsed.pathname
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)

  if (pathSegments.length < 2) return null
  return buildGitHubRepoRef(pathSegments[0]!, pathSegments[1]!, remoteUrl)
}

function readGhHostEntries(payload: GhAuthStatusPayload, host: string): GhAuthStatusEntry[] {
  const entries = payload.hosts?.[host]
  return Array.isArray(entries) ? entries as GhAuthStatusEntry[] : []
}

function formatGhAuthEntry(entry: GhAuthStatusEntry): string {
  const login = normalizeString(entry.login) ?? 'unknown account'
  const state = normalizeString(entry.state) ?? 'unknown'
  const error = normalizeString(entry.error)
  return error ? `${login} (${state}): ${error}` : `${login} (${state})`
}

function normalizePullRequestState(record: GitHubPullRecord): PullRequestState | null {
  const mergedAt = normalizeString(record.merged_at)
  if (mergedAt) return 'merged'
  const state = normalizeString(record.state)?.toUpperCase()
  if (state === 'CLOSED') return 'closed'
  if (state === 'OPEN' && record.draft === true) return 'draft'
  if (state === 'OPEN') return 'open'
  return null
}

function toPullRequestInfo(record: GitHubPullRecord): PullRequestInfo | null {
  const number = typeof record.number === 'number' && Number.isFinite(record.number) ? record.number : null
  const url = normalizeString(record.html_url)
  const title = normalizeString(record.title)
  const state = normalizePullRequestState(record)
  const baseRefName = normalizeString(record.base?.ref)
  const headRefName = normalizeString(record.head?.ref)

  if (!number || !url || !title || !state || !baseRefName || !headRefName) return null

  return {
    number,
    url,
    title,
    body: normalizeString(record.body),
    state,
    baseRefName,
    headRefName,
    headRefOid: normalizeString(record.head?.sha),
    createdAt: normalizeString(record.created_at),
    updatedAt: normalizeString(record.updated_at),
    closedAt: normalizeString(record.closed_at),
    mergedAt: normalizeString(record.merged_at),
  }
}

export function readOriginRemoteUrl(projectPath: string): string | null {
  try {
    const value = runGit(projectPath, ['config', '--get', 'remote.origin.url'])
    return value.trim() || null
  } catch {
    return null
  }
}

export function parseGitHubRemoteUrl(remoteUrl: string | null | undefined): GitHubRepoRef | null {
  const trimmed = typeof remoteUrl === 'string' ? remoteUrl.trim() : ''
  if (!trimmed) return null
  return parseScpLikeGitHubRemoteUrl(trimmed) ?? parseUrlLikeGitHubRemoteUrl(trimmed)
}

export function assertGitHubOrigin(projectPath: string): GitHubRepoRef {
  const remoteUrl = readOriginRemoteUrl(projectPath)
  const repo = parseGitHubRemoteUrl(remoteUrl)
  if (!repo) {
    throw new Error('Project must have an origin remote that resolves to github.com.')
  }
  return repo
}

/** `gh --version` answers from disk, so this one probe stays synchronous. */
export function isGhInstalled(): boolean {
  return trySyncCommand('gh', ['--version'], { timeoutMs: GITHUB_PERMISSION_CHECK_TIMEOUT_MS }).ok
}

export async function getGhAuthStatus(): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await tryGh(['auth', 'status', '--hostname', 'github.com', '--json', 'hosts'])
  if (!result.ok) {
    if (isUnsupportedGhAuthStatusJsonFlag(result.error)) {
      const fallback = await tryGh(['auth', 'status', '--hostname', 'github.com'])
      return fallback.ok ? { ok: true } : { ok: false, error: fallback.error }
    }
    return { ok: false, error: result.error }
  }

  try {
    const payload = JSON.parse(result.stdout) as GhAuthStatusPayload
    const githubEntries = readGhHostEntries(payload, 'github.com')
    const activeSuccessfulEntry = githubEntries.find((entry) => {
      const state = normalizeString(entry.state)?.toLowerCase()
      return entry.active === true && state === 'success'
    })

    if (activeSuccessfulEntry) {
      return { ok: true }
    }

    const activeEntry = githubEntries.find((entry) => entry.active === true)
    if (activeEntry) {
      return { ok: false, error: formatGhAuthEntry(activeEntry) }
    }

    if (githubEntries.length > 0) {
      return { ok: false, error: githubEntries.map(formatGhAuthEntry).join('; ') }
    }

    return { ok: false, error: 'No github.com auth entries found.' }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? `Failed to parse gh auth status JSON: ${error.message}` : 'Failed to parse gh auth status JSON.',
    }
  }
}

function isUnsupportedGhAuthStatusJsonFlag(error: string): boolean {
  return /unknown flag:\s*--json/i.test(error)
}

export async function getGitHubRepoAccess(projectPath: string): Promise<{ ok: true; repo: GitHubRepoRef } | { ok: false; error: string }> {
  const repo = assertGitHubOrigin(projectPath)
  const result = await tryGh(['repo', 'view', repo.slug, '--json', 'nameWithOwner'], { cwd: projectPath })
  return result.ok
    ? { ok: true, repo }
    : { ok: false, error: result.error }
}

export async function getGitHubRepoWriteAccess(projectPath: string): Promise<GitHubRepoWriteAccess> {
  let repo: GitHubRepoRef
  try {
    repo = assertGitHubOrigin(projectPath)
  } catch (error) {
    return {
      status: 'unknown',
      permission: null,
      error: error instanceof Error ? error.message : 'Failed to resolve the GitHub origin.',
    }
  }

  const result = await tryGh(['repo', 'view', repo.slug, '--json', 'viewerPermission'], {
    cwd: projectPath,
    timeoutMs: GITHUB_PERMISSION_CHECK_TIMEOUT_MS,
  })
  if (!result.ok) {
    return { status: 'unknown', permission: null, error: result.error }
  }

  try {
    const payload = JSON.parse(result.stdout) as { viewerPermission?: unknown }
    const permission = normalizeString(payload.viewerPermission)?.toUpperCase() ?? null
    if (permission === 'WRITE' || permission === 'MAINTAIN' || permission === 'ADMIN') {
      return { status: 'writable', permission }
    }
    if (permission === 'READ' || permission === 'TRIAGE') {
      return { status: 'read_only', permission }
    }
    return {
      status: 'unknown',
      permission,
      error: permission
        ? `GitHub CLI returned an unsupported viewer permission: ${permission}`
        : 'GitHub CLI did not return a viewer permission.',
    }
  } catch (error) {
    return {
      status: 'unknown',
      permission: null,
      error: error instanceof Error ? `Failed to parse GitHub repository permission: ${error.message}` : 'Failed to parse GitHub repository permission.',
    }
  }
}

async function runGhJson<T>(
  projectPath: string,
  args: string[],
  options?: { input?: string; env?: NodeJS.ProcessEnv },
): Promise<T> {
  const stdout = await runGh(args, {
    cwd: projectPath,
    input: options?.input,
    env: options?.env,
  })

  if (!stdout) {
    throw new Error('GitHub CLI returned empty JSON output')
  }

  return JSON.parse(stdout) as T
}

async function listPullRequests(projectPath: string, repo: GitHubRepoRef, branchName: string, baseBranch: string): Promise<PullRequestInfo[]> {
  const pulls = await runGhJson<GitHubPullRecord[]>(projectPath, [
    'api',
    `repos/${repo.slug}/pulls`,
    '--method',
    'GET',
    '-f',
    'state=all',
    '-f',
    `head=${repo.owner}:${branchName}`,
    '-f',
    `base=${baseBranch}`,
  ])

  if (!Array.isArray(pulls)) return []
  return pulls
    .map((record) => toPullRequestInfo(record))
    .filter((record): record is PullRequestInfo => record !== null)
    .sort((left, right) => right.number - left.number)
}

export async function getPullRequestForBranch(projectPath: string, branchName: string, baseBranch: string): Promise<PullRequestInfo | null> {
  const repo = assertGitHubOrigin(projectPath)
  return (await listPullRequests(projectPath, repo, branchName, baseBranch))[0] ?? null
}

export async function createOrUpdateDraftPullRequest(params: {
  projectPath: string
  branchName: string
  baseBranch: string
  title: string
  body: string
}): Promise<PullRequestInfo> {
  const repo = assertGitHubOrigin(params.projectPath)
  const existing = (await listPullRequests(params.projectPath, repo, params.branchName, params.baseBranch))[0] ?? null

  if (existing) {
    const updated = await runGhJson<GitHubPullRecord>(params.projectPath, [
      'api',
      `repos/${repo.slug}/pulls/${existing.number}`,
      '--method',
      'PATCH',
      '-f',
      `title=${params.title}`,
      '-f',
      `body=${params.body}`,
    ])
    return toPullRequestInfo(updated) ?? existing
  }

  const created = await runGhJson<GitHubPullRecord>(params.projectPath, [
    'api',
    `repos/${repo.slug}/pulls`,
    '--method',
    'POST',
    '-f',
    `title=${params.title}`,
    '-f',
    `head=${params.branchName}`,
    '-f',
    `base=${params.baseBranch}`,
    '-f',
    `body=${params.body}`,
    '-F',
    'draft=true',
  ])

  const info = toPullRequestInfo(created)
  if (!info) {
    throw new Error('GitHub CLI did not return pull request metadata after creation')
  }
  return info
}

export async function markPullRequestReady(projectPath: string, prNumber: number): Promise<PullRequestInfo> {
  await runGh(['pr', 'ready', String(prNumber)], { cwd: projectPath })
  const repo = assertGitHubOrigin(projectPath)
  const refreshed = await runGhJson<GitHubPullRecord>(projectPath, [
    'api',
    `repos/${repo.slug}/pulls/${prNumber}`,
    '--method',
    'GET',
  ])
  const info = toPullRequestInfo(refreshed)
  if (!info) {
    throw new Error(`Failed to refresh pull request #${prNumber} after marking it ready`)
  }
  return info
}

export async function mergePullRequest(projectPath: string, prNumber: number, title: string): Promise<PullRequestInfo> {
  const repo = assertGitHubOrigin(projectPath)
  await runGhJson<{ merged?: unknown; message?: unknown }>(projectPath, [
    'api',
    `repos/${repo.slug}/pulls/${prNumber}/merge`,
    '--method',
    'PUT',
    '-f',
    'merge_method=merge',
    '-f',
    `commit_title=${title}`,
  ])

  const refreshed = await runGhJson<GitHubPullRecord>(projectPath, [
    'api',
    `repos/${repo.slug}/pulls/${prNumber}`,
    '--method',
    'GET',
  ])
  const info = toPullRequestInfo(refreshed)
  if (!info) {
    throw new Error(`Failed to refresh merged pull request #${prNumber}`)
  }
  return info
}

export function readGitDiff(projectPath: string, fromRef: string, toRef: string): GitDiffSummary {
  const stat = runGit(projectPath, ['diff', '--stat', `${fromRef}..${toRef}`, '--', ...REPO_SCOPE_PATHSPECS])
  const nameStatus = runGit(projectPath, ['diff', '--name-status', `${fromRef}..${toRef}`, '--', ...REPO_SCOPE_PATHSPECS])
  const patchResult = tryGit(
    projectPath,
    ['diff', '--no-ext-diff', '--unified=0', `${fromRef}..${toRef}`, '--', ...REPO_SCOPE_PATHSPECS],
    { maxBuffer: GIT_PATCH_MAX_BUFFER_BYTES },
  )

  if (!patchResult.ok) {
    return {
      stat,
      nameStatus,
      patch: [
        '[LoopTroop omitted the full patch because it exceeded the safe capture limit or git diff failed.]',
        `Diff capture error: ${patchResult.error}`,
        'Use final_diff_stat and final_diff_name_status as the source of truth for changed files.',
      ].join('\n'),
      patchTruncated: true,
      patchError: patchResult.error,
    }
  }

  return {
    stat,
    nameStatus,
    patch: patchResult.stdout,
    patchTruncated: false,
    patchError: null,
  }
}

function parseStatusLines(statusOutput: string): {
  stagedFiles: string[]
  unstagedFiles: string[]
  untrackedFiles: string[]
} {
  const stagedFiles = new Set<string>()
  const unstagedFiles = new Set<string>()
  const untrackedFiles = new Set<string>()

  for (const rawLine of statusOutput.split('\n')) {
    const line = rawLine.trimEnd()
    if (line.length < 3) continue
    const x = line[0] ?? ' '
    const y = line[1] ?? ' '
    const pathText = line.slice(3).trim()
    const filePath = pathText.includes(' -> ') ? pathText.split(' -> ').at(-1)?.trim() ?? pathText : pathText
    if (!filePath) continue

    if (x === '?' && y === '?') {
      untrackedFiles.add(filePath)
      continue
    }
    if (x !== ' ') stagedFiles.add(filePath)
    if (y !== ' ') unstagedFiles.add(filePath)
  }

  return {
    stagedFiles: [...stagedFiles],
    unstagedFiles: [...unstagedFiles],
    untrackedFiles: [...untrackedFiles],
  }
}

function formatFileList(label: string, files: string[]): string | null {
  if (files.length === 0) return null
  return `${label}: ${files.join(', ')}`
}

function formatWorktreeStatusDiagnostic(projectPath: string, parsed: ReturnType<typeof parseStatusLines>): string {
  const details = [
    `Checked path: ${projectPath}`,
    formatFileList('Tracked staged files', parsed.stagedFiles),
    formatFileList('Tracked unstaged files', parsed.unstagedFiles),
    formatFileList('Untracked files', parsed.untrackedFiles),
    'Commit, stash, or restore tracked changes before retrying. Move, ignore, or remove untracked files only if Git reports they would be overwritten.',
  ].filter((line): line is string => Boolean(line))

  return details.join(' ')
}

function readWorktreeStatus(projectPath: string): ReturnType<typeof parseStatusLines> & { raw: string } {
  const raw = runGit(projectPath, FILTERED_STATUS_ARGS)
  return {
    ...parseStatusLines(raw),
    raw,
  }
}

function hasTrackedChanges(parsed: ReturnType<typeof parseStatusLines>): boolean {
  return parsed.stagedFiles.length > 0 || parsed.unstagedFiles.length > 0
}

function buildNextSafeActions(step: string): string[] {
  switch (step) {
    case 'push_candidate_branch':
      return [
        'Confirm git remote connectivity and branch permissions, then retry the ticket.',
        'Inspect the local candidate commit and remote ticket branch before retrying.',
      ]
    case 'create_or_update_pull_request':
      return [
        'Run gh auth status and re-authenticate if needed, then retry the ticket.',
        'Open the repository in GitHub and confirm pull request permissions.',
      ]
    case 'mark_pull_request_ready':
      return [
        'Inspect the draft pull request state in GitHub, then retry the merge action.',
      ]
    case 'merge_pull_request':
      return [
        'Inspect the pull request mergeability in GitHub, resolve blockers, then retry the merge action.',
      ]
    case 'verify_pull_request_candidate':
      return [
        'Confirm the pull request targets the expected base branch and still points at the recorded candidate commit, then retry.',
      ]
    case 'verify_remote_merge':
      return [
        'Fetch origin and confirm the remote base branch contains the merged pull request commit, then retry.',
      ]
    case 'sync_local_base_branch':
      return [
        'Resolve tracked local changes or any Git-reported untracked overwrite conflict, then retry the explicit local base-branch sync.',
      ]
    default:
      return [
        'Inspect the recorded git recovery receipt, resolve the blocking git or GitHub issue, then retry.',
      ]
  }
}

export function captureGitRecoveryReceipt(input: {
  projectPath: string
  phase: string
  step: string
  error: string
  branch: string
  baseBranch: string
  candidateSha?: string | null
  pr?: PullRequestInfo | null
}): GitRecoveryReceipt {
  let headSha: string | null = null
  let statusOutput = ''

  try {
    headSha = runGit(input.projectPath, ['rev-parse', 'HEAD']) || null
  } catch {
    headSha = null
  }

  try {
    statusOutput = runGit(input.projectPath, FILTERED_STATUS_ARGS)
  } catch {
    statusOutput = ''
  }

  const parsed = parseStatusLines(statusOutput)

  return {
    phase: input.phase,
    step: input.step,
    capturedAt: new Date().toISOString(),
    error: input.error,
    projectPath: input.projectPath,
    branch: input.branch,
    baseBranch: input.baseBranch,
    headSha,
    candidateSha: input.candidateSha ?? null,
    stagedFiles: parsed.stagedFiles,
    unstagedFiles: parsed.unstagedFiles,
    untrackedFiles: parsed.untrackedFiles,
    prNumber: input.pr?.number ?? null,
    prUrl: input.pr?.url ?? null,
    prState: input.pr?.state ?? null,
    nextSafeActions: buildNextSafeActions(input.step),
  }
}

export function ensureWorktreeClean(projectPath: string): void {
  const status = readWorktreeStatus(projectPath)
  if (status.raw) {
    throw new Error(`Worktree has uncommitted changes. ${formatWorktreeStatusDiagnostic(projectPath, status)}`)
  }
}

function ensureNoTrackedWorktreeChanges(projectPath: string): void {
  const status = readWorktreeStatus(projectPath)
  if (hasTrackedChanges(status)) {
    throw new Error(`Worktree has tracked changes that would make local base-branch sync unsafe. ${formatWorktreeStatusDiagnostic(projectPath, status)}`)
  }
}

export async function syncLocalBaseBranch(projectPath: string, baseBranch: string): Promise<{
  originalBranch: string | null
  localBaseHead: string
  remoteBaseHead: string
}> {
  await runRemoteGit(projectPath, ['fetch', '--no-progress', '--prune', 'origin'])
  ensureNoTrackedWorktreeChanges(projectPath)

  const originalBranch = getCurrentBranch(projectPath)
  const remoteBaseRef = `origin/${baseBranch}`
  const remoteBaseHead = runGit(projectPath, ['rev-parse', `refs/remotes/${remoteBaseRef}`])

  if (originalBranch !== baseBranch) {
    try {
      runGit(projectPath, ['checkout', baseBranch])
    } catch {
      runGit(projectPath, ['checkout', '-B', baseBranch, remoteBaseRef])
    }
  }

  runGit(projectPath, ['merge', '--ff-only', remoteBaseRef])
  const localBaseHead = runGit(projectPath, ['rev-parse', 'HEAD'])

  return {
    originalBranch,
    localBaseHead,
    remoteBaseHead,
  }
}

export async function verifyRemoteBaseContainsCommit(projectPath: string, baseBranch: string, commitSha: string): Promise<RemoteBaseVerification> {
  const verifiedCommitSha = normalizeString(commitSha)
  if (!verifiedCommitSha) {
    throw new Error('Cannot verify remote merge without a pull request head or candidate commit SHA.')
  }

  await runRemoteGit(projectPath, ['fetch', '--no-progress', '--prune', 'origin'])

  const remoteBaseRef = `refs/remotes/origin/${baseBranch}`
  const remoteBaseHead = runGit(projectPath, ['rev-parse', remoteBaseRef])
  const ancestor = tryGit(projectPath, ['merge-base', '--is-ancestor', verifiedCommitSha, remoteBaseHead])
  if (!ancestor.ok) {
    throw new Error(`Remote origin/${baseBranch} does not contain commit ${verifiedCommitSha}. Latest remote base is ${remoteBaseHead}.`)
  }

  return {
    baseBranch,
    verifiedCommitSha,
    remoteBaseHead,
  }
}

export async function tryDeleteRemoteBranch(projectPath: string, branchName: string): Promise<{ deleted: boolean; warning: string | null }> {
  const result = await tryRemoteGit(projectPath, ['push', 'origin', '--delete', branchName])
  return result.ok
    ? { deleted: true, warning: null }
    : { deleted: false, warning: result.error }
}
