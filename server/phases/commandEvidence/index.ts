import { constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path'

export type CommandEvidenceCode =
  | 'empty-command'
  | 'unsupported-shell-syntax'
  | 'invalid-working-directory'
  | 'unknown-command-family'
  | 'missing-project-evidence'
  | 'missing-task'
  | 'invalid-manifest'

export interface CommandEvidenceItem {
  kind: 'manifest' | 'local-file' | 'planned'
  path: string
  detail: string
}

export interface PlannedCommandEvidence {
  /** Absolute path or path relative to repositoryRoot. */
  path: string
  source: string
  /** Optional future file contents, used to prove manifest tasks such as npm scripts. */
  content?: string
  /** Explicit families justified by the approved work that creates this file. */
  commandFamilies?: string[]
  /** Explicit tasks created by that approved work. */
  tasks?: string[]
}

export interface RepositoryCommandEvidenceInput {
  repositoryRoot: string
  command: string
  /** Absolute path or path relative to repositoryRoot. Defaults to repositoryRoot. */
  workingDirectory?: string
  commandKind?: 'bead-test' | 'setup-step' | 'workspace-probe' | 'project-command'
  plannedEvidence?: PlannedCommandEvidence[]
  adapters?: readonly CommandEvidenceAdapter[]
}

export interface RepositoryCommandEvidenceResult {
  valid: boolean
  status: 'ready' | 'launcher-missing' | 'incompatible'
  command: string
  effectiveWorkingDirectory: string
  executable?: string
  family?: string
  wrapperApplied: boolean
  launcher: CommandLauncherEvidence
  evidence: CommandEvidenceItem[]
  code?: CommandEvidenceCode
  message?: string
  expectedEvidence?: string[]
}

export interface CommandLauncherEvidence {
  executable: string
  availability: 'available' | 'missing'
  resolvedPath?: string
}

export interface CommandLauncherLookupOptions {
  workingDirectory: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export interface CommandEvidenceAdapterContext {
  executable: string
  argv: readonly string[]
  workingDirectory: string
  repositoryRoot: string
  commandKind: NonNullable<RepositoryCommandEvidenceInput['commandKind']>
  evidence: CommandEvidenceFilesystem
}

export interface CommandEvidenceAdapterDecision {
  valid: boolean
  evidence?: CommandEvidenceItem[]
  code?: Extract<CommandEvidenceCode, 'missing-project-evidence' | 'missing-task' | 'invalid-manifest'>
  message?: string
  expectedEvidence?: string[]
}

export interface CommandEvidenceAdapter {
  id: string
  executables: readonly string[]
  validate(context: CommandEvidenceAdapterContext): CommandEvidenceAdapterDecision
}

export interface CommandEvidenceFilesystem {
  findUp(names: readonly string[], from: string): CommandEvidenceFile | undefined
  findInDirectory(test: (name: string) => boolean, directory: string): CommandEvidenceFile | undefined
  get(path: string): CommandEvidenceFile | undefined
}

export interface CommandEvidenceFile {
  absolutePath: string
  relativePath: string
  planned: boolean
  source?: string
  content?: string
  commandFamilies: readonly string[]
  tasks: readonly string[]
}

interface ParsedCommand {
  argv: string[]
  cwd: string
  wrapperApplied: boolean
  wrapperPath?: string
  launcherPath?: string
}

const CANONICAL_WRAPPERS = new Set([
  '.ticket/runtime/execution-setup/run',
  './.ticket/runtime/execution-setup/run',
])
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=.*$/

function failure(
  input: RepositoryCommandEvidenceInput,
  cwd: string,
  code: CommandEvidenceCode,
  message: string,
  wrapperApplied = false,
  expectedEvidence?: string[],
): RepositoryCommandEvidenceResult {
  return {
    valid: false,
    status: 'incompatible',
    command: input.command,
    effectiveWorkingDirectory: cwd,
    wrapperApplied,
    launcher: findCommandLauncher('', { workingDirectory: cwd }),
    evidence: [],
    code,
    message,
    ...(expectedEvidence ? { expectedEvidence } : {}),
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/** Side-effect-free lookup used to distinguish supported commands from missing tooling. */
export function findCommandLauncher(
  executable: string,
  options: CommandLauncherLookupOptions,
): CommandLauncherEvidence {
  const env = options.env ?? process.env
  const platform = options.platform ?? process.platform
  const hasPath = executable.includes('/') || executable.includes('\\')
  const directories = hasPath
    ? [options.workingDirectory]
    : (env.PATH ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((extension) => extension.trim()).filter(Boolean)
    : ['']

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = platform === 'win32' && extension && !executable.toLowerCase().endsWith(extension.toLowerCase())
        ? `${executable}${extension}`
        : executable
      const absolutePath = resolve(options.workingDirectory, directory, candidate)
      try {
        const stat = statSync(absolutePath)
        if (!stat.isFile()) continue
        if (platform !== 'win32' && (stat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) === 0) continue
        return { executable, availability: 'available', resolvedPath: absolutePath }
      } catch {
        // Continue looking through PATH.
      }
    }
  }
  return { executable, availability: 'missing' }
}

function shellTokens(command: string): string[] | undefined {
  const tokens: string[] = []
  let token = ''
  let quote: "'" | '"' | undefined

  const push = () => {
    if (token) tokens.push(token)
    token = ''
  }

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote) {
      if (character === quote) {
        quote = undefined
      } else if (character === '\\' && quote === '"' && index + 1 < command.length) {
        token += command[++index]
      } else {
        token += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      push()
      continue
    }
    if (character === '\\' && index + 1 < command.length) {
      token += command[++index]
      continue
    }
    if (character === '&' && command[index + 1] === '&') {
      push()
      tokens.push('&&')
      index += 1
      continue
    }
    token += character
  }
  if (quote) return undefined
  push()
  return tokens
}

function stripEnvironment(argv: string[]): string[] {
  let index = 0
  if (argv[index] === 'env') index += 1
  while (ENV_ASSIGNMENT.test(argv[index] ?? '')) index += 1
  return argv.slice(index)
}

function parseCommand(input: RepositoryCommandEvidenceInput, root: string, initialCwd: string): ParsedCommand | undefined {
  if (
    /[\n\r;|<>`]/.test(input.command)
    || /(^|[^&])&([^&]|$)/.test(input.command)
    || /\$\(/.test(input.command)
  ) {
    return undefined
  }
  const tokens = shellTokens(input.command)
  if (!tokens?.length) return undefined

  let cwd = initialCwd
  let cursor = 0
  while (tokens[cursor] === 'cd') {
    const destination = tokens[cursor + 1]
    if (!destination || tokens[cursor + 2] !== '&&') return undefined
    cwd = resolve(cwd, destination)
    if (!isInside(root, cwd)) return undefined
    cursor += 3
  }
  let argv = stripEnvironment(tokens.slice(cursor))
  if (!argv.length || argv.includes('&&')) return undefined

  let wrapperApplied = false
  let wrapperPath: string | undefined
  const wrapper = argv[0]?.replaceAll('\\', '/')
  if (wrapper && CANONICAL_WRAPPERS.has(wrapper)) {
    wrapperApplied = true
    wrapperPath = argv[0]
    argv = stripEnvironment(argv.slice(1))
  }
  let launcherPath = wrapperPath
  if (!wrapperApplied && argv[0] === 'corepack' && ['npm', 'pnpm', 'yarn'].includes(argv[1] ?? '')) {
    launcherPath = argv[0]
    argv = argv.slice(1)
  }
  if (!argv.length) return undefined
  return {
    argv,
    cwd,
    wrapperApplied,
    ...(wrapperPath ? { wrapperPath } : {}),
    ...(launcherPath ? { launcherPath } : {}),
  }
}

class EvidenceFilesystem implements CommandEvidenceFilesystem {
  readonly root: string
  readonly planned: Map<string, PlannedCommandEvidence>

  constructor(root: string, plannedEvidence: readonly PlannedCommandEvidence[]) {
    this.root = root
    this.planned = new Map(
      plannedEvidence
        .map((item) => [resolve(root, item.path), item] as const)
        .filter(([path]) => isInside(root, path)),
    )
  }

  get(path: string): CommandEvidenceFile | undefined {
    const absolutePath = resolve(path)
    if (!isInside(this.root, absolutePath)) return undefined
    const planned = this.planned.get(absolutePath)
    if (planned) return this.toFile(absolutePath, planned)
    if (!existsSync(absolutePath)) return undefined
    try {
      if (!statSync(absolutePath).isFile()) return undefined
      return this.toFile(absolutePath)
    } catch {
      return undefined
    }
  }

  findUp(names: readonly string[], from: string): CommandEvidenceFile | undefined {
    let directory = from
    while (isInside(this.root, directory)) {
      for (const name of names) {
        const found = this.get(resolve(directory, name))
        if (found) return found
      }
      if (directory === this.root) break
      const parent = resolve(directory, '..')
      if (parent === directory) break
      directory = parent
    }
    return undefined
  }

  findInDirectory(test: (name: string) => boolean, directory: string): CommandEvidenceFile | undefined {
    const planned = [...this.planned.keys()].find((path) => resolve(path, '..') === directory && test(path.split(sep).at(-1) ?? ''))
    if (planned) return this.get(planned)
    try {
      const name = readdirSync(directory).find(test)
      return name ? this.get(resolve(directory, name)) : undefined
    } catch {
      return undefined
    }
  }

  private toFile(absolutePath: string, planned?: PlannedCommandEvidence): CommandEvidenceFile {
    let content = planned?.content
    if (content === undefined && !planned) {
      try {
        content = readFileSync(absolutePath, 'utf8')
      } catch {
        // Binary/local executables do not need readable contents.
      }
    }
    return {
      absolutePath,
      relativePath: relative(this.root, absolutePath) || '.',
      planned: Boolean(planned),
      ...(planned?.source ? { source: planned.source } : {}),
      ...(content !== undefined ? { content } : {}),
      commandFamilies: planned?.commandFamilies ?? [],
      tasks: planned?.tasks ?? [],
    }
  }
}

function evidenceItem(file: CommandEvidenceFile, detail: string): CommandEvidenceItem {
  return {
    kind: file.planned ? 'planned' : 'manifest',
    path: file.relativePath,
    detail: file.planned && file.source ? `${detail}; planned by ${file.source}` : detail,
  }
}

function manifestAdapter(
  id: string,
  executables: readonly string[],
  manifests: readonly string[],
): CommandEvidenceAdapter {
  return {
    id,
    executables,
    validate(context) {
      const file = context.evidence.findUp(manifests, context.workingDirectory)
      if (file && (!file.planned || file.commandFamilies.length === 0 || file.commandFamilies.includes(id))) {
        return { valid: true, evidence: [evidenceItem(file, `supports the ${id} command family`)] }
      }
      return {
        valid: false,
        code: 'missing-project-evidence',
        message: `Command "${context.executable}" requires ${id} project evidence in the effective working directory.`,
        expectedEvidence: [...manifests],
      }
    },
  }
}

function nodeTask(argv: readonly string[]): { task?: string; setupOperation?: string } {
  const executable = argv[0]
  if (executable === 'npm') {
    if (argv[1] === 'test' || argv[1] === 't') return { task: 'test' }
    if (argv[1] === 'run' || argv[1] === 'run-script') return { task: argv.slice(2).find((value) => !value.startsWith('-')) }
    if (['install', 'ci'].includes(argv[1] ?? '')) return { setupOperation: argv[1] }
    return {}
  }
  if (executable === 'pnpm' && argv[1] === 'run') return { task: argv.slice(2).find((value) => !value.startsWith('-')) }
  if (executable === 'yarn' || executable === 'pnpm' || executable === 'bun') {
    const candidate = argv[1] === 'run' ? argv[2] : argv[1]
    if (candidate === 'install') return { setupOperation: candidate }
    return { task: candidate && !candidate.startsWith('-') ? candidate : undefined }
  }
  return {}
}

const nodeAdapter: CommandEvidenceAdapter = {
  id: 'node',
  executables: ['npm', 'pnpm', 'yarn', 'bun'],
  validate(context) {
    const manifest = context.evidence.findUp(['package.json'], context.workingDirectory)
    if (!manifest || (manifest.planned && manifest.commandFamilies.length > 0 && !manifest.commandFamilies.includes('node'))) {
      return {
        valid: false,
        code: 'missing-project-evidence',
        message: `Command "${context.executable}" is not supported because no package.json was found for the effective working directory.`,
        expectedEvidence: ['package.json containing the requested script'],
      }
    }
    const { task, setupOperation } = nodeTask(context.argv)
    if (setupOperation) {
      return context.commandKind === 'setup-step'
        ? { valid: true, evidence: [evidenceItem(manifest, `supports package-manager operation "${setupOperation}"`)] }
        : {
            valid: false,
            code: 'missing-task',
            message: `Package-manager operation "${setupOperation}" is only valid as a setup step, not as a repository verification command.`,
            expectedEvidence: ['an explicit package.json script'],
          }
    }
    if (!task) {
      return {
        valid: false,
        code: 'missing-task',
        message: `Cannot determine a repository task from "${context.argv.join(' ')}".`,
        expectedEvidence: ['an explicit package-manager run/test task'],
      }
    }
    let scripts: Record<string, unknown> = {}
    if (manifest.content) {
      try {
        const parsed = JSON.parse(manifest.content) as { scripts?: unknown }
        if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
          scripts = parsed.scripts as Record<string, unknown>
        }
      } catch {
        return {
          valid: false,
          code: 'invalid-manifest',
          message: `Cannot validate "${task}" because ${manifest.relativePath} is not valid JSON.`,
          expectedEvidence: [`a valid package.json containing scripts.${task}`],
        }
      }
    }
    const plannedTask = manifest.tasks.includes(task)
    if (typeof scripts[task] !== 'string' && !plannedTask) {
      return {
        valid: false,
        code: 'missing-task',
        message: `Task "${task}" is not declared in ${manifest.relativePath}.`,
        expectedEvidence: [`scripts.${task} in package.json`],
      }
    }
    return { valid: true, evidence: [evidenceItem(manifest, `declares Node task "${task}"`)] }
  },
}

const composerAdapter: CommandEvidenceAdapter = {
  id: 'php',
  executables: ['composer'],
  validate(context) {
    const manifest = context.evidence.findUp(['composer.json'], context.workingDirectory)
    if (!manifest) {
      return {
        valid: false,
        code: 'missing-project-evidence',
        message: 'Composer command has no composer.json in the effective working directory.',
        expectedEvidence: ['composer.json'],
      }
    }
    const operation = context.argv[1]
    if (['install', 'update', 'require', 'remove'].includes(operation ?? '')) {
      return context.commandKind === 'setup-step'
        ? { valid: true, evidence: [evidenceItem(manifest, `supports Composer operation "${operation}"`)] }
        : {
            valid: false,
            code: 'missing-task',
            message: `Composer operation "${operation}" is only valid as a setup step.`,
            expectedEvidence: ['an explicit composer.json script'],
          }
    }
    if (['validate', 'check-platform-reqs', 'audit'].includes(operation ?? '')) {
      return { valid: true, evidence: [evidenceItem(manifest, `supports Composer check "${operation}"`)] }
    }
    const task = operation === 'run-script' || operation === 'run' ? context.argv[2] : operation
    let scripts: Record<string, unknown> = {}
    if (manifest.content) {
      try {
        const parsed = JSON.parse(manifest.content) as { scripts?: unknown }
        if (parsed.scripts && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)) {
          scripts = parsed.scripts as Record<string, unknown>
        }
      } catch {
        return {
          valid: false,
          code: 'invalid-manifest',
          message: `${manifest.relativePath} is not valid JSON.`,
          expectedEvidence: ['a valid composer.json'],
        }
      }
    }
    if (!task || (!(task in scripts) && !manifest.tasks.includes(task))) {
      return {
        valid: false,
        code: 'missing-task',
        message: task
          ? `Composer task "${task}" is not declared in ${manifest.relativePath}.`
          : 'Composer command does not name a repository task.',
        expectedEvidence: [task ? `scripts.${task} in composer.json` : 'an explicit composer.json script'],
      }
    }
    return { valid: true, evidence: [evidenceItem(manifest, `declares Composer task "${task}"`)] }
  },
}

function makeAdapter(): CommandEvidenceAdapter {
  return {
    id: 'make',
    executables: ['make', 'gmake'],
    validate(context) {
      const manifest = context.evidence.findUp(['Makefile', 'makefile', 'GNUmakefile'], context.workingDirectory)
      if (!manifest) {
        return {
          valid: false,
          code: 'missing-project-evidence',
          message: 'Make command has no Makefile in the effective working directory.',
          expectedEvidence: ['Makefile', 'makefile', 'GNUmakefile'],
        }
      }
      const target = context.argv.slice(1).find((argument) => !argument.startsWith('-') && !argument.includes('='))
      if (target && !manifest.tasks.includes(target)) {
        const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (!manifest.content || !new RegExp(`^${escaped}\\s*:(?![=])`, 'm').test(manifest.content)) {
          return {
            valid: false,
            code: 'missing-task',
            message: `Make target "${target}" is not declared in ${manifest.relativePath}.`,
            expectedEvidence: [`target "${target}" in ${manifest.relativePath}`],
          }
        }
      }
      return { valid: true, evidence: [evidenceItem(manifest, target ? `declares Make target "${target}"` : 'provides the default Make target')] }
    },
  }
}

function localScriptDecision(context: CommandEvidenceAdapterContext): CommandEvidenceAdapterDecision | undefined {
  const executable = context.executable.replaceAll('\\', '/')
  if (executable.includes('/')) {
    const file = context.evidence.get(resolve(context.workingDirectory, executable))
    if (!file) {
      return {
        valid: false,
        code: 'missing-project-evidence',
        message: `Repository-local command "${context.executable}" does not resolve to a file inside the repository.`,
        expectedEvidence: [executable],
      }
    }
    if (!file.planned) {
      try {
        if ((statSync(file.absolutePath).mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) === 0) {
          return {
            valid: false,
            code: 'missing-project-evidence',
            message: `Repository-local command "${context.executable}" exists but is not executable.`,
            expectedEvidence: [`an executable ${file.relativePath}`],
          }
        }
      } catch {
        return { valid: false, code: 'missing-project-evidence', message: `Cannot inspect "${file.relativePath}".` }
      }
    }
    return {
      valid: true,
      evidence: [{ kind: file.planned ? 'planned' : 'local-file', path: file.relativePath, detail: file.source ? `repository-local executable planned by ${file.source}` : 'repository-local executable' }],
    }
  }

  const interpreters = new Set(['bash', 'sh', 'zsh', 'node', 'python', 'python3', 'ruby', 'php', 'pwsh', 'powershell'])
  if (!interpreters.has(executable)) return undefined
  const script = context.argv.slice(1).find((argument) => !argument.startsWith('-') && argument !== 'run')
  if (!script || script === '-m' || (!/[\\/]/.test(script) && !/\.(?:[cm]?js|[cm]?ts|py|rb|php|sh|ps1)$/i.test(script))) return undefined
  const file = context.evidence.get(resolve(context.workingDirectory, script))
  if (!file) {
    return {
      valid: false,
      code: 'missing-project-evidence',
      message: `Script "${script}" does not resolve to a repository file.`,
      expectedEvidence: [script],
    }
  }
  return {
    valid: true,
    evidence: [{ kind: file.planned ? 'planned' : 'local-file', path: file.relativePath, detail: `repository-local script invoked with ${executable}` }],
  }
}

export const DEFAULT_COMMAND_EVIDENCE_ADAPTERS: readonly CommandEvidenceAdapter[] = [
  nodeAdapter,
  manifestAdapter('go', ['go'], ['go.work', 'go.mod']),
  manifestAdapter('rust', ['cargo'], ['Cargo.toml']),
  manifestAdapter('python', ['python', 'python3', 'pytest', 'tox', 'nox', 'uv', 'poetry', 'pip', 'pip3'], ['pyproject.toml', 'setup.cfg', 'setup.py', 'requirements.txt']),
  manifestAdapter('maven', ['mvn', 'mvnw'], ['pom.xml']),
  manifestAdapter('gradle', ['gradle', 'gradlew'], ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts']),
  {
    id: 'dotnet',
    executables: ['dotnet'],
    validate(context) {
      const manifest = context.evidence.findInDirectory(
        (name) => /\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(name),
        context.workingDirectory,
      )
      return manifest
        ? { valid: true, evidence: [evidenceItem(manifest, 'supports the dotnet command family')] }
        : {
            valid: false,
            code: 'missing-project-evidence',
            message: 'dotnet command has no solution or project file in the effective working directory.',
            expectedEvidence: ['*.sln', '*.slnx', '*.csproj', '*.fsproj', '*.vbproj'],
          }
    },
  },
  manifestAdapter('ruby', ['bundle', 'bundler', 'rake', 'rspec'], ['Gemfile', 'Rakefile']),
  composerAdapter,
  manifestAdapter('php', ['phpunit'], ['composer.json', 'phpunit.xml', 'phpunit.xml.dist']),
  makeAdapter(),
  manifestAdapter('cmake', ['cmake', 'ctest'], ['CMakeLists.txt', 'CMakeCache.txt']),
]

export function validateRepositoryCommand(input: RepositoryCommandEvidenceInput): RepositoryCommandEvidenceResult {
  const root = resolve(input.repositoryRoot)
  const initialCwd = resolve(root, input.workingDirectory ?? '.')
  if (!input.command.trim()) return failure(input, initialCwd, 'empty-command', 'Command is empty.')
  if (!isInside(root, initialCwd)) {
    return failure(input, initialCwd, 'invalid-working-directory', 'The effective working directory is outside the repository.')
  }
  const parsed = parseCommand(input, root, initialCwd)
  if (!parsed) {
    return failure(
      input,
      initialCwd,
      'unsupported-shell-syntax',
      'Command syntax is ambiguous or unsupported. Use optional environment assignments, canonical setup wrapper, and "cd <directory> && <command>" only.',
    )
  }

  const executable = parsed.argv[0]!
  const launcher = findCommandLauncher(parsed.launcherPath ?? executable, { workingDirectory: parsed.cwd })
  const filesystem = new EvidenceFilesystem(root, input.plannedEvidence ?? [])
  const context: CommandEvidenceAdapterContext = {
    executable,
    argv: parsed.argv,
    workingDirectory: parsed.cwd,
    repositoryRoot: root,
    commandKind: input.commandKind ?? 'project-command',
    evidence: filesystem,
  }
  const local = localScriptDecision(context)
  const adapters = input.adapters ?? DEFAULT_COMMAND_EVIDENCE_ADAPTERS
  const adapter = adapters.find((candidate) => candidate.executables.includes(executable))
  const decision = local ?? adapter?.validate(context)
  if (!decision) {
    return {
      ...failure(
        input,
        parsed.cwd,
        'unknown-command-family',
        `Command "${executable}" has no repository-local executable or registered evidence adapter.`,
        parsed.wrapperApplied,
        ['a repository-local executable/task script', 'a registered command-evidence adapter'],
      ),
      executable,
      launcher,
    }
  }
  return {
    valid: decision.valid,
    status: decision.valid
      ? (launcher.availability === 'available' ? 'ready' : 'launcher-missing')
      : 'incompatible',
    command: input.command,
    effectiveWorkingDirectory: parsed.cwd,
    executable,
    family: adapter?.id ?? 'repository-local',
    wrapperApplied: parsed.wrapperApplied,
    launcher,
    evidence: decision.evidence ?? [],
    ...(decision.valid
      ? {}
      : {
          code: decision.code ?? 'missing-project-evidence',
          message: decision.message ?? `Command "${executable}" lacks repository evidence.`,
          ...(decision.expectedEvidence ? { expectedEvidence: decision.expectedEvidence } : {}),
        }),
  }
}

export function validateRepositoryCommands(
  inputs: readonly RepositoryCommandEvidenceInput[],
): RepositoryCommandEvidenceResult[] {
  return inputs.map(validateRepositoryCommand)
}
