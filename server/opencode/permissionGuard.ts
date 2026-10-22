import path from 'node:path'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'

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
  substitution: boolean
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
  unverifiedDirectory?: boolean
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

type PermissionGuardInput = Parameters<typeof getPermissionGuardRejection>[0] & { protectedDirectory?: string; environment?: Record<string, string> }

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

function classifyShell(command: string, input: PermissionGuardInput, depth = 0): string | null {
  if (depth > 8) return 'the nested shell command cannot be verified'
  const segments = scanShell(command)
  if (!segments.length) return 'the requested command cannot be verified'
  let directory = input.directory ?? input.context?.worktreePath
  const directoryStack: string[] = []
  const exportedEnvironment: Record<string, string> = { ...input.environment }

  for (const segment of segments) {
    const currentInput = { ...input, directory }
    for (const target of segment.redirects) {
      const effect = protectedPathEffect(target, currentInput, false)
      if (effect) return effect
    }

    if (segment.substitution) return 'inline command substitution cannot be verified; use separate literal commands'
    const unwrapped = unwrapCommand(segment.words)
    if (unwrapped.error) return unwrapped.error
    const { commandName, args } = unwrapped
    const environment = { ...exportedEnvironment, ...unwrapped.environment }
    for (const target of unwrapped.mutationPaths) {
      const effect = protectedPathEffect(target, currentInput, true)
      if (effect) return effect
    }
    for (const nextDirectory of unwrapped.directories) {
      currentInput.directory = normalizePath(nextDirectory, currentInput.directory ?? input.context?.worktreePath)?.path
    }
    currentInput.environment = environment
    for (const target of unwrapped.mutationPaths) {
      const effect = protectedPathEffect(target, currentInput, true)
      if (effect) return effect
    }
    if (!commandName) {
      if (segment.dynamic) return 'a dynamic command cannot be verified'
      Object.assign(exportedEnvironment, unwrapped.environment)
      continue
    }

    const basename = commandBase(commandName)
    if (commandName.startsWith('$env:') && (commandName.includes('=') || args[0] === '=')) {
      const name = commandName.slice(5).split('=')[0]!
      if (name.startsWith('GIT_')) return 'the Git environment cannot be verified; use a literal environment prefix'
      continue
    }
    if (/[$`{}]/.test(commandName)) return 'the dynamic command cannot be verified'
    if (['export', 'set', 'unset'].includes(basename)) {
      for (const value of args) {
        const name = value.split('=')[0]!
        if (!name.startsWith('GIT_')) continue
        if (basename === 'unset') delete exportedEnvironment[name]
        else if (value.includes('=') && !segment.dynamic) exportedEnvironment[name] = value.slice(value.indexOf('=') + 1)
        else return 'the Git environment cannot be verified'
      }
      continue
    }
    if (['if', 'then', 'elif', 'else', 'while', 'until', 'for', 'do', 'case', 'select', 'function'].includes(basename)) {
      return 'the compound shell command cannot be verified; use separate literal commands'
    }
    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'pwsh', 'powershell', 'cmd', 'eval', 'iex', 'invoke-expression'].includes(basename)) {
      if (args.some((arg) => /^-(?:e|ec|encodedcommand)$/i.test(arg))) return 'the encoded shell command cannot be verified; use a literal command'
      const flag = args.findIndex((arg) => /^-(?:[a-z]*c|command)$/i.test(arg) || /^\/[ck]$/i.test(arg))
      const inline = ['eval', 'iex', 'invoke-expression'].includes(basename) ? args.join(' ') : flag >= 0 ? args[flag + 1] : undefined
      if (flag >= 0 && inline === undefined) return 'the inline shell command cannot be verified'
      if (inline !== undefined) {
        const script = ['cmd', 'pwsh', 'powershell'].includes(basename) ? args.slice(flag + 1).join(' ') : inline
        const effect = classifyShell(script, currentInput, depth + 1)
        if (effect) return effect
      }
      continue
    }
    if (['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'].includes(basename)) {
      const next = args.find((arg) => !arg.startsWith('-'))
      if (['pushd', 'push-location'].includes(basename) && directory) directoryStack.push(directory)
      if (next && !segment.dynamic) directory = normalizePath(next, directory ?? input.context?.worktreePath)?.path
      else if (next) directory = undefined
      continue
    }
    if (basename === 'popd' || basename === 'pop-location') {
      directory = directoryStack.pop() ?? directory
      continue
    }

    if (isExecutable(commandName, 'gh')) {
      const effect = classifyGh(args, segment, currentInput)
      if (effect) return effect
    } else if (isExecutable(commandName, 'git')) {
      const effect = classifyGit(args, currentInput, environment, segment.dynamic || unwrapped.dynamicArguments)
      if (effect) return effect
    } else if (basename === 'find') {
      const effect = classifyFind(args, currentInput, depth)
      if (effect) return effect
    } else if (['set-content', 'add-content', 'clear-content', 'out-file'].includes(basename)) {
      const effect = classifyContentWrite(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (basename === 'dd') {
      const target = args.find((arg) => arg.startsWith('of='))?.slice(3)
      if (target) {
        const effect = protectedPathEffect(target, currentInput, true)
        if (effect) return effect
      }
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
  let substitution = false
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
      const item = words[i]!
      if (item === '<' || item === '<<') {
        inputRedirect = true
        if (item === '<') i++
        continue
      }
      if (item === '>' || item === '>>' || item === '>|') {
        const target = words[++i]
        if (target) redirects.push(target)
        else commandDynamic = true
        continue
      }
      commandWords.push(item)
    }
    if (commandWords.length || redirects.length || inputRedirect || commandDynamic) {
      segments.push({
        words: commandWords,
        redirects: [...redirects],
        inputRedirect,
        piped,
        dynamic: commandDynamic,
        substitution,
      })
    }
    words.length = 0
    redirects.length = 0
    inputRedirect = false
    dynamic = false
    substitution = false
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
        if (quote === '"' && (character === '$' || character === '`')) {
          dynamic = true
          substitution ||= character === '`' || source[i + 1] === '('
        }
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
    if (character === '`' || (character === '$' && source[i + 1] === '(')) substitution = true
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
      if (word && [...word].every((value) => value >= '0' && value <= '9')) word = ''
      flushWord()
      const next = source[i + 1]
      if (next === '&' && /[\d-]/.test(source[i + 2] ?? '')) {
        i += 2
        while (/[\d-]/.test(source[i + 1] ?? '')) i++
        continue
      }
      const operator = character + (next === character || (character === '>' && next === '|') ? next : '')
      words.push(operator)
      if (operator.length > 1) i++
      continue
    }
    if (character === ';' || character === '&' || character === '|' || character === '(' || character === ')' || ((character === '{' || character === '}') && !word && source[i + 1] !== '}')) {
      flushWord()
      const next = source[i + 1]
      if ((character === '&' && next === '&') || (character === '|' && next === '|')) i++
      finish(character === '|' && next !== '|')
      continue
    }
    word += character
  }
  if (quote || escaped) dynamic = true
  finish()
  return segments
}

function unwrapCommand(words: string[]): {
  commandName?: string; args: string[]; environment: Record<string, string>
  directories: string[]; mutationPaths: string[]; dynamicArguments: boolean; error?: string
} {
  let index = 0
  const environment: Record<string, string> = {}
  const directories: string[] = []
  const mutationPaths: string[] = []
  let dynamicArguments = false
  const result = (error?: string) => ({ commandName: words[index], args: words.slice(index + 1), environment, directories, mutationPaths, dynamicArguments, error })
  const valueOptions: Record<string, string[]> = {
    env: ['-u', '--unset', '-C', '--chdir'],
    sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir'],
    doas: ['-u', '-C'], exec: ['-a'], nice: ['-n', '--adjustment'],
    time: ['-f', '--format', '-o', '--output'], timeout: ['-k', '--kill-after', '-s', '--signal'],
    stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
    xargs: ['-n', '--max-args', '-s', '--max-chars', '-P', '--max-procs', '-L', '--max-lines', '-I', '--replace', '-d', '--delimiter', '-E', '--eof', '-a', '--arg-file'],
    npx: ['-p', '--package', '-c', '--call'],
  }
  const flagOptions: Record<string, string[]> = {
    env: ['-i', '--ignore-environment'], sudo: ['-n', '-E', '-H', '-k', '-K', '-b', '-S'],
    doas: ['-n', '-s'], command: ['-p', '-v', '-V'], exec: ['-c', '-l'],
    nohup: [], nice: [], time: ['-p', '-v', '--verbose', '-a', '--append'],
    timeout: ['--foreground', '--preserve-status', '-v', '--verbose'], stdbuf: [],
    xargs: ['-0', '--null', '-r', '--no-run-if-empty', '-p', '-t', '-x', '--exit'],
    npx: ['-y', '--yes', '--no', '--no-install', '--quiet'],
    setsid: ['-f', '--fork', '-w', '--wait', '-c', '--ctty'],
  }
  while (index < words.length) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) {
      const assignment = words[index++]!
      const separator = assignment.indexOf('=')
      environment[assignment.slice(0, separator)] = assignment.slice(separator + 1)
    }
    const name = commandBase(words[index] ?? '')
    if (name === 'rtk') {
      index++
      while (words[index] && (/^-v+$/.test(words[index]!) || ['--verbose', '--ultra-compact', '--skip-env'].includes(words[index]!))) index++
      if (words[index] === 'run') {
        index++
        while (['--ultra-compact', '--skip-env', '--'].includes(words[index] ?? '')) index++
        if (words[index] === '-c' || words[index] === '--command') index++
        return { ...result(), commandName: 'sh', args: ['-c', words.slice(index).join(' ')] }
      }
      if (['proxy', 'err', 'test', 'summary'].includes(words[index] ?? '')) index++
      while (['--ultra-compact', '--skip-env', '--'].includes(words[index] ?? '')) index++
      if (words[index]?.startsWith('-')) return result('the RTK wrapper options cannot be verified')
      continue
    }
    if ((name === 'pnpm' || name === 'yarn') && words[index + 1] === 'dlx') {
      index++
      words = [...words.slice(0, index), 'npx', ...words.slice(index + 1)]
      continue
    }
    if (name === 'busybox') { index++; continue }
    if (!(name in flagOptions)) break
    index++
    while (words[index]?.startsWith('-') && words[index] !== '--') {
      const option = words[index]!
      const equal = option.indexOf('=')
      const key = equal < 0 ? option : option.slice(0, equal)
      if (name === 'env' && (key === '-S' || key === '--split-string')) {
        const value = equal >= 0 ? option.slice(equal + 1) : words[++index]
        const parsed = value ? scanShell(value) : []
        if (parsed.length !== 1 || parsed[0]!.dynamic || parsed[0]!.redirects.length) return result('the environment command string cannot be verified')
        words = [...words.slice(0, index + 1), ...parsed[0]!.words, ...words.slice(index + 1)]
        index++
        break
      }
      const attached = equal < 0 && option.length > 2 && valueOptions[name]?.includes(option.slice(0, 2))
      if (valueOptions[name]?.includes(key) || attached) {
        const value = equal >= 0 ? option.slice(equal + 1) : attached ? option.slice(2) : words[++index]
        if (!value) return result('the command wrapper option cannot be verified')
        if ((name === 'env' && ['-C', '--chdir'].includes(key)) || (name === 'sudo' && ['-D', '--chdir'].includes(key))) directories.push(value)
        if (name === 'time' && ['-o', '--output'].includes(key)) mutationPaths.push(value)
        if (name === 'npx' && ['-c', '--call'].includes(key)) return { ...result(), commandName: 'sh', args: ['-c', value] }
      } else if (!flagOptions[name]?.includes(key) && !(name === 'nice' && /^-\d+$/.test(option))) {
        return result('the command wrapper options cannot be verified')
      }
      index++
    }
    if (words[index] === '--') index++
    if (name === 'timeout') index++
    if (name === 'xargs') dynamicArguments = true
  }
  return result()
}

function classifyGh(args: string[], segment: ShellCommand, input: PermissionGuardInput): string | null {
  if (segment.dynamic) return 'the GitHub CLI request may change remote state or cannot be verified'
  let index = 0
  while (index < args.length && args[index]!.startsWith('-')) {
    const option = args[index++]!
    if (['-R', '--repo', '-H', '--hostname', '--config', '--http-unix-socket'].includes(option)) index++
    else if (option === '--') break
  }
  const group = args[index]?.toLowerCase()
  if (!group) return 'the GitHub CLI command cannot be verified as read-only'
  let subcommandIndex = index + 1
  while (['-R', '--repo', '-H', '--hostname'].includes(args[subcommandIndex] ?? '')) subcommandIndex += 2
  const subcommand = args[subcommandIndex]?.toLowerCase()

  if (group === 'api') return classifyGhApi(args.slice(index + 1), segment)
  if (group === 'codespace' && subcommand === 'ports') return classifyGhCodespacePorts(args.slice(index + 2))
  if (group === 'search' && subcommand && GH_SEARCH_READS.has(subcommand)) return null
  if (group === 'status' && !subcommand) return null
  if (group === 'repo' && subcommand === 'clone') {
    const cloneArgs = args.slice(subcommandIndex + 1)
    const operands: string[] = []
    let gitFlags: string[] = []
    for (let i = 0; i < cloneArgs.length; i++) {
      const arg = cloneArgs[i]!
      if (arg === '--') { gitFlags = cloneArgs.slice(i + 1); break }
      if (arg === '-u' || arg === '--upstream-remote-name') { i++; continue }
      if (arg === '--no-upstream' || arg.startsWith('--upstream-remote-name=')) continue
      if (arg.startsWith('-')) return 'the GitHub clone options cannot be verified'
      operands.push(arg)
    }
    if (operands.length < 1 || operands.length > 2) return 'the GitHub clone destination cannot be verified'
    return classifyGit(['clone', ...gitFlags, ...operands], input, {})
  }
  if (group === 'release' && subcommand === 'download') {
    const downloadArgs = args.slice(subcommandIndex + 1)
    let directory = '.'
    let output: string | undefined
    for (let i = 0; i < downloadArgs.length; i++) {
      const arg = downloadArgs[i]!
      if (arg === '--dir' || arg === '-D' || arg === '--output' || arg === '-O') {
        const value = downloadArgs[++i]
        if (!value) return 'the GitHub download destination cannot be verified'
        if (arg === '--dir' || arg === '-D') directory = value
        else output = value
      } else if (arg.startsWith('--dir=')) directory = arg.slice(arg.indexOf('=') + 1)
      else if (arg.startsWith('--output=')) output = arg.slice(arg.indexOf('=') + 1)
      else if (arg.startsWith('-D') && arg.length > 2) directory = arg.slice(2)
      else if (arg.startsWith('-O') && arg.length > 2) output = arg.slice(2)
      else if (arg === '--pattern' || arg === '-p') {
        const pattern = downloadArgs[++i]
        if (pattern && hasControlComponent(pattern)) return 'the download pattern could write managed metadata'
      }
    }
    if (output === '-') return null
    const directoryTarget = !output && downloadArgs.includes('--clobber') ? directory : joinPath(directory, 'downloaded-asset')
    for (const target of [directoryTarget, ...(output ? [output, joinPath(directory, output)] : [])]) {
      const effect = protectedPathEffect(target, input, false)
      if (effect) return effect
    }
    return null
  }
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
  let depth = 0
  let atDefinition = true
  let queries = 0
  for (let i = 0; i < query.length; i++) {
    const character = query[i]!
    if (character === '#') {
      while (i < query.length && query[i] !== '\n') i++
    } else if (character === '"') {
      const block = query.startsWith('"""', i)
      if (block) i += 2
      let closed = false
      while (++i < query.length) {
        if (query[i] === '\\') { i++; continue }
        if (block ? query.startsWith('"""', i) : query[i] === '"') {
          if (block) i += 2
          closed = true
          break
        }
      }
      if (!closed) return 'other'
    } else if (character === '{') {
      if (depth++ === 0 && atDefinition) queries++
      atDefinition = false
    } else if (character === '}') {
      if (--depth < 0) return 'other'
      if (depth === 0) atDefinition = true
    } else if (depth === 0 && atDefinition && /[_A-Za-z]/.test(character)) {
      const start = i
      while (/[_0-9A-Za-z]/.test(query[i + 1] ?? '')) i++
      const operation = query.slice(start, i + 1).toLowerCase()
      if (operation === 'mutation') return 'mutation'
      if (operation === 'query') queries++
      else if (operation !== 'fragment') return 'other'
      atDefinition = false
    }
  }
  return depth === 0 && queries > 0 ? 'query' : 'other'
}

function classifyGit(args: string[], input: PermissionGuardInput, environment: Record<string, string>, dynamic = false): string | null {
  let index = 0
  let directory = input.directory ?? input.context?.worktreePath
  let explicitGitDir: string | undefined
  let explicitWorkTree: string | undefined
  let explicitAbsoluteTarget = false
  let dynamicTarget = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']
    .some((name) => {
      const value = environment[name]
      return Boolean(value && (/[$`]/.test(value) || (!directory && !isAbsolutePath(value))))
    })
  const gitConfig = gitEnvironmentConfig(environment)
  const addGitConfig = (specification: string, value?: string) => {
    const separator = specification.indexOf('=')
    gitConfig.push({
      key: (separator < 0 ? specification : specification.slice(0, separator)).toLowerCase(),
      value: separator < 0 ? value : specification.slice(separator + 1),
    })
  }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) {
    explicitAbsoluteTarget ||= Boolean(environment[name] && isAbsolutePath(environment[name]!))
  }
  while (index < args.length) {
    const arg = args[index]!
    if (arg === '-C' || arg === '-c' || ['--namespace', '--exec-path', '--config-env'].includes(arg)) {
      const value = args[index + 1]
      if (!value) return 'the Git command target cannot be verified'
      if (arg === '-C') {
        dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
        explicitAbsoluteTarget ||= isAbsolutePath(value)
        directory = normalizePath(value, directory)?.path
      } else if (arg === '-c') {
        addGitConfig(value)
      } else if (arg === '--config-env') {
        const separator = value.indexOf('=')
        addGitConfig(separator < 0 ? value : value.slice(0, separator), separator < 0 ? undefined : environment[value.slice(separator + 1)])
      }
      index += 2
      continue
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      const value = arg.slice(2)
      dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
      explicitAbsoluteTarget ||= isAbsolutePath(value)
      directory = normalizePath(value, directory)?.path; index++; continue
    }
    if (arg.startsWith('-c') && arg.length > 2) { addGitConfig(arg.slice(2)); index++; continue }
    if (arg.startsWith('--namespace=') || arg.startsWith('--exec-path=')) { index++; continue }
    if (arg.startsWith('--config-env=')) {
      const value = arg.slice('--config-env='.length)
      const separator = value.indexOf('=')
      addGitConfig(separator < 0 ? value : value.slice(0, separator), separator < 0 ? undefined : environment[value.slice(separator + 1)])
      index++; continue
    }
    if (arg === '--git-dir' || arg === '--work-tree') {
      const value = args[index + 1]
      if (!value) return 'the Git command target cannot be verified'
      dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
      explicitAbsoluteTarget ||= isAbsolutePath(value)
      if (arg === '--git-dir') explicitGitDir = value
      else explicitWorkTree = value
      index += 2; continue
    }
    if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')) {
      const value = arg.slice(arg.indexOf('=') + 1)
      dynamicTarget ||= /[$`]/.test(value) || (!directory && !isAbsolutePath(value))
      explicitAbsoluteTarget ||= isAbsolutePath(value)
      if (arg.startsWith('--git-dir=')) explicitGitDir = value
      else explicitWorkTree = value
      index++; continue
    }
    if (arg.startsWith('-')) { index++; continue }
    break
  }

  const command = args[index]?.toLowerCase()
  const gitArgs = args.slice(index + 1)
  if (!command) return dynamic ? 'the Git command cannot be verified' : null
  if (/[$`]/.test(args[index]!)) return 'the Git subcommand cannot be verified'
  const action = ['remote', 'worktree', 'stash', 'notes', 'reflog', 'replace', 'lfs', 'subtree'].includes(command)
    ? gitSubcommand(command, gitArgs)
    : undefined
  if (action && /[$`]/.test(action)) return 'the Git subcommand cannot be verified'
  if (gitArgs.includes('--help') || gitArgs.includes('-h')) return null
  if (command === 'push' || command === 'send-pack'
    || ((command === 'lfs' || command === 'subtree') && action === 'push')) {
    return 'the Git command would write to a remote repository'
  }

  for (const setting of gitConfig) {
    if (dynamic && /[$`]/.test(setting.key)) return 'the Git configuration cannot be verified'
    if (setting.key === 'core.worktree') {
      if (setting.value) {
        dynamicTarget ||= /[$`]/.test(setting.value) || (!directory && !isAbsolutePath(setting.value))
        explicitAbsoluteTarget ||= isAbsolutePath(setting.value)
      } else {
        dynamicTarget = true
      }
    }
    if (gitConfigCanExecute(setting.key, command)) return 'the Git configuration may run an external command'
  }
  const configuredWorkTree = gitConfig.filter((setting) => setting.key === 'core.worktree').at(-1)?.value
  const creationWorkTree = configuredWorkTree ?? explicitWorkTree ?? environment.GIT_WORK_TREE

  if (command === 'init' || command === 'clone') {
    const creation = gitCreationPaths(command, gitArgs)
    if (!creation.verified || dynamicTarget || [creation.destination, creation.separateGitDir].some((target) => /[$`]/.test(target ?? ''))) {
      return 'the Git metadata target cannot be verified'
    }
    const creationInput = { ...input, directory }
    const defaultDestination = creation.destination ?? (command === 'init' ? creationWorkTree ?? directory : undefined)
    if ((command === 'init' && !defaultDestination)
      || [defaultDestination, creation.separateGitDir].some((target) => Boolean(target && !directory && !isAbsolutePath(target)))
      || (input.unverifiedDirectory && !explicitAbsoluteTarget && !(creation.destination && isAbsolutePath(creation.destination)))) {
      return 'the Git metadata target cannot be verified'
    }
    const assignedRoot = input.context?.worktreePath ?? input.protectedDirectory ?? input.directory
    const reinitializesAssignedRoot = defaultDestination && assignedRoot
      && normalizePath(defaultDestination, directory)?.path === normalizePath(assignedRoot)?.path
    const targets = [
      defaultDestination,
      defaultDestination && reinitializesAssignedRoot
        && !gitArgs.includes('--bare') && !gitArgs.includes('--mirror') ? joinPath(defaultDestination, '.git') : undefined,
      creation.separateGitDir,
      explicitGitDir ?? environment.GIT_DIR,
      creationWorkTree,
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
  const workTree = creationWorkTree
  const metadataTargets = [gitDir, commonDir, ...(gitDir || commonDir ? [] : [directory])]
  const workTreeTargets = [workTree ?? directory]
  const targetStates = [...metadataTargets, ...workTreeTargets]
    .filter((target): target is string => Boolean(target))
    .map((target) => isManagedGitTarget(target, commandInput))
  const isManaged = targetStates.includes(true)
  const targetUnknown = dynamicTarget || targetStates.length === 0 || targetStates.includes(undefined)
    || Boolean(input.unverifiedDirectory && !explicitAbsoluteTarget)
  const scopedBlock = (effect: string) => isManaged || targetUnknown ? effect : null

  if (command === 'reset' && gitArgs.some((arg) => ['--hard', '--merge', '--keep'].includes(arg))) {
    return scopedBlock(targetUnknown ? 'the destructive Git reset target cannot be verified' : 'the reset could discard local work in the managed ticket worktree')
  }
  if (command === 'clean' && !gitCleanDryRun(gitArgs)) {
    const paths: string[] = []
    let separator = false
    for (let i = 0; i < gitArgs.length; i++) {
      const arg = gitArgs[i]!
      if (arg === '--') { separator = true; continue }
      if (!separator && (arg === '-e' || arg === '--exclude')) { i++; continue }
      if (!separator && arg.startsWith('-')) continue
      paths.push(arg)
    }
    if (!paths.length) return scopedBlock(targetUnknown ? 'the Git clean target cannot be verified' : 'the Git clean could remove local files from the managed ticket worktree')
    for (const target of paths) {
      const effect = gitProtectedPathEffect(target, commandInput, workTree ?? directory, dynamic, scopedBlock)
      if (effect) return effect
    }
  }
  if (command === 'rebase' && !gitArgs.includes('--abort') && !gitArgs.includes('--show-current-patch')) {
    return scopedBlock(targetUnknown ? 'the Git rebase target cannot be verified' : 'the Git rebase could rewrite managed repository history')
  }
  if (command === 'apply' && !gitArgs.some((arg) => ['--check', '--stat', '--numstat', '--summary'].includes(arg))) {
    return scopedBlock('the Git patch mutation paths cannot be verified; use explicit file edits')
  }
  if (command === 'fetch' && gitArgs.some((arg) => ['-p', '--prune', '--prune-tags'].includes(arg))) {
    return scopedBlock('the command would prune managed Git metadata')
  }

  if (command === 'config' && gitConfigWrites(gitArgs)) {
    for (let i = 0; i < gitArgs.length; i++) {
      const arg = gitArgs[i]!
      const target = arg === '-f' || arg === '--file' ? gitArgs[++i] : arg.startsWith('--file=') ? arg.slice(7) : undefined
      if (target) {
        const effect = protectedPathEffect(target, commandInput, true)
        if (effect) return effect
      }
    }
  }

  const metadataChange = gitMetadataChange(command, gitArgs)
  if (metadataChange) {
    if (command === 'config' && gitConfigWrites(gitArgs) && gitArgs.some((arg) => arg === '--global' || arg === '--system')) {
      return 'the command would change global or system Git configuration'
    }
    return scopedBlock(targetUnknown ? 'the Git metadata target cannot be verified' : 'the command would change managed Git metadata')
  }

  if (command === 'rm' || command === 'mv') {
    const mutation = gitMutationPaths(command, gitArgs, commandInput, workTree ?? directory)
    if (mutation.dryRun) return null
    if (!mutation.verified) return scopedBlock('the Git pathspec cannot be verified')
    for (const targetPath of mutation.paths) {
      const effect = gitProtectedPathEffect(targetPath, commandInput, workTree ?? directory, dynamic, scopedBlock)
      if (effect) return effect
    }
  }

  if (['checkout', 'restore', 'reset'].includes(command)) {
    if (gitArgs.some((arg) => arg === '--pathspec-from-file' || arg.startsWith('--pathspec-from-file='))) {
      return scopedBlock('the Git pathspec cannot be verified')
    }
    const paths = gitRestorePaths(command, gitArgs)
    for (const targetPath of paths) {
      const effect = gitProtectedPathEffect(targetPath, commandInput, workTree ?? directory, dynamic, scopedBlock)
      if (effect) return effect
    }
  }

  return null
}

function gitMetadataChange(command: string, args: string[]): boolean {
  const action = gitSubcommand(command, args)
  if (['update-ref', 'symbolic-ref', 'gc', 'repack', 'prune', 'switch'].includes(command)) return true
  if (command === 'reset') {
    const separator = args.indexOf('--')
    return separator < 0 || args.slice(separator + 1).length === 0
      || args.some((arg) => ['--hard', '--mixed', '--soft', '--merge', '--keep'].includes(arg))
  }
  if (command === 'checkout') {
    if (args.includes('--')) return args.some((arg) => ['-b', '-B', '--branch', '--orphan', '--detach'].includes(arg))
    return args.some((arg) => ['-b', '-B', '--branch', '--orphan', '--detach', '-f', '--force'].includes(arg))
      || args.some((arg) => !arg.startsWith('-') && arg !== '.')
  }
  if (command === 'remote') return ['add', 'rename', 'remove', 'rm', 'set-url', 'set-branches', 'set-head', 'prune', 'update'].includes(action ?? '')
  if (command === 'worktree') return ['add', 'lock', 'move', 'prune', 'remove', 'repair', 'unlock'].includes(action ?? '')
  if (command === 'branch') {
    if (args.some((arg) => ['-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy', '-f', '--force', '--set-upstream-to', '--unset-upstream', '--edit-description'].includes(arg))) return true
    return !args.some((arg) => [
      '-l', '--list', '-a', '--all', '-r', '--remotes', '-v', '--verbose', '--show-current',
      '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--sort', '--format',
    ].includes(arg) || arg.startsWith('--sort=') || arg.startsWith('--format='))
      && args.some((arg) => !arg.startsWith('-'))
  }
  if (command === 'tag') {
    if (args.some((arg) => ['-d', '--delete', '-f', '--force', '-a', '--annotate', '-s', '--sign', '-u', '--local-user'].includes(arg))) return true
    return !args.some((arg) => [
      '-l', '--list', '-n', '--contains', '--no-contains', '--points-at', '--sort', '--format', '--verify',
    ].includes(arg) || arg.startsWith('--sort=') || arg.startsWith('--format='))
      && args.some((arg) => !arg.startsWith('-'))
  }
  if (command === 'stash') return !['list', 'show'].includes(action ?? '')
  if (command === 'replace') return !args.includes('--list') && args.some((arg) => !arg.startsWith('-'))
  if (command === 'notes') return ['add', 'append', 'copy', 'edit', 'merge', 'prune', 'remove'].includes(action ?? '')
  if (command === 'reflog') return ['delete', 'expire', 'write'].includes(action ?? '')
  return command === 'config' && gitConfigWrites(args)
}

function gitSubcommand(command: string, args: string[]): string | undefined {
  const optionsWithValues: Record<string, readonly string[]> = {
    lfs: ['--repo'],
    notes: ['--ref'],
    reflog: ['--date'],
    subtree: ['--annotate', '--prefix'],
  }
  const withValues = optionsWithValues[command] ?? []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('-')) {
      if (withValues.some((option) => arg.startsWith(option + '='))) continue
      if (withValues.includes(arg)) i++
      continue
    }
    return arg.toLowerCase()
  }
  return undefined
}

function gitConfigWrites(args: string[]): boolean {
  if (args.some((arg) => ['--replace-all', '--add', '--unset', '--unset-all', '--rename-section', '--remove-section', '--edit', '-e'].includes(arg))) return true
  if (args.some((arg) => [
    '--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool',
    '--list', '-l', '--help', '-h',
  ].includes(arg))) return false
  const operands: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (['-f', '--file', '--blob', '--type', '--default'].includes(arg)) { i++; continue }
    if (!arg.startsWith('-')) operands.push(arg)
  }
  if (['get', 'list'].includes(operands[0] ?? '')) return false
  if (['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(operands[0] ?? '')) return true
  return operands.length > 1
}

function gitConfigCanExecute(key: string, command: string): boolean {
  if (key.startsWith('alias.')) return key.slice('alias.'.length) === command
  if ([
    'core.askpass', 'core.editor', 'core.fsmonitor', 'core.gitproxy', 'core.hookspath',
    'core.pager', 'core.sshcommand', 'credential.helper', 'diff.external',
    'interactive.difffilter', 'sequence.editor',
  ].includes(key) || key.startsWith('pager.')) return true
  return (key.startsWith('filter.') && ['.clean', '.process', '.smudge'].some((suffix) => key.endsWith(suffix)))
    || (key.startsWith('merge.') && key.endsWith('.driver'))
    || (key.startsWith('mergetool.') && key.endsWith('.cmd'))
}

function gitEnvironmentConfig(environment: Record<string, string>): Array<{ key: string; value?: string }> {
  const config: Array<{ key: string; value?: string }> = []
  const count = Number(environment.GIT_CONFIG_COUNT)
  if (!Number.isSafeInteger(count) || count <= 0) return config
  for (const name of Object.keys(environment)) {
    const prefix = 'GIT_CONFIG_KEY_'
    if (!name.startsWith(prefix)) continue
    const index = Number(name.slice(prefix.length))
    if (!Number.isSafeInteger(index) || index < 0 || index >= count) continue
    const key = environment[name]
    if (key) config.push({ key: key.toLowerCase(), value: environment['GIT_CONFIG_VALUE_' + index] })
  }
  return config
}

function gitHasShortOption(args: string[], option: string): boolean {
  for (const arg of args) {
    if (arg.length < 2 || arg[0] !== '-' || arg[1] === '-') continue
    for (let i = 1; i < arg.length; i++) if (arg[i]!.toLowerCase() === option) return true
  }
  return false
}

function gitCleanDryRun(args: string[]): boolean {
  return args.includes('--dry-run') || gitHasShortOption(args, 'n')
}

function gitMutationPaths(
  command: string,
  args: string[],
  input: PermissionGuardInput,
  workTree: string | undefined,
): { paths: string[]; verified: boolean; dryRun: boolean } {
  const operands: string[] = []
  let afterSeparator = false
  let verified = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { afterSeparator = true; continue }
    if (!afterSeparator && (arg === '--pathspec-from-file' || arg.startsWith('--pathspec-from-file='))) {
      verified = false
      if (arg === '--pathspec-from-file') i++
      continue
    }
    if (!afterSeparator && arg.startsWith('-')) continue
    operands.push(arg)
  }
  const dryRun = args.includes('--dry-run') || gitHasShortOption(args, 'n')
  if (command === 'rm') return { paths: operands, verified: verified && operands.length > 0, dryRun }
  if (operands.length < 2) return { paths: operands, verified: false, dryRun }
  const sources = operands.slice(0, -1)
  const destination = operands.at(-1)!
  const directoryDestination = destination === '.' || destination === '..' || destination.endsWith('/') || destination.endsWith('\\')
  if (!directoryDestination) return { paths: operands, verified, dryRun }
  const paths = [...sources]
  for (const source of sources) {
    const sourcePath = gitPathspecTarget(source, input, workTree)?.path ?? source
    const basename = sourcePath.split(/[\\/]/).at(-1)
    if (basename) paths.push(joinPath(destination, basename))
  }
  return { paths, verified, dryRun }
}

function gitProtectedPathEffect(
  rawPath: string,
  input: PermissionGuardInput,
  workTree: string | undefined,
  dynamic: boolean,
  scopedBlock: (effect: string) => string | null,
): string | null {
  const target = gitPathspecTarget(rawPath, input, workTree)
  if (!target) return null
  if (dynamic && hasShellExpansion(target.path)) return scopedBlock('the Git path target cannot be verified')
  return protectedPathEffect(target.path, target.input, true)
}

function gitPathspecTarget(
  rawPath: string,
  input: PermissionGuardInput,
  workTree: string | undefined,
): { path: string; input: PermissionGuardInput } | undefined {
  let value = rawPath
  let top = false
  let icase = false
  if (value === ':/') return { path: '.', input: { ...input, directory: workTree ?? input.directory } }
  if (value.startsWith(':!') || value.startsWith(':^')) return undefined
  if (value.startsWith(':/')) {
    top = true
    value = value.slice(2)
  } else if (value.startsWith(':(')) {
    const closing = value.indexOf(')')
    if (closing < 0) return { path: value, input }
    const magic = value.slice(2, closing).toLowerCase().split(',')
    if (magic.includes('exclude') || magic.includes('!')) return undefined
    top = magic.includes('top')
    icase = magic.includes('icase')
    value = value.slice(closing + 1)
  }
  if (top && (value.startsWith('/') || value.startsWith('\\'))) value = value.slice(1)
  if (icase) {
    value = value.split(/[\\/]/).map((part) => {
      const lower = part.toLowerCase()
      return ['.git', '.looptroop', '.ticket'].includes(lower) ? lower : part
    }).join('/')
  }
  return {
    path: value || (top ? '.' : rawPath),
    input: top ? { ...input, directory: workTree ?? input.context?.worktreePath ?? input.directory } : input,
  }
}

function hasShellExpansion(value: string): boolean {
  for (const character of value) if (character === '$' || character.charCodeAt(0) === 96) return true
  return false
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
    if (arg.length > 2 && ['b', 'o', 'u', 'j', 'c'].includes(arg[1]!)) continue
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
  if (!source) return undefined
  let end = source.length
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '?' || source[i] === '#') { end = i; break }
  }
  while (end > 0 && (source[end - 1] === '/' || source[end - 1] === '\\')) end--
  const repository = source.slice(0, end)
  const name = repository.split(/[\\/:]/).at(-1)
  if (!name) return undefined
  return name.toLowerCase().endsWith('.git') ? name.slice(0, -4) || undefined : name
}

function gitRestorePaths(command: string, args: string[]): string[] {
  const separator = args.indexOf('--')
  if (command === 'checkout') {
    if (separator >= 0) return args.slice(separator + 1)
    const paths: string[] = []
    const optionsWithValues = new Set(['-b', '-B', '--branch', '--orphan', '--conflict'])
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!
      if (optionsWithValues.has(arg)) { i++; continue }
      if (arg.startsWith('-')) continue
      paths.push(arg)
    }
    return paths
  }
  if (command === 'reset') return separator < 0 ? [] : args.slice(separator + 1)
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

function classifyFind(args: string[], input: PermissionGuardInput, depth: number): string | null {
  const paths: string[] = []
  let index = 0
  while (['-H', '-L', '-P'].includes(args[index] ?? '')) index++
  while (index < args.length && !args[index]!.startsWith('-') && args[index] !== '(' && args[index] !== '!') paths.push(args[index++]!)
  if (!paths.length) paths.push('.')
  if (args.includes('-delete')) {
    const effect = classifyRemoval(paths, true, input)
    if (effect) return effect
  }
  for (; index < args.length; index++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[index]!)) continue
    const inner: string[] = []
    while (++index < args.length && ![';', '+'].includes(args[index]!)) inner.push(args[index]!)
    for (const target of paths) {
      const effect = classifyShell(inner.map((word) => word.replaceAll('{}', target)).join(' '), input, depth + 1)
      if (effect) return effect
    }
  }
  return null
}

function classifyContentWrite(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  const targets: string[] = []
  let positionalTarget: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const key = arg.toLowerCase().split(/[:=]/)[0]!
    if (['-path', '-literalpath', '-filepath'].includes(key)) {
      const separator = arg.search(/[:=]/)
      const target = separator >= 0 ? arg.slice(separator + 1) : args[++i]
      if (target) targets.push(target)
    } else if (['-value', '-inputobject', '-encoding', '-width', '-filter', '-include', '-exclude'].includes(key)) i++
    else if (!arg.startsWith('-') && !positionalTarget) positionalTarget = arg
  }
  if (!targets.length && positionalTarget) targets.push(positionalTarget)
  if (!targets.length) return 'the file mutation target cannot be verified'
  for (const target of targets) {
    if (dynamic && /[$`]/.test(target)) return 'the file mutation target cannot be verified'
    const effect = protectedPathEffect(target, input, true)
    if (effect) return effect
  }
  return null
}

function classifyRemoval(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  if (args.some((arg) => arg === '--help' || arg === '-h' || arg === '--version')) return null
  const targets: string[] = []
  const optionsWithValues = new Set(['-path', '-literalpath', '-include', '-exclude', '-filter', '-stream'])
  let afterSeparator = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') { afterSeparator = true; continue }
    if (!afterSeparator && optionsWithValues.has(arg.toLowerCase())) {
      const value = args[++i]
      if (value && ['-path', '-literalpath'].includes(arg.toLowerCase())) targets.push(value)
      continue
    }
    if (!afterSeparator && /^\/(?:s|q|f|recurse|force)$/i.test(arg)) continue
    if (!afterSeparator && arg.startsWith('-')) continue
    targets.push(arg)
  }
  if (!targets.length) return 'the destructive command target cannot be verified'
  for (const target of targets) {
    if (dynamic && /[$`]/.test(target)) return 'the destructive command target cannot be verified'
    for (const path of target.split(',')) {
      const effect = protectedPathEffect(path, input, true)
      if (effect) return effect
    }
  }
  return null
}

function isRemovalCommand(command: string): boolean {
  return ['rm', 'rmdir', 'rd', 'unlink', 'remove-item', 'ri', 'del', 'erase', 'wipe', 'shred'].includes(commandBase(command))
}

function isFileMutationCommand(command: string): boolean {
  return ['cp', 'copy', 'copy-item', 'cpi', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni', 'tee', 'tee-object', 'truncate', 'touch', 'chmod', 'chown'].includes(commandBase(command))
}

function classifyFileMutation(commandName: string, args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  const command = basename(commandName).toLowerCase().replace(/\.exe$/, '')
  const copy = ['cp', 'copy', 'copy-item', 'cpi'].includes(command)
  const move = ['mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni'].includes(command)
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
      targets.push(...copySources.map((source) => joinPath(destination, basename(source))))
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
  if (input.unverifiedDirectory && !isAbsolutePath(rawPath)) return 'the command working directory cannot be verified for this local mutation'
  const resolved = normalizePath(rawPath, input.directory ?? input.context?.worktreePath)
  if (!resolved) return 'the local mutation path cannot be verified'
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
    if (ticketState) return 'the target would change or remove managed ticket state'
    if (projectState) return 'the target would change or remove managed LoopTroop state'
    if (/[\\/]\.git$/i.test(root)) return 'the target would change managed Git metadata'
    return 'the target would change or remove managed LoopTroop state or Git metadata'
  }

  if (context) {
    const worktree = normalizePath(context.worktreePath)
    const candidateRelative = worktree && pathContains(worktree, prefix) ? relativePath(worktree, prefix) : undefined
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
  if (value === '~' || value.startsWith('~/') || value.startsWith('~\\')) value = homedir() + value.slice(1)
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
  let normalized = implementation.normalize(implementation.resolve(base ?? (windows ? 'C:\\' : '/'), value))
  if (windows === (process.platform === 'win32')) {
    let existing = normalized
    const remainder: string[] = []
    while (true) {
      try {
        normalized = implementation.join(realpathSync(existing), ...remainder)
        break
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || !['ENOENT', 'ENOTDIR'].includes(String(error.code))) return undefined
        const parent = implementation.dirname(existing)
        if (parent === existing) break
        remainder.unshift(implementation.basename(existing))
        existing = parent
      }
    }
  }
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
  const insensitive = parent.windows || process.platform === 'darwin'
  const relative = implementation.relative(insensitive ? parent.path.toLowerCase() : parent.path, insensitive ? child.path.toLowerCase() : child.path)
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
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

function commandBase(value: string): string {
  const name = basename(value).toLowerCase()
  return name.endsWith('.exe') ? name.slice(0, -4) : name
}

function equalsPath(left: string, right: string, windows: boolean): boolean {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right
}
