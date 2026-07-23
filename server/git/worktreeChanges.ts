import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export const EXECUTION_SETUP_PROFILE_PATH = '.ticket/runtime/execution-setup-profile.json'

export const LEGACY_EXECUTION_SETUP_CACHE_ROOTS = [
  '.cache/project-tooling',
] as const

const GIT_OP_MAX_BUFFER_BYTES = 16 * 1024 * 1024

const LOOP_TROOP_ROOTS = [
  '.ticket',
  '.looptroop',
] as const

const GENERATED_NOISE_ROOTS = [
  'node_modules',
  'bower_components',
  '.pnpm-store',
  '.yarn/cache',
  '.yarn/unplugged',
  'dist',
  'dist-ssr',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.vite',
  'coverage',
  '.nyc_output',
  'playwright-report',
  'test-results',
  'target',
  '.gradle',
  'bin',
  'obj',
  '.venv',
  'venv',
  'env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  'htmlcov',
  '.cache',
  'CMakeFiles',
  '.dart_tool',
  '.pub-cache',
  '.build',
  'DerivedData',
  '.terraform',
  '.serverless',
  '.aws-sam',
  'tmp',
  'temp',
  '.tmp',
  'logs',
  'vendor/bundle',
  'vendor/cache',
] as const

const GENERATED_NOISE_SEGMENT_PREFIXES = [
  'cmake-build-',
] as const

const GENERATED_NOISE_FILE_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
])

export type WorktreeChangeCategory =
  | 'committable'
  | 'looptroopExcluded'
  | 'setupExcluded'
  | 'generatedNoise'

export interface WorktreeChangeEntry {
  path: string
  indexStatus: string
  worktreeStatus: string
  rawStatus: string
  untracked: boolean
  category: WorktreeChangeCategory
  generatedNoisePattern?: string
}

export interface WorktreeChangeSummary {
  entries: WorktreeChangeEntry[]
  committable: WorktreeChangeEntry[]
  looptroopExcluded: WorktreeChangeEntry[]
  setupExcluded: WorktreeChangeEntry[]
  generatedNoise: WorktreeChangeEntry[]
  hasChanges: boolean
  hasCommittableChanges: boolean
}

interface FileClassifyOptions {
  setupExcludedRoots?: string[]
  untracked?: boolean
}

interface WorktreeSummaryOptions {
  setupExcludedRoots?: string[]
  timeoutMs?: number
}

interface ExecutionSetupProfileLike {
  tempRoots?: string[]
  temp_roots?: string[]
  reusableArtifacts?: Array<{ path?: string | null } | null>
  reusable_artifacts?: Array<{ path?: string | null } | null>
  workspaceInputs?: Array<{ path?: string | null } | null>
  workspace_inputs?: Array<{ path?: string | null } | null>
}

function normalizeRepoPath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
}

function normalizeSetupRoot(worktreePath: string, input: unknown): string | null {
  if (typeof input !== 'string' || !input.trim()) return null
  const trimmed = input.trim()
  const repoRelative = isAbsolute(trimmed)
    ? relative(resolve(worktreePath), trimmed)
    : trimmed
  const normalized = normalizeRepoPath(repoRelative)
  if (
    !normalized
    || normalized === '.'
    || normalized === '..'
    || normalized === '/'
    || normalized.startsWith('../')
  ) {
    return null
  }
  return normalized
}

function isWithinRoot(path: string, root: string): boolean {
  const normalizedPath = normalizeRepoPath(path)
  const normalizedRoot = normalizeRepoPath(root)
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`)
}

function collectPathStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function getRecordValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key]
  }
  return undefined
}

function collectExecutionSetupRoots(worktreePath: string, profile: ExecutionSetupProfileLike | Record<string, unknown> | null | undefined): string[] {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return []

  const record = profile as Record<string, unknown>
  const roots: string[] = []
  for (const entry of collectPathStrings(getRecordValue(record, ['temp_roots', 'tempRoots']))) {
    const normalized = normalizeSetupRoot(worktreePath, entry)
    if (normalized) roots.push(normalized)
  }

  const artifacts = getRecordValue(record, ['reusable_artifacts', 'reusableArtifacts'])
  if (Array.isArray(artifacts)) {
    for (const artifact of artifacts) {
      if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) continue
      const normalized = normalizeSetupRoot(worktreePath, (artifact as Record<string, unknown>).path)
      if (normalized) roots.push(normalized)
    }
  }

  const workspaceInputs = getRecordValue(record, ['workspace_inputs', 'workspaceInputs'])
  if (Array.isArray(workspaceInputs)) {
    for (const input of workspaceInputs) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) continue
      const normalized = normalizeSetupRoot(worktreePath, (input as Record<string, unknown>).path)
      if (normalized) roots.push(normalized)
    }
  }

  return roots
}

export function getExecutionSetupCommitExcludedRoots(
  worktreePath: string,
  profile?: ExecutionSetupProfileLike | null,
): string[] {
  const roots = new Set<string>(LEGACY_EXECUTION_SETUP_CACHE_ROOTS)
  for (const root of collectExecutionSetupRoots(worktreePath, profile)) {
    roots.add(root)
  }

  const profilePath = resolve(worktreePath, EXECUTION_SETUP_PROFILE_PATH)
  if (!existsSync(profilePath)) return [...roots]

  try {
    const parsed = JSON.parse(readFileSync(profilePath, 'utf8')) as unknown
    for (const root of collectExecutionSetupRoots(worktreePath, parsed as ExecutionSetupProfileLike)) {
      roots.add(root)
    }
  } catch {
    return [...roots]
  }

  return [...roots]
}

function getGeneratedNoisePattern(path: string): string | null {
  const normalized = normalizeRepoPath(path)
  if (!normalized) return null

  const fileName = normalized.split('/').pop() ?? normalized
  if (GENERATED_NOISE_FILE_NAMES.has(fileName)) return fileName
  if (/\.log$/i.test(fileName)) return '*.log'
  if (fileName === '.env') return '.env'
  if (fileName.startsWith('.env.') && fileName !== '.env.example' && fileName !== '.env.sample') {
    return '.env.*'
  }

  for (const root of GENERATED_NOISE_ROOTS) {
    if (isWithinRoot(normalized, root)) return `${normalizeRepoPath(root)}/`
  }

  const segments = normalized.split('/').filter(Boolean)
  for (const segment of segments) {
    for (const prefix of GENERATED_NOISE_SEGMENT_PREFIXES) {
      if (segment.startsWith(prefix)) return `${prefix}*/`
    }
  }

  return null
}

export function classifyWorktreePath(path: string, options: FileClassifyOptions = {}): {
  category: WorktreeChangeCategory
  generatedNoisePattern?: string
} {
  const normalizedPath = normalizeRepoPath(path)

  for (const root of LOOP_TROOP_ROOTS) {
    if (isWithinRoot(normalizedPath, root)) {
      return { category: 'looptroopExcluded' }
    }
  }

  const setupExcludedRoots = [
    ...LEGACY_EXECUTION_SETUP_CACHE_ROOTS,
    ...(options.setupExcludedRoots ?? []),
  ]
  for (const root of setupExcludedRoots) {
    if (isWithinRoot(normalizedPath, root)) {
      return { category: 'setupExcluded' }
    }
  }

  if (options.untracked) {
    const generatedNoisePattern = getGeneratedNoisePattern(normalizedPath)
    if (generatedNoisePattern) {
      return { category: 'generatedNoise', generatedNoisePattern }
    }
  }

  return { category: 'committable' }
}

function parseGitStatusPorcelain(output: string, options: WorktreeSummaryOptions = {}): WorktreeChangeEntry[] {
  const fields = output.split('\0').filter(Boolean)
  const entries: WorktreeChangeEntry[] = []

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index] ?? ''
    if (field.length < 4) continue

    const indexStatus = field[0] ?? ' '
    const worktreeStatus = field[1] ?? ' '
    const rawPath = field.slice(3)
    const path = normalizeRepoPath(rawPath)
    if (!path) continue

    if ((indexStatus === 'R' || indexStatus === 'C') && index + 1 < fields.length) {
      index += 1
    }

    const untracked = indexStatus === '?' && worktreeStatus === '?'
    const classification = classifyWorktreePath(path, {
      setupExcludedRoots: options.setupExcludedRoots,
      untracked,
    })

    entries.push({
      path,
      indexStatus,
      worktreeStatus,
      rawStatus: `${indexStatus}${worktreeStatus}`,
      untracked,
      category: classification.category,
      ...(classification.generatedNoisePattern ? { generatedNoisePattern: classification.generatedNoisePattern } : {}),
    })
  }

  return entries
}

export function summarizeWorktreeChanges(
  worktreePath: string,
  options: WorktreeSummaryOptions = {},
): WorktreeChangeSummary {
  const result = spawnSync('git', [
    '-C',
    worktreePath,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ], {
    encoding: 'utf8',
    maxBuffer: GIT_OP_MAX_BUFFER_BYTES,
    ...(options.timeoutMs !== undefined && options.timeoutMs > 0 ? { timeout: options.timeoutMs } : {}),
  })

  if (result.status !== 0 || result.error) {
    const detail = result.error?.message
      ?? ((result.stderr ?? '').trim() || `exit code ${result.status ?? '?'}`)
    throw new Error(`Failed to inspect worktree changes: ${detail}`)
  }

  const entries = parseGitStatusPorcelain(result.stdout ?? '', options)
  const committable = entries.filter(entry => entry.category === 'committable')
  const looptroopExcluded = entries.filter(entry => entry.category === 'looptroopExcluded')
  const setupExcluded = entries.filter(entry => entry.category === 'setupExcluded')
  const generatedNoise = entries.filter(entry => entry.category === 'generatedNoise')

  return {
    entries,
    committable,
    looptroopExcluded,
    setupExcluded,
    generatedNoise,
    hasChanges: entries.length > 0,
    hasCommittableChanges: committable.length > 0,
  }
}

export function generatedNoiseGitignoreSuggestions(entries: WorktreeChangeEntry[]): string[] {
  return [...new Set(entries
    .map(entry => entry.generatedNoisePattern)
    .filter((entry): entry is string => Boolean(entry)))]
}

export function formatPathList(paths: string[], limit = 12): string {
  if (paths.length <= limit) return paths.join(', ')
  const shown = paths.slice(0, limit)
  return `${shown.join(', ')} and ${paths.length - shown.length} more`
}

export function buildWorktreeDirtyError(paths: string[]): string {
  return [
    `Worktree has committable project changes outside LoopTroop/setup roots: ${formatPathList(paths)}.`,
    'Clean or stash pre-existing changes, move setup-only outputs under .ticket/runtime/execution-setup/** or declared setup roots, or let a coding bead own intentional permanent repository changes.',
  ].join(' ')
}

export function buildGeneratedNoiseWarning(entries: WorktreeChangeEntry[]): string {
  const paths = entries.map(entry => entry.path)
  const suggestions = generatedNoiseGitignoreSuggestions(entries)
  const suggestionText = suggestions.length > 0
    ? ` Suggested .gitignore entries: ${suggestions.join(', ')}.`
    : ''
  return `Ignored untracked generated/local outputs: ${formatPathList(paths)}.${suggestionText}`
}
