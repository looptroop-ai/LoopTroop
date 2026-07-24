import { fetchConnectedModelIds } from './providerCatalog'
import { parseCouncilMembers } from '../council/members'
import { normalizeModelId } from '../../shared/modelId'

export const MAX_COUNCIL_MEMBERS = 10

export interface ValidatedModelSelection {
  mainImplementer: string
  councilMembers: string[]
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

  const cleanMain = normalizeModelId(mainImplementer)
  if (!connectedModelIds.has(cleanMain)) {
    throw new Error(`Main implementer model is not configured in OpenCode: ${mainImplementer}`)
  }

  const parsedCouncilMembers = parseCouncilMembers(councilMembersRaw)
  const normalizedCouncilMembers = Array.from(new Set(
    [mainImplementer, ...parsedCouncilMembers]
      .map(normalizeModelId)
      .filter(Boolean),
  ))

  if (normalizedCouncilMembers.length < 2) {
    throw new Error('At least two distinct council members are required, including the main implementer.')
  }
  if (normalizedCouncilMembers.length > MAX_COUNCIL_MEMBERS) {
    throw new Error(`At most ${MAX_COUNCIL_MEMBERS} distinct council members are allowed, including the main implementer.`)
  }

  const invalidCouncilMembers = normalizedCouncilMembers.filter((memberId) => {
    return !connectedModelIds.has(memberId)
  })
  if (invalidCouncilMembers.length > 0) {
    throw new Error(`Council member models are not configured in OpenCode: ${invalidCouncilMembers.join(', ')}`)
  }

  return {
    mainImplementer: cleanMain,
    councilMembers: normalizedCouncilMembers,
  }
}
