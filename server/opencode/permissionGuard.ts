import path from 'node:path'

export interface PermissionGuardContext {
  worktreePath: string
  projectRoot: string
  ticketDir: string
}

interface ShellCommand {
  words: string[]
  redirects: string[]
  inputRedirect: boolean
  piped: boolean
  dynamic: boolean
}

const FOLLOW_UP = 'Continue local work; do not retry this action through another tool.'
const COMMAND_PERMISSIONS = new Set(['bash', 'shell', 'command', 'command.execute'])
const PATH_PERMISSIONS = new Set(['edit', 'write', 'file.write', 'apply_patch'])
const GH_READS: Record<string, readonly string[]> = {
  auth: ['status'],
  cache: ['list'],
  codespace: ['list', 'view'],
  gist: ['list', 'view'],
  issue: ['list', 'view', 'status'],
  label: ['list'],
  org: ['list', 'view'],
  pr: ['checks', 'diff', 'list', 'status', 'view'],
  project: ['item-list', 'item-view', 'list', 'view'],
  release: ['download', 'list', 'view'],
  repo: ['list', 'view'],
  run: ['list', 'view', 'watch'],
  secret: ['list'],
  variable: ['list'],
  workflow: ['list', 'view'],
}

const GH_SEARCH_READS = new Set(['code', 'commits', 'issues', 'prs', 'repos'])

// shortcut: indirect scripts, shell functions, aliases, custom executables, and network clients remain unscanned; upgrade if callers need isolation.
export function getPermissionGuardRejection(input: {
  permission?: string
  patterns?: readonly string[]
  details?: Record<string, unknown>
  context?: PermissionGuardContext
  directory?: string
}): string | null {
  const guardedInput = { ...input, protectedDirectory: input.directory ?? input.context?.worktreePath }
  const permission = input.permission?.toLowerCase()
  const resources = permissionResources(input)

  if (permission && COMMAND_PERMISSIONS.has(permission)) {
    if (!resources.length) return reject('the requested command cannot be verified')
    for (const resource of resources) {
      if (!resource.trim()) return reject('the requested command cannot be verified')
      const effect = classifyShell(resource, guardedInput)
      if (effect) return reject(effect)
    }
    return null
  }

  if (permission && PATH_PERMISSIONS.has(permission)) {
    if (!resources.length) return reject('the requested file path cannot be verified')
    for (const resource of resources) {
      if (!resource.trim()) return reject('the requested file path cannot be verified')
      const effect = protectedPathEffect(resource, guardedInput, false)
      if (effect) return reject(effect)
    }
  }

  return null
}

type PermissionGuardInput = Parameters<typeof getPermissionGuardRejection>[0] & { protectedDirectory?: string }

function permissionResources(input: PermissionGuardInput): string[] {
  if (input.patterns?.length) return [...input.patterns]
  const details = input.details
  for (const key of ['patterns', 'resources']) {
    const values = details?.[key]
    if (Array.isArray(values)) return values.filter((value): value is string => typeof value === 'string')
  }
  for (const key of ['command', 'path', 'file', 'resource']) {
    const value = details?.[key]
    if (typeof value === 'string') return [value]
  }
  return []
}

function reject(effect: string): string {
  return `Blocked because ${effect}. ${FOLLOW_UP}`
}

function classifyShell(command: string, input: PermissionGuardInput): string | null {
  const segments = scanShell(command)
  if (!segments.length) return 'the requested command cannot be verified'
  let directory = input.directory ?? input.context?.worktreePath
  const directoryStack: string[] = []

  for (const segment of segments) {
    const currentInput = { ...input, directory }
    for (const target of segment.redirects) {
      const effect = protectedPathEffect(target, currentInput, false)
      if (effect) return effect
    }

    const { commandName, args, environment } = unwrapCommand(segment.words)
    if (!commandName) {
      if (segment.dynamic) return 'a dynamic command cannot be verified'
      continue
    }

    const basename = commandBase(commandName)
    if (basename === 'cd' || basename === 'set-location' || basename === 'sl' || basename === 'pushd') {
      const next = args.find((arg) => !arg.startsWith('-'))
      if (basename === 'pushd' && directory) directoryStack.push(directory)
      if (next && !segment.dynamic) directory = normalizePath(next, directory ?? input.context?.worktreePath)?.path
      else if (next) directory = undefined
      continue
    }
    if (basename === 'popd') {
      directory = directoryStack.pop() ?? directory
      continue
    }

    if (isExecutable(commandName, 'gh')) {
      const effect = classifyGh(args, segment)
      if (effect) return effect
    } else if (isExecutable(commandName, 'git')) {
      const effect = classifyGit(args, currentInput, environment)
      if (effect) return effect
    } else if (isRemovalCommand(commandName)) {
      const effect = classifyRemoval(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (isFileMutationCommand(commandName)) {
      const effect = classifyFileMutation(commandName, args, segment.dynamic, currentInput)
      if (effect) return effect
    }
  }
  return null
}

function scanShell(source: string): ShellCommand[] {
  const words: string[] = []
  const redirects: string[] = []
  const segments: ShellCommand[] = []
  let word = ''
  let quote = ''
  let escaped = false
  let dynamic = false
  let inputRedirect = false
  let piped = false

  const flushWord = () => {
    if (word) words.push(word)
    word = ''
  }
  const finish = (nextIsPipe = false) => {
    flushWord()
    const commandWords: string[] = []
    let commandDynamic = dynamic
    for (let i = 0; i < words.length; i++) {
      const token = words[i]!
      if (token === '<' || token === '<<') {
        inputRedirect = true
        if (token === '<') i++
        continue
      }
      if (token === '>' || token === '>>' || token === '>|') {
        const target = words[++i]
        if (target) redirects.push(target)
        else commandDynamic = true
        continue
      }
      commandWords.push(token)
    }
    if (commandWords.length || redirects.length || inputRedirect || commandDynamic) {
      segments.push({
        words: commandWords,
        redirects: [...redirects],
        inputRedirect,
        piped,
        dynamic: commandDynamic,
      })
    }
    words.length = 0
    redirects.length = 0
    inputRedirect = false
    dynamic = false
    piped = nextIsPipe
  }

  for (let i = 0; i < source.length; i++) {
    const character = source[i]!
    if (escaped) {
      word += character
      escaped = false
      continue
    }
    if (quote) {
      if (character === quote) {
        quote = ''
      } else if (quote === '"' && character === '\\' && i + 1 < source.length && /[$`"\\]/.test(source[i + 1]!)) {
        escaped = true
      } else {
        if (quote === '"' && (character === '$' || character === '`')) dynamic = true
        word += character
      }
      continue
    }
    if (character === '\\') {
      if (i + 1 < source.length && /[\s;&|<>()[\]{}'"\\]/.test(source[i + 1]!)) escaped = true
      else word += character
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      continue
    }
    if (character === '$' || character === '`') dynamic = true
    if (character === '#' && !word) {
      while (i < source.length && source[i] !== '\n') i++
      finish()
      continue
    }
    if (/\s/.test(character)) {
      flushWord()
      if (character === '\n') finish()
      continue
    }
    if (character === '<' || character === '>') {
      flushWord()
      const next = source[i + 1]
      const operator = character + (next === character || (character === '>' && next === '|') ? next : '')
      words.push(operator)
      if (operator.length > 1) i++
      continue
    }
    if (character === ';' || character === '&' || character === '|' || character === '(' || character === ')') {
      flushWord()
      const next = source[i + 1]
      if ((character === '&' && next === '&') || (character === '|' && next === '|')) i++
      finish(character === '|')
      continue
    }
    word += character
  }
  if (quote || escaped) dynamic = true
  finish()
  return segments
}

function unwrapCommand(words: string[]): { commandName?: string; args: string[]; environment: Record<string, string> } {
  let index = 0
  const environment: Record<string, string> = {}
  const prefixArgs: string[] = []
  const readAssignments = () => {
    while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) {
      const assignment = words[index++]!
      const separator = assignment.indexOf('=')
      environment[assignment.slice(0, separator)] = assignment.slice(separator + 1)
    }
  }
  const skipRtk = () => {
    while (commandBase(words[index] ?? '') === 'rtk') {
      index++
      if (words[index] === 'proxy') index++
    }
  }
  readAssignments()
  skipRtk()
  if (commandBase(words[index] ?? '') === 'env') {
    index++
    while (index < words.length) {
      const option = words[index]!
      if (option === '-i' || option === '--ignore-environment') { index++; continue }
      if (option === '-u' || option === '--unset') { index += 2; continue }
      if (option.startsWith('--unset=')) { index++; continue }
      if (option === '-C' || option === '--chdir') {
        const value = words[index + 1]
        if (value) prefixArgs.push('-C', value)
        index += 2
        continue
      }
      if (option.startsWith('--chdir=')) { prefixArgs.push('-C', option.slice('--chdir='.length)); index++; continue }
      break
    }
    if (words[index] === '--') index++
    readAssignments()
  }
  skipRtk()
  const commandName = words[index]
  return { commandName, args: [...prefixArgs, ...words.slice(index + 1)], environment }
}

function classifyGh(args: string[], segment: ShellCommand): string | null {
  if (segment.dynamic) return 'the GitHub CLI request may change remote state or cannot be verified'
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) {
    const option = args[index++]!
    if (['-R', '--repo', '-H', '--hostname', '--config', '--http-unix-socket'].includes(option)) index++
    else if (option === '--') break
  }
  const group = args[index]?.toLowerCase()
  if (!group) return 'the GitHub CLI command cannot be verified as read-only'
  const subcommand = args[index + 1]?.toLowerCase()

  if (group === 'api') return classifyGhApi(args.slice(index + 1), segment)
  if (group === 'codespace' && subcommand === 'ports') return classifyGhCodespacePorts(args.slice(index + 2))
  if (group === 'search' && subcommand && GH_SEARCH_READS.has(subcommand)) return null
  if (group === 'status' && !subcommand) return null
  if (group === 'repo' && subcommand === 'clone') return null
  if (subcommand && GH_READS[group]?.includes(subcommand)) return null
  return 'the GitHub CLI command may write GitHub state or is not on the read-only command list'
}

function classifyGhCodespacePorts(args: string[]): string | null {
  const optionsWithValues = new Set(['-c', '--codespace', '-q', '--jq', '--json', '-R', '--repo', '--repo-owner', '-t', '--template'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '-h') continue
    if (optionsWithValues.has(arg) && args[i + 1]) { i++; continue }
    if (['--jq=', '--json=', '--codespace=', '--repo=', '--repo-owner=', '--template='].some((option) => arg.startsWith(option))) continue
    return 'the GitHub CLI command may write GitHub state or is not on the read-only command list'
  }
  return null
}

function classifyGhApi(args: string[], segment: ShellCommand): string | null {
  if (segment.inputRedirect || segment.piped) return 'the GitHub API request body comes from an unknown pipe or file'
  let endpoint: string | undefined
  let method: string | undefined
  let hasField = false
  let query: string | undefined
  let inputFile = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--method' || arg === '-X') {
      method = args[++i]?.toUpperCase()
      if (!method) return 'the GitHub API method cannot be verified'
      continue
    }
    if (arg.startsWith('--method=')) { method = arg.slice(9).toUpperCase(); continue }
    if (/^-X[A-Za-z]+$/.test(arg)) { method = arg.slice(2).toUpperCase(); continue }
      if (arg === '--input') { inputFile = true; i++; continue }
    if (arg.startsWith('--input=')) { inputFile = true; continue }
    if (['-f', '-F', '--field', '--raw-field'].includes(arg)) {
      const field = args[++i]
      if (!field || !field.includes('=')) return 'the GitHub API request fields cannot be verified'
      if (field.slice(field.indexOf('=') + 1).startsWith('@')) return 'the GitHub API request field comes from an unknown file'
      hasField = true
      if (field.startsWith('query=')) query = field.slice('query='.length)
      continue
    }
    if (arg.startsWith('--field=') || arg.startsWith('--raw-field=')) {
      const field = arg.slice(arg.indexOf('=') + 1)
      if (!field.includes('=')) return 'the GitHub API request fields cannot be verified'
      if (field.slice(field.indexOf('=') + 1).startsWith('@')) return 'the GitHub API request field comes from an unknown file'
      hasField = true
      if (field.startsWith('query=')) query = field.slice('query='.length)
      continue
    }
    if (arg === '--header' || arg === '-H') {
      const header = args[++i]
      if (!header || /(?:x-http-method-override|method-override)\s*:/i.test(header))
        return 'the GitHub API request method cannot be verified'
      continue
    }
    if (arg.startsWith('-')) {
      if (['--paginate', '--slurp', '--silent', '--verbose', '--include', '--cache'].includes(arg)) {
        if (arg === '--cache') i++
        continue
      }
      if (arg === '--jq' || arg === '-q') { i++; continue }
      if (arg.startsWith('--jq=')) continue
      return 'the GitHub API request options cannot be verified as read-only'
    }
    if (!endpoint) endpoint = arg
  }

  if (inputFile) return 'the GitHub API request body comes from an unknown file'
  if (!endpoint) return 'the GitHub API endpoint cannot be verified'
  const graphql = /(?:^|\/)graphql$/i.test(endpoint)
  if (graphql) {
    if (!query || query.startsWith('@')) return 'the GraphQL request body cannot be verified'
    const operation = graphqlOperation(query)
    if (operation === 'query') return null
    return operation === 'mutation'
      ? 'the GraphQL mutation would write GitHub state'
      : 'the GraphQL operation cannot be verified as read-only'
  }

  const effectiveMethod = method ?? (hasField ? 'POST' : 'GET')
  if (effectiveMethod === 'GET' || effectiveMethod === 'HEAD') return null
  return `the GitHub API ${effectiveMethod} request may write remote state`
}

function graphqlOperation(query: string): 'query' | 'mutation' | 'other' {
  const document = query.replace(/^\uFEFF/, '')
    .replace(/"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|#[^\n]*/g, ' ')
    .replace(/,/g, ' ')
    .trimStart()
  if (document.startsWith('{')) return 'query'
  const operations = [...document.matchAll(/(?:^|})\s*(query|mutation|subscription)\b/gim)].map((match) => match[1]!.toLowerCase())
  if (operations.includes('mutation')) return 'mutation'
  return operations.length > 0 && operations.every((operation) => operation === 'query') ? 'query' : 'other'
}

function classifyGit(args: string[], input: PermissionGuardInput, environment: Record<string, string>): string | null {
  let index = 0
  let directory = input.directory ?? input.context?.worktreePath
  let explicitGitDir: string | undefined
  let explicitWorkTree: string | undefined
  let dynamicTarget = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']
    .some((name) => {
      const value = environment[name]
      return Boolean(value && (/[$`]/.test(value) || (!directory && !isAbsolutePath(value))))
    })
  while (index < args.length) {
    const arg = args[index]!
    if (arg === '-C' || arg === '-c') {
      const value = args[index + 1]
      if (!value) return 'the Git command target cannot be verified'
      if (arg === '-C') {
        dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
        directory = normalizePath(value, directory)?.path
      }
      index += 2
      continue
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      const value = arg.slice(2)
      dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
      directory = normalizePath(value, directory)?.path; index++; continue
    }
    if (arg.startsWith('-c') && arg.length > 2) { index++; continue }
    if (arg === '--git-dir' || arg === '--work-tree') {
      const value = args[index + 1]
      if (!value) return 'the Git command target cannot be verified'
      dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
      if (arg === '--git-dir') explicitGitDir = value
      else explicitWorkTree = value
      index += 2; continue
    }
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      const value = arg.slice(arg.indexOf('=') + 1)
      dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
      if (arg.startsWith('--git-dir=')) explicitGitDir = value
      else explicitWorkTree = value
      index++; continue
    }
    if (arg.startsWith('-')) { index++; continue }
    break
  }

  const command = args[index]?.toLowerCase()
  const gitArgs = args.slice(index + 1)
  if (!command) return null
  if (command === 'push' || command === 'send-pack') return 'the Git command would write to a remote repository'

  if (command === 'init' || command === 'clone') {
    const creation = gitCreationPaths(command, gitArgs)
    if (!creation.verified || dynamicTarget || [creation.destination, creation.separateGitDir].some((target) => /[$`]/.test(target ?? ''))) {
      return 'the Git metadata target cannot be verified'
    }
    const creationInput = { ...input, directory }
    const defaultDestination = creation.destination ?? (command === 'init' ? explicitWorkTree ?? environment.GIT_WORK_TREE ?? directory : undefined)
    if ((command === 'init' && !defaultDestination) || [defaultDestination, creation.separateGitDir].some((target) => Boolean(target && !directory && !isAbsolutePath(target)))) {
      return 'the Git metadata target cannot be verified'
    }
    const targets = [
      defaultDestination,
      creation.separateGitDir,
      explicitGitDir ?? environment.GIT_DIR,
      explicitWorkTree ?? environment.GIT_WORK_TREE,
      environment.GIT_COMMON_DIR,
    ].filter((target): target is string => Boolean(target))
    if (!targets.length) return 'the Git metadata target cannot be verified'
    for (const target of targets) {
      const effect = protectedPathEffect(target, creationInput, false)
      if (effect) return effect
    }
  }

  const commandInput = { ...input, directory }
  const gitDir = explicitGitDir ?? environment.GIT_DIR
  const commonDir = environment.GIT_COMMON_DIR
  const workTree = explicitWorkTree ?? environment.GIT_WORK_TREE
  const metadataTargets = [gitDir, commonDir, ...(gitDir || commonDir ? [] : [directory])]
  const workTreeTargets = [workTree ?? directory]
  const targetStates = [...metadataTargets, ...workTreeTargets]
    .filter((target): target is string => Boolean(target))
    .map((target) => isManagedGitTarget(target, commandInput))
  const isManaged = targetStates.includes(true)
  const targetUnknown = dynamicTarget || targetStates.length === 0 || targetStates.includes(undefined)
  const scopedBlock = (effect: string) => isManaged || targetUnknown ? effect : null

  if (command === 'reset' && gitArgs.some((arg) => ['--hard', '--merge', '--keep'].includes(arg))) {
    return scopedBlock(targetUnknown ? 'the destructive Git reset target cannot be verified' : 'the reset could discard local work in the managed ticket worktree')
  }
  if (command === 'clean' && !gitArgs.some((arg) => arg === '--dry-run' || /^-[A-Za-z]*n[A-Za-z]*$/.test(arg))) {
    return scopedBlock(targetUnknown ? 'the Git clean target cannot be verified' : 'the Git clean could remove local files from the managed ticket worktree')
  }
  if (command === 'rebase' && !gitArgs.includes('--abort') && !gitArgs.includes('--show-current-patch')) {
    return scopedBlock(targetUnknown ? 'the Git rebase target cannot be verified' : 'the Git rebase could rewrite managed repository history')
  }

  const metadataChange = gitMetadataChange(command, gitArgs)
  if (metadataChange) {
    return scopedBlock(targetUnknown ? 'the Git metadata target cannot be verified' : 'the command would change managed Git metadata')
  }

  if (['checkout', 'restore'].includes(command)) {
    const paths = gitRestorePaths(command, gitArgs)
    if (command === 'checkout' && gitArgs.includes('.') && !paths.includes('.')) paths.push('.')
    for (const targetPath of paths) {
      const effect = protectedPathEffect(targetPath, commandInput, true)
      if (effect) return effect
    }
  }

  return null
}

function gitMetadataChange(command: string, args: string[]): boolean {
  if (command === 'update-ref' || command === 'symbolic-ref' || command === 'gc') return true
  if (command === 'remote') return ['add', 'rename', 'remove', 'rm', 'set-url', 'prune', 'update'].includes(args[0]?.toLowerCase() ?? '')
  if (command === 'worktree') return ['add', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock'].includes(args[0]?.toLowerCase() ?? '')
  if (command === 'branch') return args.some((arg) => ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy'].includes(arg))
  if (command === 'tag') return args.some((arg) => ['-d', '--delete', '-f', '--force'].includes(arg))
  if (command === 'stash') return ['clear', 'drop'].includes(args[0]?.toLowerCase() ?? '')
  if (command !== 'config') return false
  if (args.includes('--global') || args.includes('--system')) return false
  if (args.some((arg) => ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope', '--name-only'].includes(arg))) return false
  return true
}

function gitCreationPaths(command: string, args: string[]): { destination?: string; separateGitDir?: string; verified: boolean } {
  const operands: string[] = []
  const optionsWithValues = new Set(['-b', '--branch', '-o', '--origin', '-u', '--upload-pack', '-j', '--jobs', '--depth', '--shallow-since', '--shallow-exclude', '--reference', '--reference-if-able', '--config', '--config-env', '--filter', '--server-option', '--bundle-uri', '--revision', '--template', '--initial-branch', '--object-format', '--ref-format'])
  let separateGitDir: string | undefined
  let verified = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { operands.push(...args.slice(i + 1)); break }
    if (arg === '--separate-git-dir') {
      separateGitDir = args[++i]
      if (!separateGitDir) verified = false
      continue
    }
    if (arg.startsWith('--separate-git-dir=')) {
      separateGitDir = arg.slice('--separate-git-dir='.length)
      if (!separateGitDir) verified = false
      continue
    }
    if (optionsWithValues.has(arg)) {
      if (!args[i + 1]) verified = false
      i++
      continue
    }
    if (/^-(?:b|o|u|j|c).+/.test(arg)) continue
    if (arg.startsWith('-')) continue
    operands.push(arg)
  }
  const destination = command === 'init'
    ? operands[0]
    : operands[1] ?? defaultCloneDestination(operands[0])
  if (command === 'clone' && !operands[0]) verified = false
  return { destination, separateGitDir, verified }
}

function defaultCloneDestination(source: string | undefined): string | undefined {
  const repository = source?.replace(/[?#].*$/, '').replace(/[\\/]+$/, '')
  const name = repository?.split(/[\\/:]/).at(-1)
  return name?.replace(/\.git$/i, '') || undefined
}

function gitRestorePaths(command: string, args: string[]): string[] {
  const separator = args.indexOf('--')
  if (command === 'checkout') return separator < 0 ? [] : args.slice(separator + 1)
  const paths: string[] = []
  const optionsWithValues = new Set(['--source', '-s', '--worktree', '--staged'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') return [...paths, ...args.slice(i + 1)]
    if (optionsWithValues.has(arg)) { if (arg === '--source' || arg === '-s') i++; continue }
    if (arg.startsWith('-')) continue
    paths.push(arg)
  }
  return paths
}

function isManagedGitTarget(target: string, input: PermissionGuardInput): boolean | undefined {
  const base = input.directory ?? input.context?.worktreePath
  const resolved = normalizePath(target, base)
  if (!resolved) return undefined
  if (!input.context) {
    const executionDirectory = input.protectedDirectory && normalizePath(input.protectedDirectory)
    if (executionDirectory && pathsOverlap(executionDirectory, resolved)) return true
    const looptroop = input.protectedDirectory?.match(/^(.*?)[\\/]\.looptroop(?=[\\/]|$)/i)
    if (looptroop) {
      const protectedRoots = [joinPath(looptroop[1]!, '.looptroop'), joinPath(looptroop[1]!, '.git')]
        .map((root) => normalizePath(root))
      if (protectedRoots.some((root) => root && pathsOverlap(root, resolved))) return true
    }
    return input.directory || target ? false : undefined
  }
  const roots = [input.context.worktreePath, input.context.projectRoot, joinPath(input.context.projectRoot, '.looptroop')]
  for (const root of roots) {
    const normalizedRoot = normalizePath(root)
    if (normalizedRoot && pathContains(normalizedRoot, resolved)) return true
  }
  return false
}

function classifyRemoval(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  if (args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version')) return null
  const targets: string[] = []
  const optionsWithValues = new Set(['-Path', '-LiteralPath', '-Include', '-Exclude', '-Filter', '-Stream'])
  let afterSeparator = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { afterSeparator = true; continue }
    if (!afterSeparator && optionsWithValues.has(arg.toLowerCase())) {
      const value = args[++i]
      if (value) targets.push(value)
      continue
    }
    if (!afterSeparator && /^\/(?:s|q|f|recurse|force)$/i.test(arg)) continue
    if (!afterSeparator && arg.startsWith('-')) continue
    targets.push(arg)
  }
  if (!targets.length) return 'the destructive command target cannot be verified'
  for (const target of targets) {
    if (dynamic && /[$`]/.test(target)) return 'the destructive command target cannot be verified'
    const effect = protectedPathEffect(target, input, true)
    if (effect) return effect
  }
  return null
}

function isRemovalCommand(command: string): boolean {
  return ['rm', 'rm.exe', 'rmdir', 'rmdir.exe', 'remove-item', 'ri', 'del', 'erase', 'wipe', 'shred'].includes(basename(command).toLowerCase())
}

function isFileMutationCommand(command: string): boolean {
  return ['cp', 'cp.exe', 'copy', 'copy.exe', 'copy-item', 'cpi', 'mv', 'mv.exe', 'move', 'move.exe', 'move-item', 'mi', 'tee', 'tee.exe', 'tee-object', 'truncate', 'truncate.exe'].includes(basename(command).toLowerCase())
}

function classifyFileMutation(commandName: string, args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  const command = basename(commandName).toLowerCase().replace(/\.exe$/, '')
  const copy = ['cp', 'copy', 'copy-item', 'cpi'].includes(command)
  const move = ['mv', 'move', 'move-item', 'mi'].includes(command)
  const tee = ['tee', 'tee-object'].includes(command)
  const targets: string[] = []
  const operands: string[] = []
  const sources: string[] = []
  const optionsWithValues = new Set(tee
    ? ['-inputobject', '-variable']
    : copy || move
      ? ['-t', '--target-directory', '--suffix', '-path', '-literalpath']
      : ['-s', '--size', '-r', '--reference', '--io-block-size', '-b', '--block-size'])
  let targetDirectory: string | undefined
  let namedDestination: string | undefined
  let afterSeparator = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const option = arg.toLowerCase()
    if (!afterSeparator && arg === '--') { afterSeparator = true; continue }
    if (!afterSeparator && ['--help', '-h', '--version'].includes(option)) return null
    if (!afterSeparator && ['-destination', '-dest'].includes(option)) {
      namedDestination = args[++i]
      continue
    }
    if (!afterSeparator && /^-(?:destination|dest)[:=]/.test(option)) {
      namedDestination = arg.slice(arg.search(/[:=]/) + 1)
      continue
    }
    if (!afterSeparator && ['-filepath', '-file-path'].includes(option)) {
      const target = args[++i]
      if (target) targets.push(target)
      continue
    }
    if (!afterSeparator && /^-(?:filepath|file-path)[:=]/.test(option)) {
      targets.push(arg.slice(arg.search(/[:=]/) + 1))
      continue
    }
    if (!afterSeparator && ['-t', '--target-directory', '-targetdirectory'].includes(option)) {
      targetDirectory = args[++i]
      continue
    }
    if (!afterSeparator && /^-t.+/.test(arg)) { targetDirectory = arg.slice(2); continue }
    if (!afterSeparator && /^(?:-t|--target-directory|-targetdirectory)=/.test(option)) {
      targetDirectory = arg.slice(arg.indexOf('=') + 1)
      continue
    }
    if (!afterSeparator && optionsWithValues.has(option)) {
      const value = args[++i]
      if ((copy || move) && ['-path', '-literalpath'].includes(option) && value) sources.push(value)
      continue
    }
    if (!afterSeparator && (arg.startsWith('--size=') || arg.startsWith('--suffix=') || arg.startsWith('--io-block-size='))) continue
    if (!afterSeparator && ['copy', 'move'].includes(command) && /^\/(?:y|v|a|b|n|z)$/i.test(arg)) continue
    if (!afterSeparator && arg.startsWith('-')) continue
    operands.push(arg)
  }

  if (copy || move) {
    const destination = targetDirectory ?? namedDestination ?? (operands.length >= 2 ? operands.at(-1) : undefined)
    const directoryDestination = Boolean(targetDirectory) || Boolean(destination && (['.', '..'].includes(destination) || /[\\/]$/.test(destination)))
    const copySources = [...sources, ...operands.slice(0, destination === targetDirectory || destination === namedDestination ? undefined : -1)]
    if (directoryDestination && destination) {
      if (!copySources.length) return 'the file mutation destination cannot be verified'
      targets.push(...copySources.map((source) => joinPath(destination, basename(source.replace(/[\\/]+$/, '')))))
    } else if (destination) targets.push(destination)
    else if (operands.length > 0 || sources.length > 0) return 'the file mutation destination cannot be verified'
    if (move) targets.push(...sources, ...(targetDirectory || namedDestination ? operands : operands.slice(0, -1)))
  } else {
    targets.push(...operands)
  }

  if (!targets.length) return copy || move || !tee ? 'the file mutation target cannot be verified' : null
  for (const target of targets) {
    if (dynamic && /[$`]/.test(target)) return 'the file mutation target cannot be verified'
    const effect = protectedPathEffect(target, input, true)
    if (effect) return effect
  }
  return null
}

function protectedPathEffect(rawPath: string, input: PermissionGuardInput, broad: boolean): string | null {
  const resolved = normalizePath(rawPath, input.directory ?? input.context?.worktreePath)
  if (!resolved) return broad ? 'the destructive path cannot be verified' : null
  const prefix = fixedPrefix(resolved)
  const context = input.context
  const runtime = context ? normalizePath(joinPath(context.ticketDir, 'runtime')) : undefined
  const prefixInsideRuntime = runtime && pathContains(runtime, prefix)
  const hasContext = Boolean(context || input.directory)
  const rawIsBroadRoot = ['.', '..', '/', '\\', '*', '**', '/*', '/**', '.\\*', './*'].includes(rawPath.trim())
  if (!hasContext && (rawIsBroadRoot || /(?:^|[\\/])(?:\*\*?|\.\.?)(?:[\\/]|$)/.test(rawPath))) {
    return 'the destructive path scope cannot be verified'
  }
  const assignedDirectory = input.protectedDirectory ?? input.directory
  const executionDirectory = !context && assignedDirectory ? normalizePath(assignedDirectory) : undefined
  if (broad && executionDirectory && pathContains(prefix, executionDirectory)) {
    return 'the command could remove the assigned execution directory'
  }

  if (runtime) {
    const runtimeState = [
      'execution-log.jsonl',
      'execution-log.debug.jsonl',
      'execution-log.ai.jsonl',
      'execution-setup-profile.json',
    ].map((name) => normalizePath(joinPath(runtime.path, name)))
    if (pathContains(runtime, prefix) && runtimeState.some((state) => state && pathsOverlap(prefix, state))) {
      return 'the target would change protected ticket runtime state'
    }
  }

  const roots: Array<{ path: string; projectState?: boolean; ticketState?: boolean }> = []
  const worktree = context ? normalizePath(context.worktreePath) : undefined
  if (broad && worktree && pathContains(prefix, worktree)) {
    return 'the command could remove the managed ticket worktree'
  }
  if (context) {
    roots.push(
      { path: joinPath(context.projectRoot, '.git') },
      { path: joinPath(context.projectRoot, '.looptroop'), projectState: true },
      { path: joinPath(context.worktreePath, '.git') },
      { path: joinPath(context.worktreePath, '.ticket'), ticketState: true },
      { path: joinPath(context.worktreePath, '.looptroop') },
      { path: context.ticketDir, ticketState: true },
    )
  }

  for (const { path: root, projectState, ticketState } of roots) {
    const protectedRoot = normalizePath(root)
    if (!protectedRoot || !pathsOverlap(prefix, protectedRoot)) continue
    if (ticketState && runtime && pathContains(runtime, prefix)) continue
    if (projectState && context) {
      const worktree = normalizePath(context.worktreePath)
      if (worktree && pathContains(worktree, prefix)) continue
    }
    if (root === context?.worktreePath && !broad) continue
    if (root === context?.worktreePath && !rawIsBroadRoot && !hasGlob(rawPath)) continue
    if (ticketState) return 'the target would change or remove managed ticket state'
    if (projectState) return 'the target would change or remove managed LoopTroop state'
    if (/[\\/]\.git$/i.test(root)) return 'the target would change managed Git metadata'
    return 'the target would change or remove managed LoopTroop state or Git metadata'
  }

  if (context) {
    const worktree = normalizePath(context.worktreePath)
    const candidateRelative = worktree && relativePath(worktree, prefix)
    const parts = candidateRelative?.split(/[\\/]+/).filter(Boolean) ?? []
    const ticketIndex = parts.findIndex((part) => equalsPath(part, '.ticket', worktree?.windows ?? false))
    const gitIndex = parts.findIndex((part) => equalsPath(part, '.git', worktree?.windows ?? false))
    const looptroopIndex = parts.findIndex((part) => equalsPath(part, '.looptroop', worktree?.windows ?? false))
    if (gitIndex >= 0 || looptroopIndex >= 0) return 'the target would change or remove managed LoopTroop state or Git metadata'
    if (ticketIndex >= 0) {
      const runtimeIndex = ticketIndex + 1
      if (!equalsPath(parts[runtimeIndex] ?? '', 'runtime', worktree?.windows ?? false) || !prefixInsideRuntime) {
        return 'the target would change or remove managed ticket state'
      }
    }
  } else if (hasControlComponent(rawPath) && (!executionDirectory || pathsOverlap(executionDirectory, prefix))) {
    return 'the target would change or remove managed LoopTroop state or Git metadata'
  }

  if (broad && context) {
    const projectRoot = normalizePath(context.projectRoot)
    if (projectRoot && pathContains(prefix, projectRoot)) return 'the command could remove a repository containing managed worktrees'
  }
  return null
}

function normalizePath(raw: string, base?: string): NormalizedPath | undefined {
  let value = raw.trim()
  if (!value) return undefined
  if (/^file:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      value = decodeURIComponent(url.pathname)
      if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1)
      if (url.hostname && url.hostname !== 'localhost') value = `\\\\${url.hostname}${value.replace(/\//g, '\\')}`
    } catch {
      return undefined
    }
  }
  const windows = isWindowsPath(value) || Boolean(base && isWindowsPath(base))
  const implementation = windows ? path.win32 : path.posix
  const normalized = implementation.normalize(implementation.resolve(base ?? (windows ? 'C:\\' : '/'), value))
  return { path: normalized, windows }
}

interface NormalizedPath { path: string; windows: boolean }

function fixedPrefix(value: NormalizedPath): NormalizedPath {
  const implementation = value.windows ? path.win32 : path.posix
  const { root } = implementation.parse(value.path)
  let prefix = root
  for (const part of value.path.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    if (hasGlob(part)) break
    prefix = implementation.join(prefix, part)
  }
  return { path: prefix || root || value.path, windows: value.windows }
}

function pathContains(parent: NormalizedPath, child: NormalizedPath): boolean {
  if (parent.windows !== child.windows) return false
  const implementation = parent.windows ? path.win32 : path.posix
  const relative = implementation.relative(parent.path, child.path)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${implementation.sep}`) && !implementation.isAbsolute(relative))
}

function pathsOverlap(left: NormalizedPath, right: NormalizedPath): boolean {
  return pathContains(left, right) || pathContains(right, left)
}

function relativePath(parent: NormalizedPath, child: NormalizedPath): string | undefined {
  if (parent.windows !== child.windows) return undefined
  return (parent.windows ? path.win32 : path.posix).relative(parent.path, child.path)
}

function joinPath(base: string, child: string): string {
  return isWindowsPath(base) ? path.win32.join(base, child) : path.posix.join(base, child)
}

function isWindowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value)
}

function isAbsolutePath(value: string): boolean {
  return isWindowsPath(value) ? path.win32.isAbsolute(value) : path.posix.isAbsolute(value)
}

function hasGlob(value: string): boolean {
  return [...value].some((character) => '*?{}[]'.includes(character))
}

function hasControlComponent(value: string): boolean {
  return /(?:^|[\\/])(?:\.git|\.ticket|\.looptroop)(?:[\\/]|$)/i.test(value)
}

function isExecutable(value: string, name: string): boolean {
  return basename(value).toLowerCase() === name || basename(value).toLowerCase() === `${name}.exe`
}

function basename(value: string): string {
  return value.split(/[\\/]/).at(-1) ?? value
}

function commandBase(value: string): string {
  const name = basename(value).toLowerCase()
  return name.endsWith('.exe') ? name.slice(0, -4) : name
}

function equalsPath(left: string, right: string, windows: boolean): boolean {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right
}
