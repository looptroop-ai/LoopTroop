import { useQuery, type QueryClient } from '@tanstack/react-query'
import type { OpenCodeCatalogModel, OpenCodeCatalogReloadState, OpenCodeCatalogScope } from '@shared/opencodeCatalog'
import {
  MODEL_FETCH_RETRY_COUNT,
  MODEL_FETCH_RETRY_DELAY_MS,
  MODEL_FETCH_TIMEOUT_MS,
  MODEL_REFRESH_TIMEOUT_MS,
  QUERY_STALE_TIME_5M,
} from '@/lib/constants'
import { failedResponseError } from '@/lib/fetchError'

interface ModelsApiResponse {
  models: OpenCodeCatalogModel[]
  connectedProviders: string[]
  defaultModels: Record<string, string>
  catalogScope?: OpenCodeCatalogScope
  message?: string
  code?: OpenCodeModelsErrorCode
  reloadState?: OpenCodeCatalogReloadState
}

export type OpenCodeModelsErrorCode = 'OPENCODE_UNREACHABLE' | 'OPENCODE_DISCOVERY_FAILED' | 'OPENCODE_DISCOVERY_TIMEOUT' | 'OPENCODE_BUSY'

export class OpenCodeModelsError extends Error {
  readonly code?: OpenCodeModelsErrorCode
  readonly reloadState?: OpenCodeCatalogReloadState

  constructor(message: string, code?: OpenCodeModelsErrorCode, reloadState?: OpenCodeCatalogReloadState) {
    super(message)
    this.name = 'OpenCodeModelsError'
    this.code = code
    this.reloadState = reloadState
  }
}

export type OpenCodeModel = OpenCodeCatalogModel
export const OPENCODE_MODELS_QUERY_KEY = ['opencode-models', 'connected'] as const
export const ALL_OPENCODE_MODELS_QUERY_KEY = ['opencode-models', 'all'] as const
const OPENCODE_MODELS_REFRESH_QUERY_KEY = ['opencode-models', 'refresh'] as const

async function requestModelsApi(
  path: string,
  method: 'GET' | 'POST',
  signal?: AbortSignal,
): Promise<ModelsApiResponse> {
  // The deadline is this request's own; the query's signal is the one that fires
  // when the component unmounts. Either ending the request is correct, so both
  // are honoured rather than one replacing the other.
  const timeout = AbortSignal.timeout(method === 'POST' ? MODEL_REFRESH_TIMEOUT_MS : MODEL_FETCH_TIMEOUT_MS)
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const res = await fetch(path, {
      method,
      signal: requestSignal,
    })
    if (!res.ok) {
      if (res.status === 409) {
        const body: unknown = await res.clone().json().catch(() => null)
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          const { code, message } = body as { code?: unknown; message?: unknown }
          if (code === 'OPENCODE_BUSY') {
            throw new OpenCodeModelsError(
              typeof message === 'string' ? message : 'OpenCode has active work or unanswered requests.',
              code,
            )
          }
        }
      }
      throw await failedResponseError(res, 'Failed to fetch models')
    }
    const data: ModelsApiResponse = await res.json()
    // When the backend cannot reach OpenCode it returns a `message` with an empty
    // model list (HTTP 200). Treat this as a retriable error so react-query retries
    // during the startup window while OpenCode is still initialising.
    if (data.message) throw new OpenCodeModelsError(data.message, data.code, data.reloadState)
    return data
  } catch (error) {
    if (timeout.aborted && requestSignal.reason === timeout.reason
      && (error === timeout.reason || (error instanceof DOMException
        && (error.name === 'AbortError' || error.name === 'TimeoutError')))) {
      throw new OpenCodeModelsError(
        'OpenCode model discovery timed out. Try refreshing models.',
        'OPENCODE_DISCOVERY_TIMEOUT',
      )
    }
    throw error
  }
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

function modelFetchRetry() {
  let timeoutRetries = 0
  return (failureCount: number, error: Error): boolean => {
    // Each new fetch starts at zero, even when it reuses this callback.
    if (failureCount === 0) timeoutRetries = 0
    const code = (error as OpenCodeModelsError).code
    if (code === 'OPENCODE_DISCOVERY_TIMEOUT') return timeoutRetries++ < 1
    return failureCount < MODEL_FETCH_RETRY_COUNT
      && (code === 'OPENCODE_UNREACHABLE' || code === 'OPENCODE_DISCOVERY_FAILED')
  }
}

export function clearOpenCodeModelsQuery(queryClient: Pick<QueryClient, 'removeQueries'>) {
  queryClient.removeQueries({
    queryKey: ['opencode-models'],
  })
}

export async function refreshOpenCodeModelsQuery(queryClient: Pick<QueryClient, 'cancelQueries' | 'fetchQuery' | 'invalidateQueries' | 'setQueryData' | 'removeQueries'>) {
  await queryClient.cancelQueries({ queryKey: ['opencode-models'] })
  let reloadState: OpenCodeCatalogReloadState = 'not_started'
  let unconfirmedReloadFailure: OpenCodeModelsError | undefined
  const retry = modelFetchRetry()
  let data: ModelsApiResponse
  try {
    data = await queryClient.fetchQuery({
      // Model observers must not replace this operation's query function on retry.
      queryKey: OPENCODE_MODELS_REFRESH_QUERY_KEY,
      queryFn: async ({ signal }) => {
        // Repeat the reload only when the backend confirms it never started.
        if (reloadState !== 'not_started') return fetchModelsApi(signal)
        reloadState = 'unknown'
        try {
          const refreshed = await refreshModelsApi(signal)
          reloadState = 'completed'
          return refreshed
        } catch (error) {
          if (error instanceof OpenCodeModelsError) {
            reloadState = error.reloadState ?? 'unknown'
            if (reloadState === 'unknown') unconfirmedReloadFailure = error
          }
          throw error
        }
      },
      // A manual refresh must POST even when the connected catalog is still fresh.
      staleTime: 0,
      retry: (failureCount, error) => {
        if (reloadState === 'unknown' && (error as OpenCodeModelsError).code !== 'OPENCODE_DISCOVERY_TIMEOUT') return false
        return retry(failureCount, error)
      },
      retryDelay: MODEL_FETCH_RETRY_DELAY_MS,
    })
  } finally {
    // Dashboard refetches must never replay a completed manual operation.
    queryClient.removeQueries({ queryKey: OPENCODE_MODELS_REFRESH_QUERY_KEY, exact: true })
  }
  queryClient.setQueryData(OPENCODE_MODELS_QUERY_KEY, data)
  await queryClient.invalidateQueries({ queryKey: ALL_OPENCODE_MODELS_QUERY_KEY, exact: true })
  // A recovered read updates the cache without proving the reload completed.
  if (unconfirmedReloadFailure) throw unconfirmedReloadFailure
  return data
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
    retry: modelFetchRetry(),
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
    retry: modelFetchRetry(),
    retryDelay: MODEL_FETCH_RETRY_DELAY_MS,
    select: (data) => data.models,
    enabled,
  })
}
