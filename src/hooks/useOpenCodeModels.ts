import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { OpenCodeCatalogModel, OpenCodeCatalogScope } from '@shared/opencodeCatalog'
import {
  MODEL_FETCH_RETRY_COUNT,
  MODEL_FETCH_RETRY_DELAY_MS,
  MODEL_FETCH_TIMEOUT_MS,
  QUERY_STALE_TIME_5M,
} from '@/lib/constants'
import { failedResponseError } from '@/lib/fetchError'

interface ModelsApiResponse {
  models: OpenCodeCatalogModel[]
  connectedProviders: string[]
  defaultModels: Record<string, string>
  catalogScope?: OpenCodeCatalogScope
  message?: string
  code?: 'OPENCODE_UNREACHABLE' | 'OPENCODE_DISCOVERY_FAILED'
}

export type OpenCodeModelsErrorCode = 'OPENCODE_UNREACHABLE' | 'OPENCODE_DISCOVERY_FAILED'

export class OpenCodeModelsError extends Error {
  readonly code?: OpenCodeModelsErrorCode

  constructor(message: string, code?: OpenCodeModelsErrorCode) {
    super(message)
    this.name = 'OpenCodeModelsError'
    this.code = code
  }
}

export type OpenCodeModel = OpenCodeCatalogModel
export const OPENCODE_MODELS_QUERY_KEY = ['opencode-models', 'connected'] as const
export const ALL_OPENCODE_MODELS_QUERY_KEY = ['opencode-models', 'all'] as const

async function requestModelsApi(
  path: string,
  method: 'GET' | 'POST',
  signal?: AbortSignal,
): Promise<ModelsApiResponse> {
  // The deadline is this request's own; the query's signal is the one that fires
  // when the component unmounts. Either ending the request is correct, so both
  // are honoured rather than one replacing the other.
  const timeout = AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS)
  const res = await fetch(path, {
    method,
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  })
  if (!res.ok) throw await failedResponseError(res, 'Failed to fetch models')
  const data: ModelsApiResponse = await res.json()
  // When the backend cannot reach OpenCode it returns a `message` with an empty
  // model list (HTTP 200). Treat this as a retriable error so react-query retries
  // during the startup window while OpenCode is still initialising.
  if (data.message) throw new OpenCodeModelsError(data.message, data.code)
  return data
}

export function fetchModelsApi(signal?: AbortSignal): Promise<ModelsApiResponse> {
  return requestModelsApi('/api/models', 'GET', signal)
}

export function fetchAllModelsApi(signal?: AbortSignal): Promise<ModelsApiResponse> {
  return requestModelsApi('/api/models?scope=all', 'GET', signal)
}

function refreshModelsApi(signal?: AbortSignal): Promise<ModelsApiResponse> {
  return requestModelsApi('/api/models/refresh', 'POST', signal)
}

function shouldRetryModelFetch(failureCount: number, error: Error): boolean {
  const code = (error as OpenCodeModelsError).code
  return failureCount < MODEL_FETCH_RETRY_COUNT
    && (code === 'OPENCODE_UNREACHABLE' || code === 'OPENCODE_DISCOVERY_FAILED')
}

export function clearOpenCodeModelsQuery(queryClient: Pick<QueryClient, 'removeQueries'>) {
  queryClient.removeQueries({
    queryKey: ['opencode-models'],
  })
}

export function refreshOpenCodeModelsQuery(queryClient: Pick<QueryClient, 'removeQueries' | 'fetchQuery'>) {
  clearOpenCodeModelsQuery(queryClient)
  return queryClient.fetchQuery({
    queryKey: OPENCODE_MODELS_QUERY_KEY,
    queryFn: ({ signal }) => refreshModelsApi(signal),
    staleTime: QUERY_STALE_TIME_5M,
    retry: shouldRetryModelFetch,
    retryDelay: MODEL_FETCH_RETRY_DELAY_MS,
  })
}

export function refetchOpenCodeModelsQuery(queryClient: Pick<QueryClient, 'refetchQueries'>) {
  return queryClient.refetchQueries({
    queryKey: ['opencode-models'],
    type: 'active',
  })
}

/** Returns the response metadata used to describe which model scope OpenCode exposes. */
export function useOpenCodeModelCatalog() {
  return useQuery({
    queryKey: OPENCODE_MODELS_QUERY_KEY,
    queryFn: ({ signal }) => fetchModelsApi(signal),
    staleTime: QUERY_STALE_TIME_5M,
    retry: shouldRetryModelFetch,
    retryDelay: MODEL_FETCH_RETRY_DELAY_MS,
  })
}

/** Returns only models from connected (configured) providers */
export function useOpenCodeModels() {
  const query = useOpenCodeModelCatalog()
  return { ...query, data: query.data?.models }
}

/** Returns all models from all providers only when explicitly requested. */
export function useAllOpenCodeModels(enabled = false) {
  return useQuery({
    queryKey: ALL_OPENCODE_MODELS_QUERY_KEY,
    queryFn: ({ signal }) => fetchAllModelsApi(signal),
    staleTime: QUERY_STALE_TIME_5M,
    retry: shouldRetryModelFetch,
    retryDelay: MODEL_FETCH_RETRY_DELAY_MS,
    select: (data) => data.models,
    enabled,
  })
}
