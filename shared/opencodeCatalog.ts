export interface OpenCodeCatalogModel {
  fullId: string
  /** OpenCode's canonical id, used in model selections. */
  id: string
  /** Provider-facing id used to construct the upstream request. */
  modelID?: string
  name: string
  providerID: string
  providerName: string
  family: string
  costInput: number | null
  costOutput: number | null
  costTiers?: Array<{
    size?: number
    input: number
    output: number
    cacheRead?: number
    cacheWrite?: number
  }>
  contextWindow: number
  canReason: boolean | null
  canUseTools: boolean | null
  canSeeImages: boolean | null
  inputModalities?: string[]
  outputModalities?: string[]
  status: string
  variants?: Record<string, Record<string, unknown>>
}

export type OpenCodeCatalogScope = 'connected' | 'all' | 'available'

export interface OpenCodeCatalogResponse {
  all: Array<{
    id: string
    name: string
    env?: string[]
    npm?: string[]
    models: Record<string, {
      id: string
      modelID?: string
      name: string
      family?: string
      status?: string
      enabled?: boolean
      cost?: {
        input?: number | null
        output?: number | null
        tiers?: Array<{
          size?: number
          input: number
          output: number
          cacheRead?: number
          cacheWrite?: number
        }>
      }
      limit?: { context?: number }
      capabilities?: {
        reasoning?: boolean | null
        toolcall?: boolean | null
        tools?: boolean | null
        input?: { image?: boolean | null }
      }
      modalities?: { input?: string[]; output?: string[] }
      variants?: Record<string, Record<string, unknown>>
    }>
  }>
  connected: string[]
  default: Record<string, string>
  supportsAllModels: boolean
}
