import { z } from 'zod'
import {
  commandShellSchema,
  type CommandShellKind,
  type HostContext,
} from './hostContext'

export const MIN_COMMAND_TIMEOUT_MS = 100
export const MAX_COMMAND_TIMEOUT_MS = 30 * 60 * 1000

const relativeWorkingDirectorySchema = z.string()
  .trim()
  .min(1)
  .max(1_000)
  .refine(isRepoRelativePath, 'Working directory must be relative to the repository root')

export const commandEnvironmentSchema = z.record(
  z.string().min(1).max(1_000).refine((key) => !key.includes('=') && !key.includes('\0'), {
    message: 'Environment variable names cannot contain "=" or null characters',
  }),
  z.string().max(100_000).refine((value) => !value.includes('\0'), {
    message: 'Environment variable values cannot contain null characters',
  }),
)

const commandTimeoutSchema = z.number()
  .int()
  .min(MIN_COMMAND_TIMEOUT_MS)
  .max(MAX_COMMAND_TIMEOUT_MS)
  .optional()

const commandBaseSchema = z.object({
  cwd: relativeWorkingDirectorySchema.default('.'),
  env: commandEnvironmentSchema.default({}),
  timeoutMs: commandTimeoutSchema,
})

export const processCommandSpecSchema = commandBaseSchema.extend({
  mode: z.literal('process'),
  program: z.string().trim().min(1).max(10_000).refine((value) => !value.includes('\0'), {
    message: 'Program cannot contain null characters',
  }),
  args: z.array(z.string().max(100_000).refine((value) => !value.includes('\0'), {
    message: 'Arguments cannot contain null characters',
  })).default([]),
})

export const shellCommandSpecSchema = commandBaseSchema.extend({
  mode: z.literal('shell'),
  shell: commandShellSchema,
  script: z.string().trim().min(1).max(1_000_000).refine((value) => !value.includes('\0'), {
    message: 'Shell script cannot contain null characters',
  }),
})

export const commandSpecSchema = z.discriminatedUnion('mode', [
  processCommandSpecSchema,
  shellCommandSpecSchema,
])

export type ProcessCommandSpec = z.infer<typeof processCommandSpecSchema>
export type ShellCommandSpec = z.infer<typeof shellCommandSpecSchema>
export type CommandSpec = z.infer<typeof commandSpecSchema>

export const runtimeEnvironmentSchema = z.object({
  pathPrepend: z.array(relativeWorkingDirectorySchema).default([]),
  variables: commandEnvironmentSchema.default({}),
})

export type RuntimeEnvironment = z.infer<typeof runtimeEnvironmentSchema>

export interface NormalizedCommandSpec {
  command: CommandSpec
  repaired: boolean
  warning?: string
}

export function isRepoRelativePath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || normalized.startsWith('//')) return false
  if (/^[a-zA-Z]:($|\/)/.test(normalized)) return false
  return !normalized.split('/').some((segment) => segment === '..')
}

function quotePosix(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function quoteCmd(value: string): string {
  if (value.length > 0 && !/[\s"&<>|^()%!]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

function quotePowerShell(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "''")}'`
}

export function quoteCommandArgument(value: string, shell: CommandShellKind): string {
  if (shell === 'cmd') return quoteCmd(value)
  if (shell === 'powershell') return quotePowerShell(value)
  return quotePosix(value)
}

export function renderCommandSpec(command: CommandSpec | string, processShell: CommandShellKind = 'posix'): string {
  if (typeof command === 'string') return command
  if (command.mode === 'shell') return command.script
  return [command.program, ...(command.args ?? [])]
    .map((part) => quoteCommandArgument(part, processShell))
    .join(' ')
}

export function normalizeCommandSpec(value: unknown, host: HostContext): NormalizedCommandSpec {
  const parsed = commandSpecSchema.safeParse(value)
  if (parsed.success) {
    return { command: parsed.data, repaired: false }
  }
  if (typeof value === 'string' && value.trim()) {
    return {
      command: {
        mode: 'shell',
        shell: host.preferredShell,
        script: value,
        cwd: '.',
        env: {},
      },
      repaired: true,
      warning: `Legacy command text was preserved and assigned to the current host's ${host.preferredShell} shell.`,
    }
  }
  throw parsed.error
}

export function getCommandSpecPromptExample(): CommandSpec {
  return {
    mode: 'process',
    program: 'tool',
    args: ['test'],
    cwd: '.',
    env: {},
    timeoutMs: 120_000,
  }
}

export function createShellCommandSpec(
  script: string,
  shell: CommandShellKind = 'posix',
): ShellCommandSpec {
  return { mode: 'shell', shell, script, cwd: '.', env: {} }
}
