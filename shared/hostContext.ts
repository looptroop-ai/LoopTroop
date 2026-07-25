import { z } from 'zod'

export const hostPlatformSchema = z.enum(['windows', 'macos', 'linux'])
export type HostPlatform = z.infer<typeof hostPlatformSchema>

export const hostEnvironmentSchema = z.enum(['native', 'wsl'])
export type HostEnvironment = z.infer<typeof hostEnvironmentSchema>

export const commandShellSchema = z.enum(['posix', 'cmd', 'powershell'])
export type CommandShellKind = z.infer<typeof commandShellSchema>

export const hostContextSchema = z.object({
  platform: hostPlatformSchema,
  environment: hostEnvironmentSchema,
  arch: z.string().trim().min(1).max(100),
  availableShells: z.array(commandShellSchema).min(1),
  preferredShell: commandShellSchema,
}).superRefine((value, context) => {
  if (!value.availableShells.includes(value.preferredShell)) {
    context.addIssue({
      code: 'custom',
      path: ['preferredShell'],
      message: 'Preferred shell must be included in available shells',
    })
  }
  if (value.environment === 'wsl' && value.platform !== 'linux') {
    context.addIssue({
      code: 'custom',
      path: ['environment'],
      message: 'WSL is represented as a Linux host',
    })
  }
})

export type HostContext = z.infer<typeof hostContextSchema>
