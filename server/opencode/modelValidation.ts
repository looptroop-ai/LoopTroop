import { fetchConnectedModelIds } from './providerCatalog'
import { parseCouncilMembers } from '../council/members'

export const MAX_COUNCIL_MEMBERS = 10

export interface ValidatedModelSelection {
  mainImplementer: string
  councilMembers: string[]
}

function cleanModelId(modelId: string): string {
  if (modelId.startsWith('openrouter/')) {
    return modelId.split(':')[0]!
  }
  return modelId
}

export async function validateModelSelection(
  mainImplementerRaw: string | null | undefined,
  councilMembersRaw: string | null | undefined,
): Promise<ValidatedModelSelection> {
  const mainImplementer = typeof mainImplementerRaw === 'string' ? mainImplementerRaw.trim() : ''
  if (!mainImplementer) {
    throw new Error('Main implementer model is required.')
  }

  const connectedModelIds = new Set(await fetchConnectedModelIds())
  if (connectedModelIds.size === 0) {
    throw new Error('No configured OpenCode models are available.')
  }

  const cleanMain = cleanModelId(mainImplementer)
  if (!connectedModelIds.has(cleanMain)) {
    throw new Error(`Main implementer model is not configured in OpenCode: ${mainImplementer}`)
  }

  const parsedCouncilMembers = parseCouncilMembers(councilMembersRaw)
  const councilMembersByBaseId = new Map<string, string>()
  for (const memberId of [mainImplementer, ...parsedCouncilMembers]) {
    const baseId = cleanModelId(memberId)
    if (!councilMembersByBaseId.has(baseId)) {
      councilMembersByBaseId.set(baseId, memberId)
    }
  }
  const normalizedCouncilMembers = Array.from(councilMembersByBaseId.values())

  if (normalizedCouncilMembers.length < 2) {
    throw new Error('At least two distinct council members are required, including the main implementer.')
  }
  if (normalizedCouncilMembers.length > MAX_COUNCIL_MEMBERS) {
    throw new Error(`At most ${MAX_COUNCIL_MEMBERS} distinct council members are allowed, including the main implementer.`)
  }

  const invalidCouncilMembers = normalizedCouncilMembers.filter((memberId) => {
    return !connectedModelIds.has(cleanModelId(memberId))
  })
  if (invalidCouncilMembers.length > 0) {
    throw new Error(`Council member models are not configured in OpenCode: ${invalidCouncilMembers.join(', ')}`)
  }

  return {
    mainImplementer,
    councilMembers: normalizedCouncilMembers,
  }
}
