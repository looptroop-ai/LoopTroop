export const LOOPTROOP_OPENCODE_ROUTING_CONFIG = 'LOOPTROOP_OPENCODE_ROUTING_CONFIG'

const OPENROUTER_ROUTING_SUFFIXES = [':floor', ':nitro', ':thinking', ':extended', ':free', ':exacto'] as const

export function isOpenRouterRoutingModel(modelId: string): boolean {
  return modelId.startsWith('openrouter/')
    && OPENROUTER_ROUTING_SUFFIXES.some((suffix) => modelId.endsWith(suffix))
}
