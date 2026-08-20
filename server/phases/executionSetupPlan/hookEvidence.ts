import { db as appDb } from '../../db'
import { PROFILE_DEFAULTS } from '../../db/defaults'
import { profiles } from '../../db/schema'
import { discoverGitHooks } from '../../git/hookDiscovery'
import { isGitHookPolicy } from '../../git/hookPolicy'
import { detectHostContext } from '../../lib/hostContext'
import { getProjectContextById } from '../../storage/projects'
import { getTicketContext, getTicketPaths } from '../../storage/tickets'
import type { ExecutionSetupPlan } from './types'

function resolveConfiguredPolicy(ticketId: string): ExecutionSetupPlan['gitHooks']['policy'] {
  const storage = getTicketContext(ticketId)
  const ticket = storage?.localTicket
  if (ticket?.startedAt) {
    return isGitHookPolicy(ticket.lockedGitHookPolicy)
      ? ticket.lockedGitHookPolicy
      : PROFILE_DEFAULTS.gitHookPolicy
  }
  const projectPolicy = storage ? getProjectContextById(storage.projectId)?.project.gitHookPolicy : null
  if (isGitHookPolicy(projectPolicy)) return projectPolicy
  const profilePolicy = appDb.select().from(profiles).limit(1).get()?.gitHookPolicy
  return isGitHookPolicy(profilePolicy) ? profilePolicy : PROFILE_DEFAULTS.gitHookPolicy
}

export function lockExecutionSetupPlanDetectedHooks(ticketId: string, plan: ExecutionSetupPlan): ExecutionSetupPlan {
  const paths = getTicketPaths(ticketId)
  const policy = resolveConfiguredPolicy(ticketId)
  if (!paths) {
    return {
      ...plan,
      gitHooks: { ...plan.gitHooks, policy },
    }
  }
  return {
    ...plan,
    hostContext: detectHostContext(),
    gitHooks: {
      ...plan.gitHooks,
      policy,
      detected: discoverGitHooks(paths.worktreePath).detected,
    },
  }
}

export function enrichGeneratedExecutionSetupPlan(ticketId: string, plan: ExecutionSetupPlan): ExecutionSetupPlan {
  const paths = getTicketPaths(ticketId)
  if (!paths) return plan
  const discovery = discoverGitHooks(paths.worktreePath)
  const commands = [...plan.gitHooks.validationCommands]
  for (const suggestion of discovery.suggestedValidationCommands) {
    if (!commands.some((command) =>
      command.id === suggestion.id
      || JSON.stringify(command.command) === JSON.stringify(suggestion.command),
    )) {
      commands.push(suggestion)
    }
  }
  return {
    ...plan,
    gitHooks: {
      policy: resolveConfiguredPolicy(ticketId),
      detected: discovery.detected,
      validationCommands: commands,
    },
  }
}
