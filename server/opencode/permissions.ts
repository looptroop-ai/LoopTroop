import type { OpenCodePermissionRule } from './types'

export const OPENCODE_EXECUTION_ALLOW_ALL_PERMISSIONS: ReadonlyArray<OpenCodePermissionRule> = Object.freeze([
  {
    permission: '*',
    pattern: '*',
    action: 'allow',
  },
  {
    permission: '*',
    pattern: '/*',
    action: 'allow',
  },
  {
    permission: '*',
    pattern: '/**/*',
    action: 'allow',
  },
  {
    permission: '*',
    pattern: '**',
    action: 'allow',
  },
  {
    permission: '*',
    pattern: '**/.*',
    action: 'allow',
  },
  {
    permission: 'doom_loop',
    pattern: '*',
    action: 'allow',
  },
  {
    permission: 'external_directory',
    pattern: '*',
    action: 'allow',
  },
])
