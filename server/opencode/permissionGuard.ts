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
  const escapedVariant = command.replace(/\\([A-Za-z0-9])/g, '$1').replace(/\\\r?\n/g, '')
  if (escapedVariant !== command) {
    const effect = classifyShell(escapedVariant, input, depth)
    if (effect) return effect
  }
  const segments = scanShell(command)
  if (!segments.length) return 'the requested command cannot be verified'
  let directory = input.directory ?? input.context?.worktreePath
  let directoryUnverified = Boolean(input.unverifiedDirectory)
  const directoryStack: Array<{ directory?: string; unverified: boolean }> = []
  const exportedEnvironment: Record<string, string> = { ...input.environment }

  for (const segment of segments) {
    const currentInput = { ...input, directory, unverifiedDirectory: directoryUnverified }
    for (const target of segment.redirects) {
      if (hasShellExpansion(target)) return 'the redirected file target cannot be verified'
      const effect = protectedPathEffect(target, currentInput, false)
      if (effect) return effect
    }

    if (segment.substitution) return 'inline command substitution cannot be verified; use separate literal commands'
    const unwrapped = unwrapCommand(segment.words)
    if (unwrapped.error) return unwrapped.error
    const { commandName, args } = unwrapped
    const environment = { ...exportedEnvironment, ...unwrapped.environment }
    for (const nextDirectory of unwrapped.directories) {
      const wasUnverified = currentInput.unverifiedDirectory
      currentInput.directory = normalizePath(nextDirectory, currentInput.directory ?? input.context?.worktreePath)?.path
      currentInput.unverifiedDirectory = !currentInput.directory
        || hasShellExpansion(nextDirectory)
        || (wasUnverified && !isAbsolutePath(nextDirectory))
    }
    for (const target of unwrapped.mutationPaths) {
      if (segment.dynamic && hasShellExpansion(target)) return 'the command output path cannot be verified'
      const effect = protectedPathEffect(target, currentInput, true)
      if (effect) return effect
    }
    currentInput.environment = environment
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
    if (['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd', 'eval', 'iex', 'invoke-expression'].includes(basename)) {
      const isPowerShell = basename === 'pwsh' || basename === 'powershell'
      if (isPowerShell && args.some((arg) => {
        const option = arg.toLowerCase().slice(1)
        return arg.startsWith('-') && (option === 'e' || option === 'ec' || 'encodedcommand'.startsWith(option))
      })) return 'the encoded shell command cannot be verified; use a literal command'
      const flag = args.findIndex((arg) => isPowerShell
        ? arg.startsWith('-') && ('command'.startsWith(arg.slice(1).toLowerCase()) || /^-(?:cw|cwa|commandw[a-z]*)$/i.test(arg))
        : basename === 'cmd' ? /^\/[ck]$/i.test(arg) : /^-[a-z]*c/i.test(arg))
      const commandWithArgs = isPowerShell && flag >= 0 && /^-(?:cw|cwa|commandw[a-z]*)$/i.test(args[flag]!)
      const inline = ['eval', 'iex', 'invoke-expression'].includes(basename) ? args.join(' ')
        : flag < 0 ? undefined : args[flag + 1]
      if (flag >= 0 && inline === undefined) return 'the inline shell command cannot be verified'
      if (inline === undefined && (segment.piped || segment.inputRedirect)) return 'the shell input cannot be verified; use a literal command'
      if (inline !== undefined) {
        const script = isPowerShell
          ? commandWithArgs ? inline : args.slice(flag + 1).join(' ')
          : basename === 'cmd' ? args.slice(flag + 1).join(' ') : inline
        if (basename === 'cmd' && script.includes('^')) return 'the cmd escape sequence cannot be verified; use a literal command'
        const effect = classifyShell(script, currentInput, depth + 1)
        if (effect) return effect
      }
      continue
    }
    if (['cd', 'chdir', 'set-location', 'sl', 'pushd', 'push-location'].includes(basename)) {
      const next = args.find((arg) => !arg.startsWith('-'))
      if (['pushd', 'push-location'].includes(basename)) directoryStack.push({ directory, unverified: directoryUnverified })
      if (next) {
        directory = normalizePath(next, directory ?? input.context?.worktreePath)?.path
        directoryUnverified = !directory || hasShellExpansion(next) || (directoryUnverified && !isAbsolutePath(next))
      } else {
        directory = undefined
        directoryUnverified = true
      }
      continue
    }
    if (basename === 'popd' || basename === 'pop-location') {
      const previous = directoryStack.pop()
      if (previous) {
        directory = previous.directory
        directoryUnverified = previous.unverified
      }
      continue
    }

    if (unwrapped.dynamicArguments
      && (isRemovalCommand(commandName) || isFileMutationCommand(commandName)
        || ['dd', 'sed', 'tar', 'rsync', 'unzip', '7z', '7za', '7zz', 'cpio'].includes(basename))) {
      return 'the command target cannot be verified because its arguments come from input'
    }

    if (isExecutable(commandName, 'gh')) {
      const effect = classifyGh(args, segment, currentInput)
      if (effect) return effect
    } else if (isExecutable(commandName, 'git')) {
      const effect = classifyGit(args, currentInput, environment, segment.dynamic || unwrapped.dynamicArguments)
      if (effect) return effect
    } else if (basename === 'start-process') {
      const effect = classifyStartProcess(args, segment.dynamic, currentInput, depth)
      if (effect) return effect
    } else if (basename === 'find') {
      const effect = classifyFind(args, currentInput, depth, segment.dynamic)
      if (effect) return effect
    } else if (basename === 'tar') {
      const effect = classifyTar(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (basename === 'unzip') {
      const effect = classifyUnzip(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (['7z', '7za', '7zz'].includes(basename)) {
      const effect = classify7z(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (basename === 'cpio') {
      const effect = classifyCpio(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (basename === 'sed') {
      const effect = classifySed(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (basename === 'rsync') {
      const effect = classifyRsync(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (['set-content', 'add-content', 'clear-content', 'out-file'].includes(basename)) {
      const effect = classifyContentWrite(args, segment.dynamic, currentInput)
      if (effect) return effect
    } else if (basename === 'dd') {
      const target = args.find((arg) => arg.startsWith('of='))?.slice(3)
      if (target) {
        if (segment.dynamic && hasShellExpansion(target)) return 'the output file target cannot be verified'
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
    watch: ['-n', '--interval'],
    strace: ['-e', '--trace', '-o', '--output', '-s', '--string-limit', '-p', '--attach', '-u', '--user', '-I', '--interruptible', '-P', '--trace-path'],
    script: ['-c', '--command', '-t', '--timing', '--log-timing', '-O', '--output-limit'],
    ionice: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-u', '--uid', '-g', '--pgid'],
    chrt: ['-p', '--pid', '-P', '--priority', '--sched', '--sched-attr'],
    flock: ['-w', '--wait', '-E', '--conflict-exit-code', '-c', '--command'],
  }
  const flagOptions: Record<string, string[]> = {
    env: ['-i', '--ignore-environment'], sudo: ['-n', '-E', '-H', '-k', '-K', '-b', '-S'],
    doas: ['-n', '-s'], command: ['-p', '-v', '-V'], exec: ['-c', '-l'],
    nohup: [], nice: [], time: ['-p', '-v', '--verbose', '-a', '--append'],
    timeout: ['--foreground', '--preserve-status', '-v', '--verbose'], stdbuf: [],
    xargs: ['-0', '--null', '-r', '--no-run-if-empty', '-p', '-t', '-x', '--exit'],
    npx: ['-y', '--yes', '--no', '--no-install', '--quiet'],
    setsid: ['-f', '--fork', '-w', '--wait', '-c', '--ctty'],
    unbuffer: ['-p'],
    watch: ['-t', '--no-title', '-d', '--differences', '-g', '--chgexit', '-b', '--beep', '-c', '--color', '-x', '--exec', '-p', '--precise'],
    strace: ['-f', '-ff', '-c', '-C', '-q', '-qq', '-qqq', '-v', '-x', '-xx', '-r', '-t', '-tt', '-ttt', '-T', '-y', '-yy', '-k', '--follow-forks', '--summary-only', '--quiet', '--verbose', '--relative-timestamps', '--decode-fds'],
    script: ['-q', '--quiet', '-e', '--return', '-f', '--flush', '-a', '--append'],
    ionice: ['-t', '--ignore', '--help', '--version'],
    chrt: ['--other', '-o', '--idle', '--batch', '--deadline', '--fifo', '-f', '--rr', '-r', '--reset-on-fork', '-R', '-a', '--all-tasks', '-m', '--max'],
    flock: ['-s', '--shared', '-x', '--exclusive', '-u', '--unlock', '-n', '--nonblock', '-o', '--close', '-F', '--no-fork', '--verbose'],
  }
  while (index < words.length) {
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) {
      const assignment = words[index++]!
      const separator = assignment.indexOf('=')
      environment[assignment.slice(0, separator)] = assignment.slice(separator + 1)
    }
    const name = commandBase(words[index] ?? '')
    if (['su', 'runuser', 'gosu', 'chroot', 'nsenter'].includes(name)) {
      return result('the command can change execution identity or root and cannot be verified')
    }
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
        if (name === 'script' && ['-c', '--command'].includes(key)) return { ...result(), commandName: 'sh', args: ['-c', value] }
        if (name === 'flock' && ['-c', '--command'].includes(key)) return { ...result(), commandName: 'sh', args: ['-c', value] }
      } else if (!flagOptions[name]?.includes(key) && !(name === 'nice' && /^-\d+$/.test(option))) {
        return result('the command wrapper options cannot be verified')
      }
      index++
    }
    if (words[index] === '--') index++
    if (name === 'timeout') index++
    if (name === 'flock' && words[index]) index++
    if (name === 'chrt' && words[index]) index++
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
    if (arg === '--exec-path' || arg.startsWith('--exec-path=')) {
      return 'a custom Git executable path cannot be verified'
    }
    if (arg === '-C' || arg === '-c' || ['--namespace', '--config-env', '--attr-source', '--super-prefix'].includes(arg)) {
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
    if (arg.startsWith('--namespace=')) { index++; continue }
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
  const action = ['remote', 'worktree', 'stash', 'notes', 'reflog', 'replace', 'lfs', 'subtree', 'submodule', 'svn', 'bundle'].includes(command)
    ? gitSubcommand(command, gitArgs)
    : undefined
  if (action && /[$`]/.test(action)) return 'the Git subcommand cannot be verified'
  if (gitArgs.length === 1 && (gitArgs[0] === '--help' || gitArgs[0] === '-h')) return null
  if ((command === 'push' || command === 'send-pack')
    && !gitArgs.some((arg) => arg === '--dry-run' || arg === '-n')) {
    const target = gitPushRemoteTarget(gitArgs)
    if (!target || !isLocalGitPushTarget(target)) return 'the Git command would write to a remote repository'
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
  if (['GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS']
    .some((name) => Boolean(environment[name]))) {
    return 'the Git command may load unverified configuration'
  }
  if (['clone', 'fetch', 'ls-remote', 'pull', 'push', 'send-pack', 'submodule']
    .includes(command) && ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_ASKPASS', 'SSH_ASKPASS']
      .some((name) => Boolean(environment[name]))) {
    return 'the Git environment may run an external command'
  }
  if (['commit', 'tag', 'merge', 'rebase', 'cherry-pick', 'revert']
    .includes(command) && ['GIT_EDITOR', 'GIT_SEQUENCE_EDITOR']
      .some((name) => Boolean(environment[name]))
    && !(command === 'commit' && (gitArgs.includes('-m') || gitArgs.includes('-F') || gitArgs.includes('--message')))) {
    return 'the Git environment may run an external command'
  }
  const configuredWorkTree = gitConfig.filter((setting) => setting.key === 'core.worktree').at(-1)?.value
  const creationWorkTree = configuredWorkTree ?? explicitWorkTree ?? environment.GIT_WORK_TREE

  if (command === 'init' || command === 'clone') {
    const creation = gitCreationPaths(command, gitArgs)
    if (!creation.verified || dynamicTarget || [creation.destination, creation.separateGitDir].some((target) => /[$`]/.test(target ?? ''))) {
      return 'the Git metadata target cannot be verified'
    }
    if (creation.unsafeOptions || creation.configurations.some((setting) => {
      const separator = setting.indexOf('=')
      const key = separator < 0 ? setting : setting.slice(0, separator)
      return gitConfigCanExecute(key.toLowerCase(), command)
    })) return 'the Git creation options may run an external command'
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

  if ((command === 'add' || command === 'commit') && isManaged) {
    const ticketWorktree = input.context ? normalizePath(input.context.worktreePath) : undefined
    const effectiveWorkTreePath = workTree ?? directory
    const effectiveWorkTree = effectiveWorkTreePath ? normalizePath(effectiveWorkTreePath) : undefined
    if (targetUnknown || explicitGitDir || environment.GIT_DIR || commonDir
      || !ticketWorktree || !effectiveWorkTree || !pathContains(ticketWorktree, effectiveWorkTree)) {
      return 'the Git command would change the original project checkout or an unverified Git index'
    }
  }

  if (['clone', 'fetch', 'ls-remote'].includes(command)
    && gitArgs.some((arg) => arg === '-u' || arg === '--upload-pack' || arg.startsWith('--upload-pack='))) {
    return scopedBlock('the Git command may run an external upload-pack program')
  }
  if (command === 'archive' && gitArgs.some((arg) => arg === '--exec' || arg.startsWith('--exec='))) {
    return scopedBlock('the Git command may run an external archive program')
  }
  if (['clone', 'fetch', 'ls-remote', 'pull', 'push', 'send-pack'].includes(command)
    && gitArgs.some((arg) => arg.toLowerCase().startsWith('ext::'))) {
    return scopedBlock('the Git command may run an external transport program')
  }

  const output = gitOutputPaths(command, gitArgs)
  if (!output.verified) return scopedBlock('the Git output path cannot be verified')
  for (const target of output.paths) {
    if (dynamic && hasShellExpansion(target)) return 'the Git output path cannot be verified'
    const effect = protectedPathEffect(target, commandInput, true)
    if (effect) return effect
  }

  if (command === 'push' || command === 'send-pack'
    || ((command === 'lfs' || command === 'subtree') && action === 'push')) {
    if ((command === 'push' || command === 'send-pack') && gitArgs.some((arg) => arg === '--dry-run' || arg === '-n')) return null
    const target = command === 'push' || command === 'send-pack' ? gitPushRemoteTarget(gitArgs) : undefined
    if (target && isLocalGitPushTarget(target)) {
      if (dynamic && /[$`]/.test(target)) return 'the local Git push target cannot be verified'
      const state = isManagedGitTarget(target, commandInput)
      if (state === false) return null
      return state === true
        ? 'the local Git push would change managed Git state'
        : 'the local Git push target cannot be verified'
    }
    return 'the Git command would write to a remote repository'
  }

  if (command === 'reset' && gitArgs.some((arg) => ['--hard', '--merge', '--keep'].includes(arg))) {
    return scopedBlock(targetUnknown ? 'the destructive Git reset target cannot be verified' : 'the reset could discard local work in the managed ticket worktree')
  }
  if (command === 'clean' && !gitCleanDryRun(gitArgs)) {
    const clean = parseGitCleanArguments(gitArgs)
    if (!clean.verified) return scopedBlock('the Git clean target cannot be verified')
    const checkedPaths = clean.paths.filter((target) => gitPathspecTarget(target, commandInput, workTree ?? directory))
    if (!checkedPaths.length) return scopedBlock(targetUnknown ? 'the Git clean target cannot be verified' : 'the Git clean could remove local files from the managed ticket worktree')
    for (const target of checkedPaths) {
      const effect = gitProtectedPathEffect(target, commandInput, workTree ?? directory, dynamic, scopedBlock)
      if (effect) return effect
    }
  }
  if (command === 'rebase' && !gitArgs.includes('--abort') && !gitArgs.includes('--show-current-patch')) {
    return scopedBlock(targetUnknown ? 'the Git rebase target cannot be verified' : 'the Git rebase could rewrite managed repository history')
  }
  if (['merge', 'pull', 'cherry-pick', 'revert', 'am', 'checkout-index', 'read-tree', 'filter-branch', 'fast-import'].includes(command)) {
    return scopedBlock(targetUnknown ? 'the Git worktree target cannot be verified' : 'the command could overwrite managed Git state')
  }
  if (command === 'apply' && !gitArgs.some((arg) => ['--check', '--stat', '--numstat', '--summary'].includes(arg))) {
    return scopedBlock('the Git patch mutation paths cannot be verified; use explicit file edits')
  }
  if (command === 'fetch' && gitArgs.some((arg) => ['-p', '--prune', '--prune-tags'].includes(arg))) {
    return scopedBlock('the command would prune managed Git metadata')
  }
  if (command === 'svn' && ['commit-diff', 'dcommit', 'set-tree'].includes(action ?? '')) {
    return 'the Git command would write to a remote repository'
  }
  if ((command === 'submodule' && ['add', 'absorbgitdirs', 'deinit', 'foreach', 'init', 'sync', 'update'].includes(action ?? ''))
    || (command === 'lfs' && ['install', 'migrate', 'uninstall'].includes(action ?? ''))
    || (command === 'subtree' && ['add', 'merge', 'pull', 'split'].includes(action ?? ''))) {
    return scopedBlock('the command could rewrite managed Git metadata or files')
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
  if (command === 'stash') return !['list', 'show', 'apply', 'pop'].includes(action ?? '')
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

function gitPushRemoteTarget(args: string[]): string | undefined {
  const optionsWithValues = new Set(['-o', '--exec', '--push-option', '--receive-pack'])
  const flags = new Set([
    '-n', '-f', '-u', '--all', '--atomic', '--delete', '--dry-run', '--follow-tags', '--force',
    '--force-with-lease', '--ipv4', '--ipv6', '--mirror', '--no-verify', '--porcelain', '--progress',
    '--prune', '--quiet', '--recurse-submodules', '--repo', '--set-upstream', '--signed', '--tags', '--thin', '--verbose',
  ])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') return args[i + 1]
    if (optionsWithValues.has(arg)) { i++; continue }
    if (arg === '--repo') return args[i + 1]
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length)
    if (arg.startsWith('-')) {
      const option = arg.split('=', 1)[0]!
      if (flags.has(option) || arg.includes('=')) continue
      return undefined
    }
    return arg
  }
  return undefined
}

function isLocalGitPushTarget(target: string): boolean {
  return isAbsolutePath(target) || target.startsWith('./') || target.startsWith('../')
    || target.startsWith('.\\') || target.startsWith('..\\')
    || target === '~' || target.startsWith('~/') || target.startsWith('~\\')
    || /^file:\/\//i.test(target)
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
    'interactive.difffilter', 'sequence.editor', 'protocol.ext.allow',
  ].includes(key) || key.startsWith('pager.')) return true
  return (key.startsWith('filter.') && ['.clean', '.process', '.smudge'].some((suffix) => key.endsWith(suffix)))
    || (key.startsWith('diff.') && (key.endsWith('.command') || key.endsWith('.textconv')))
    || (key.startsWith('difftool.') && key.endsWith('.cmd'))
    || (key.startsWith('merge.') && key.endsWith('.driver'))
    || (key.startsWith('mergetool.') && key.endsWith('.cmd'))
    || key === 'include.path' || (key.startsWith('includeif.') && key.endsWith('.path'))
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
  return parseGitCleanArguments(args).dryRun
}

function parseGitCleanArguments(args: string[]): { paths: string[]; dryRun: boolean; verified: boolean } {
  const paths: string[] = []
  let dryRun = false
  let verified = true
  let afterSeparator = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (afterSeparator) {
      paths.push(arg)
    } else if (arg === '--') {
      afterSeparator = true
    } else if (arg === '--dry-run' || arg === '-n') {
      dryRun = true
    } else if (arg === '--exclude' || arg === '-e') {
      if (args[i + 1] === undefined) verified = false
      else i++
    } else if (arg.startsWith('--exclude=')) {
      continue
    } else if (arg.startsWith('--')) {
      verified = false
    } else if (arg.startsWith('-')) {
      const options = arg.slice(1)
      for (let option = 0; option < options.length; option++) {
        const flag = options[option]!.toLowerCase()
        if (flag === 'n') dryRun = true
        else if (flag === 'e') {
          if (option + 1 < options.length) break
          if (args[i + 1] === undefined) verified = false
          else i++
          break
        } else if (!'fdxq'.includes(flag)) verified = false
      }
    } else {
      paths.push(arg)
    }
  }
  return { paths, dryRun, verified }
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

function gitCreationPaths(command: string, args: string[]): { destination?: string; separateGitDir?: string; configurations: string[]; unsafeOptions: boolean; verified: boolean } {
  const operands: string[] = []
  const optionsWithValues = new Set(['-b', '--branch', '-o', '--origin', '-u', '--upload-pack', '-j', '--jobs', '--depth', '--shallow-since', '--shallow-exclude', '--reference', '--reference-if-able', '-c', '--config', '--config-env', '--filter', '--server-option', '--bundle-uri', '--revision', '--template', '--initial-branch', '--object-format', '--ref-format'])
  let separateGitDir: string | undefined
  const configurations: string[] = []
  let unsafeOptions = false
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
    if (arg === '--config' || arg === '--config-env' || arg === '-c') {
      const setting = args[++i]
      if (!setting) verified = false
      else configurations.push(setting)
      continue
    }
    if (arg.startsWith('--config=')) { configurations.push(arg.slice('--config='.length)); continue }
    if (arg.startsWith('--config-env=')) { configurations.push(arg.slice('--config-env='.length)); continue }
    if (arg === '--upload-pack' || arg.startsWith('--upload-pack=') || arg === '--template' || arg.startsWith('--template=')) {
      unsafeOptions = true
    }
    if (optionsWithValues.has(arg)) {
      if (!args[i + 1]) verified = false
      i++
      continue
    }
    if (arg.length > 2 && ['b', 'o', 'u', 'j'].includes(arg[1]!)) continue
    if (arg.startsWith('-c') && arg.length > 2) { configurations.push(arg.slice(2)); continue }
    if (arg.startsWith('-')) continue
    operands.push(arg)
  }
  const destination = command === 'init'
    ? operands[0]
    : operands[1] ?? defaultCloneDestination(operands[0])
  if (command === 'clone' && !operands[0]) verified = false
  return { destination, separateGitDir, configurations, unsafeOptions, verified }
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

function gitOutputPaths(command: string, args: string[]): { paths: string[]; verified: boolean } {
  const paths: string[] = []
  const outputOptions = command === 'format-patch'
    ? new Set(['-o', '--output-directory'])
    : new Set(['-o', '--output'])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (outputOptions.has(arg)) {
      const path = args[++i]
      if (!path) return { paths, verified: false }
      if (path !== '-') paths.push(path)
    } else if (arg.startsWith('--output=')) {
      const path = arg.slice('--output='.length)
      if (!path) return { paths, verified: false }
      if (path !== '-') paths.push(path)
    } else if (command === 'format-patch' && arg.startsWith('--output-directory=')) {
      const path = arg.slice('--output-directory='.length)
      if (!path) return { paths, verified: false }
      paths.push(path)
    } else if (command === 'format-patch' && arg.startsWith('-o') && arg.length > 2) {
      paths.push(arg.slice(2))
    }
  }
  if (command === 'bundle' && gitSubcommand(command, args) === 'create') {
    const create = args.indexOf('create')
    const target = args.slice(create + 1).find((arg) => !arg.startsWith('-'))
    if (!target) return { paths, verified: false }
    paths.push(target)
  }
  return { paths, verified: true }
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

function classifyFind(args: string[], input: PermissionGuardInput, depth: number, dynamic: boolean): string | null {
  const paths: string[] = []
  let index = 0
  while (['-H', '-L', '-P'].includes(args[index] ?? '')) index++
  while (index < args.length && !args[index]!.startsWith('-') && args[index] !== '(' && args[index] !== '!') paths.push(args[index++]!)
  if (!paths.length) paths.push('.')
  if (args.includes('-delete')) {
    const effect = classifyRemoval(paths, true, input)
    if (effect) return effect
  }
  for (let i = index; i < args.length; i++) {
    if (!['-fprint', '-fprint0', '-fls', '-fprintf'].includes(args[i]!)) continue
    const target = args[++i]
    if (!target) return 'the find output path cannot be verified'
    if (dynamic && hasShellExpansion(target)) return 'the find output path cannot be verified'
    if (target !== '-') {
      const effect = protectedPathEffect(target, input, true)
      if (effect) return effect
    }
    if (args[i - 1] === '-fprintf') i++
  }
  for (; index < args.length; index++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[index]!)) continue
    const execdir = args[index] === '-execdir' || args[index] === '-okdir'
    const inner: string[] = []
    while (++index < args.length && ![';', '+'].includes(args[index]!)) inner.push(args[index]!)
    for (const target of paths) {
      const command = inner.map((word) => quoteShellWord(word.replaceAll('{}', target))).join(' ')
      const commandInput = execdir ? { ...input, unverifiedDirectory: true } : input
      const effect = classifyShell(command, commandInput, depth + 1)
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

function classifySed(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  const isInPlace = (arg: string) => {
    if (arg === '-i' || arg === '-I' || arg === '--in-place' || arg.toLowerCase().startsWith('--in-place=')) return true
    const longOption = arg.toLowerCase()
    if (longOption.startsWith('--inpl')) {
      const equal = longOption.indexOf('=')
      const option = equal < 0 ? longOption : longOption.slice(0, equal)
      if ([...option.slice('--inpl'.length)].every((character) => character === '-' || (character >= 'a' && character <= 'z'))) return true
    }
    if (!arg.startsWith('-') || arg.startsWith('--')) return false
    const flags = arg.slice(1)
    const isLetters = (value: string) => {
      for (const character of value) {
        const lower = character.toLowerCase()
        if (lower < 'a' || lower > 'z') return false
      }
      return true
    }
    if (isLetters(flags)) return flags.toLowerCase().includes('i')
    let lettersPrefix = true
    for (let i = 0; i < flags.length; i++) {
      const lower = flags[i]!.toLowerCase()
      if (lower === 'i' && lettersPrefix && flags[i + 1] === '.') return true
      if (lower < 'a' || lower > 'z') lettersPrefix = false
    }
    return false
  }
  if (!args.some(isInPlace)) return null

  const files: string[] = []
  let scriptSeen = false
  let afterSeparator = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!afterSeparator && arg === '--') { afterSeparator = true; continue }
    if (!afterSeparator && ['-e', '--expression', '-f', '--file'].includes(arg)) {
      scriptSeen = true
      i++
      continue
    }
    if (!afterSeparator && (/^--(?:expression|file)=/.test(arg) || /^-[ef].+/.test(arg))) {
      scriptSeen = true
      continue
    }
    if (!afterSeparator && (isInPlace(arg) || arg === '-l' || arg === '--line-length')) {
      if (arg === '-l' || arg === '--line-length') i++
      continue
    }
    if (!afterSeparator && arg.startsWith('-') && arg !== '-') continue
    if (!scriptSeen) scriptSeen = true
    else files.push(arg)
  }
  if (!files.length) return 'the sed in-place target cannot be verified'
  for (const file of files) {
    if (dynamic && /[$`]/.test(file)) return 'the sed in-place target cannot be verified'
    const effect = protectedPathEffect(file, input, true)
    if (effect) return effect
  }
  return null
}

function classifyStartProcess(args: string[], dynamic: boolean, input: PermissionGuardInput, depth: number): string | null {
  if (dynamic) return 'the process command cannot be verified'
  let executable: string | undefined
  let workingDirectory = input.directory
  const childArguments: string[] = []
  const valueOptions = new Set(['-argumentlist', '-args', '-filepath', '-path', '-workingdirectory', '-verb', '-windowstyle'])
  const flagOptions = new Set(['-loaduserprofile', '-nonewwindow', '-passthru', '-usenewenvironment', '-wait', '-whatif', '-confirm'])

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const separator = arg.search(/[:=]/)
    const option = (separator < 0 ? arg : arg.slice(0, separator)).toLowerCase()
    const attachedValue = separator < 0 ? undefined : arg.slice(separator + 1)
    if (valueOptions.has(option)) {
      const value = attachedValue ?? args[++i]
      if (value === undefined) return 'the process command cannot be verified'
      if (option === '-filepath' || option === '-path') executable = value
      else if (option === '-workingdirectory') workingDirectory = normalizePath(value, workingDirectory)?.path
      else if (option === '-argumentlist' || option === '-args') childArguments.push(stripTrailingCommas(value))
      continue
    }
    if (flagOptions.has(option)) continue
    if (arg.startsWith('-')) return 'the process command cannot be verified'
    if (!executable) executable = arg
    else childArguments.push(stripTrailingCommas(arg))
  }
  if (!executable) return 'the process command cannot be verified'
  const childInput = { ...input, directory: workingDirectory }
  if (input.unverifiedDirectory && workingDirectory && isAbsolutePath(workingDirectory)) {
    childInput.unverifiedDirectory = false
  }
  const command = [quoteShellWord(executable), ...childArguments].join(' ')
  return classifyShell(command, childInput, depth + 1)
}

function stripTrailingCommas(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === ',') end--
  return value.slice(0, end)
}

function quoteShellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function classifyTar(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  let extracting = false
  let toStdout = false
  let writingArchive = false
  let destination: string | undefined
  let archiveFile: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--help' || arg === '--version' || arg === '-h') return null
    if (arg === '--to-stdout' || arg === '-O') toStdout = true
    if (arg === '--extract' || arg === '--get') extracting = true
    if (['--create', '--append', '--update', '--delete', '--concatenate', '--catenate'].includes(arg)) writingArchive = true
    if (arg === '--file') {
      archiveFile = args[++i]
      if (!archiveFile) return 'the archive output path cannot be verified'
      continue
    }
    if (arg.startsWith('--file=')) {
      archiveFile = arg.slice('--file='.length)
      continue
    }
    if (arg === '-C' || arg === '--directory') {
      destination = args[++i]
      if (!destination) return 'the archive extraction target cannot be verified'
      continue
    }
    if (arg.startsWith('--directory=')) destination = arg.slice('--directory='.length)
    if (arg.startsWith('-') && arg.length > 1) {
      const flags = arg.slice(1)
      if (flags.includes('x')) extracting = true
      if (flags.includes('c') || flags.includes('r') || flags.includes('u') || flags.includes('d') || flags.includes('A')) writingArchive = true
      if (flags.includes('O')) toStdout = true
      const fileOption = flags.indexOf('f')
      if (fileOption >= 0) {
        archiveFile = flags.length > fileOption + 1 ? flags.slice(fileOption + 1) : args[++i]
        if (!archiveFile) return 'the archive output path cannot be verified'
      }
      const directoryOption = flags.indexOf('C')
      if (directoryOption >= 0 && flags.length > directoryOption + 1) destination = flags.slice(directoryOption + 1)
      if (directoryOption >= 0 && flags.length === directoryOption + 1) {
        destination = args[++i]
        if (!destination) return 'the archive extraction target cannot be verified'
      }
    } else if (/^[A-Za-z]+$/.test(arg)) {
      if (arg[0]?.toLowerCase() === 'x') extracting = true
      if (['c', 'r', 'u', 'd', 'a'].includes(arg[0]?.toLowerCase() ?? '')) writingArchive = true
      if (arg.includes('O')) toStdout = true
      const fileOption = arg.indexOf('f')
      if (fileOption >= 0) {
        archiveFile = arg.length > fileOption + 1 ? arg.slice(fileOption + 1) : args[++i]
        if (!archiveFile) return 'the archive output path cannot be verified'
      }
    }
  }
  if (writingArchive && archiveFile) {
    if (dynamic && hasShellExpansion(archiveFile)) return 'the archive output path cannot be verified'
    const effect = protectedPathEffect(archiveFile, input, true)
    if (effect) return effect
  }
  if (!extracting || toStdout) return null
  const target = destination ?? '.'
  if (dynamic && /[$`]/.test(target)) return 'the archive extraction target cannot be verified'
  if (input.unverifiedDirectory && !isAbsolutePath(target)) return 'the archive extraction target cannot be verified'
  return protectedPathEffect(target, input, true)
}

function classifyUnzip(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  let destination = '.'
  let toStdout = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-p') toStdout = true
    else if (arg === '-d') destination = args[++i] ?? ''
    else if (arg.startsWith('-d') && arg.length > 2) destination = arg.slice(2)
  }
  if (toStdout) return null
  if (!destination || (dynamic && hasShellExpansion(destination))) return 'the archive extraction target cannot be verified'
  return protectedPathEffect(destination, input, true)
}

function classify7z(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  const action = args.find((arg) => !arg.startsWith('-'))?.toLowerCase()
  if (!['x', 'e', 'extract'].includes(action ?? '')) return null
  let destination = '.'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (/^-o$/i.test(arg)) destination = args[++i] ?? ''
    else if (/^-o/i.test(arg)) destination = arg.slice(2) || destination
  }
  if (dynamic && hasShellExpansion(destination)) return 'the archive extraction target cannot be verified'
  return protectedPathEffect(destination, input, true)
}

function classifyCpio(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  let extracting = false
  let passThrough = false
  let destination = '.'
  let outputFile: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-D' || arg === '--directory') destination = args[++i] ?? ''
    else if (/^-D.+/.test(arg)) destination = arg.slice(2)
    else if (arg === '-F' || arg === '--file') outputFile = args[++i]
    else if (arg.startsWith('--file=')) outputFile = arg.slice('--file='.length)
    else if (/^-F.+/.test(arg)) outputFile = arg.slice(2)
    else if (arg.startsWith('-') && !arg.startsWith('--')) {
      extracting ||= /[ip]/i.test(arg.slice(1))
      passThrough ||= /p/i.test(arg.slice(1))
      const fileOption = arg.indexOf('F', 1)
      if (fileOption >= 0) outputFile = arg.slice(fileOption + 1) || args[++i]
    }
  }
  if (passThrough) destination = args.find((arg) => !arg.startsWith('-')) ?? ''
  if (outputFile) {
    if (dynamic && hasShellExpansion(outputFile)) return 'the archive output path cannot be verified'
    const effect = protectedPathEffect(outputFile, input, true)
    if (effect) return effect
  }
  if (!extracting) return null
  if (!destination || (dynamic && hasShellExpansion(destination))) return 'the archive extraction target cannot be verified'
  return protectedPathEffect(destination, input, true)
}

function classifyRsync(args: string[], dynamic: boolean, input: PermissionGuardInput): string | null {
  const valueOptions = new Set([
    '--backup-dir', '--block-size', '--bwlimit', '--checksum-choice', '--checksum-seed', '--chmod', '--chown',
    '--compare-dest', '--compress-choice', '--compress-level', '--compress-threads', '--contimeout',
    '--copy-dest', '--exclude', '--exclude-from', '--files-from', '--filter', '--groupmap', '--iconv', '--include',
    '--include-from', '--link-dest', '--log-file', '--log-file-format', '--max-delete', '--only-write-batch',
    '--max-alloc', '--max-size', '--min-size', '--modify-window', '--out-format', '--outbuf', '--partial-dir',
    '--password-file', '--port', '--protocol', '--read-batch', '--remote-option', '--rsync-path', '--rsh',
    '--skip-compress', '--sockopts', '--stop-after', '--stop-at', '--suffix', '--temp-dir', '--timeout', '--usermap',
    '--write-batch', '--info', '--debug', '--copy-as',
  ])
  const outputOptions = new Set(['--backup-dir', '--log-file', '--only-write-batch', '--partial-dir', '--temp-dir', '--write-batch'])
  const valueShortOptions = new Set(['-B', '-e', '-f', '-M', '-T'])
  const flagShortOptions = new Set('vqc arRbulLpotD123468Wxzhn iPEJOSHAXINCFds'.replaceAll(' ', '').split(''))
  const flagOptions = new Set([
    '--8-bit-output', '--acls', '--archive', '--atimes', '--backup', '--checksum', '--compress', '--copy-links',
    '--copy-unsafe-links', '--del', '--delete', '--delete-after', '--delete-before', '--delete-delay',
    '--delete-during', '--delete-excluded', '--delete-missing-args', '--dirs', '--executability', '--existing',
    '--group', '--hard-links', '--human-readable', '--ignore-errors', '--ignore-existing', '--ignore-missing-args',
    '--ignore-times', '--inplace', '--itemize-changes', '--keep-dirlinks', '--links', '--mkpath', '--no-implied-dirs',
    '--no-motd', '--no-whole-file', '--omit-dir-times', '--omit-link-times', '--one-file-system', '--owner',
    '--partial', '--perms', '--preallocate', '--progress', '--prune-empty-dirs', '--quiet', '--recursive',
    '--relative', '--remove-source-files', '--safe-links', '--sparse', '--specials', '--stats', '--times',
    '--update', '--verbose', '--whole-file', '--xattrs', '--dry-run',
    '--fuzzy', '--human-readable', '--ignore-existing', '--ignore-times', '--itemize-changes', '--links',
    '--no-implied-dirs', '--no-motd', '--no-whole-file', '--numeric-ids', '--protect-args', '--secluded-args',
  ])
  const outputPaths: string[] = []
  const operands: string[] = []
  let removeSources = false
  let deleteDestination = false
  let dryRun = false
  let filesFrom = false
  let afterSeparator = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!afterSeparator && arg === '--') { afterSeparator = true; continue }
    if (!afterSeparator && arg.startsWith('--')) {
      const equal = arg.indexOf('=')
      const option = equal < 0 ? arg : arg.slice(0, equal)
      if (valueOptions.has(option)) {
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1)
        if (!value) return 'the rsync option cannot be verified'
        if (outputOptions.has(option)) outputPaths.push(value)
        if (option === '--files-from') filesFrom = true
        continue
      }
      if (option === '--remove-source-files') { removeSources = true; continue }
      if (option.startsWith('--delete')) { deleteDestination = true; continue }
      if (flagOptions.has(option)) continue
      return 'the rsync options cannot be verified'
    }
    if (!afterSeparator && arg.startsWith('-') && arg !== '-') {
      const letters = arg.slice(1)
      let consumed = false
      for (let j = 0; j < letters.length; j++) {
        const option = `-${letters[j]!}`
        if (valueShortOptions.has(option)) {
          const value = letters.slice(j + 1) || args[++i]
          if (!value) return 'the rsync option cannot be verified'
          if (option === '-T') outputPaths.push(value)
          consumed = true
          break
        }
        if (letters[j] === 'n') dryRun = true
        if (!flagShortOptions.has(letters[j]!)) return 'the rsync options cannot be verified'
      }
      if (consumed || letters.length) continue
    }
    operands.push(arg)
  }
  if (operands.length < 2) return 'the rsync destination cannot be verified'
  const destination = operands.at(-1)!
  if (dynamic && /[$`]/.test(destination)) return 'the rsync destination cannot be verified'
  if (filesFrom && removeSources) return 'the rsync removal source paths cannot be verified'
  for (const output of outputPaths) {
    if (dynamic && /[$`]/.test(output)) return 'the rsync output path cannot be verified'
    const effect = protectedPathEffect(output, input, true)
    if (effect) return effect
  }
  if (dryRun || args.includes('--dry-run')) return null
  if (filesFrom && !isRemotePath(destination)) {
    const effect = protectedPathEffect(destination, input, true)
    if (effect) return effect
  }
  if (deleteDestination) {
    const effect = classifyRemoval([destination], dynamic, input)
    if (effect) return effect
  } else if (!isRemotePath(destination)) {
    const effect = classifyFileMutation('cp', ['--', ...operands], dynamic, input)
    if (effect) return effect
  }
  if (removeSources) {
    for (const source of operands.slice(0, -1)) {
      const effect = classifyRemoval([source], dynamic, input)
      if (effect) return effect
    }
  }
  return null
}

function isRemotePath(value: string): boolean {
  return value.includes(':') && !/^[A-Za-z]:[\\/]/.test(value)
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
  return ['cp', 'copy', 'copy-item', 'cpi', 'install', 'ln', 'link', 'mklink', 'mv', 'move', 'move-item', 'mi', 'ren', 'rename', 'rename-item', 'rni', 'tee', 'tee-object', 'truncate', 'touch', 'chmod', 'chown', 'mkdir', 'md', 'new-item', 'ni'].includes(commandBase(command))
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
    if (!afterSeparator && !copy && !move && ['-path', '-literalpath'].includes(option)) {
      const target = args[++i]
      if (target) targets.push(target)
      continue
    }
    if (!afterSeparator && !copy && !move && /^-(?:path|literalpath)[:=]/.test(option)) {
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
  const projectRoot = context ? normalizePath(context.projectRoot) : undefined
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

  if (projectRoot && pathContains(projectRoot, prefix)
    && (!worktree || !pathContains(worktree, prefix))) {
    return 'the command would change the original project checkout outside the managed ticket worktree'
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
  const home = broad ? normalizePath(homedir()) : undefined
  if (home && pathContains(prefix, home)) return 'the command could remove your home directory'
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
  return commandBase(value) === name
}

function basename(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? ''
}

function commandBase(value: string): string {
  const name = basename(value).toLowerCase()
  return name.replace(/\.(?:exe|cmd|bat)$/, '')
}

function equalsPath(left: string, right: string, windows: boolean): boolean {
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right
}
