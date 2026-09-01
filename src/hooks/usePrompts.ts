import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

export interface PromptSummary {
  id: string
  description: string
  step: number | null
  modified: boolean
}

export interface PromptStatusGroup {
  status: string
  label: string
  prompts: PromptSummary[]
}

export interface PromptGroup {
  id: string
  label: string
  statuses: PromptStatusGroup[]
}

import type { PromptLoadWarning } from '@shared/promptCatalog'
export type { PromptLoadWarning }

export interface PromptCatalogResponse {
  groups: PromptGroup[]
  modifiedCount: number
  templatesDir: string
  warnings: PromptLoadWarning[]
}

export interface PromptDetail {
  id: string
  description: string
  kind: 'template' | 'global_rule'
  current: string
  default: string
  modified: boolean
}

export interface PromptSaveResult {
  errors: string[]
  warnings: string[]
  modified?: boolean
}

const CATALOG_KEY = ['prompts'] as const

async function readError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => null) as { error?: string; errors?: string[] } | null
  throw new Error(body?.errors?.join('; ') || body?.error || fallback)
}

export function usePromptCatalog(enabled = true) {
  return useQuery({
    queryKey: CATALOG_KEY,
    enabled,
    queryFn: async (): Promise<PromptCatalogResponse> => {
      const res = await fetch('/api/prompts')
      if (!res.ok) await readError(res, 'Failed to load prompts')
      return await res.json() as PromptCatalogResponse
    },
  })
}

export function usePrompt(id: string | null) {
  return useQuery({
    queryKey: ['prompt', id],
    enabled: id !== null,
    queryFn: async (): Promise<PromptDetail> => {
      const res = await fetch(`/api/prompts/${id}`)
      if (!res.ok) await readError(res, 'Failed to load prompt')
      return await res.json() as PromptDetail
    },
  })
}

export function useSavePrompt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, source }: { id: string; source: string }): Promise<PromptSaveResult> => {
      const res = await fetch(`/api/prompts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      })
      const body = await res.json().catch(() => null) as PromptSaveResult | null
      if (!res.ok) {
        // Validation failures return a structured payload; surface it as-is.
        if (body?.errors?.length) return body
        throw new Error('Failed to save prompt')
      }
      return body ?? { errors: [], warnings: [] }
    },
    onSuccess: (_result, variables) => {
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY })
      void queryClient.invalidateQueries({ queryKey: ['prompt', variables.id] })
    },
  })
}

export function useRevertPrompt() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/prompts/${id}/revert`, { method: 'POST' })
      if (!res.ok) await readError(res, 'Failed to revert prompt')
      return await res.json() as { id: string; current: string; modified: boolean }
    },
    onSuccess: (_result, id) => {
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY })
      void queryClient.invalidateQueries({ queryKey: ['prompt', id] })
    },
  })
}

export function useResetAllPrompts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/prompts/reset-all', { method: 'POST' })
      if (!res.ok) await readError(res, 'Failed to reset prompts')
      return await res.json() as { reset: boolean; templatesDir: string }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CATALOG_KEY })
      void queryClient.invalidateQueries({ queryKey: ['prompt'] })
    },
  })
}

export function usePromptPreview() {
  return useMutation({
    mutationFn: async ({ id, source }: { id: string; source: string }) => {
      const res = await fetch(`/api/prompts/${id}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      })
      if (!res.ok) await readError(res, 'Failed to build preview')
      return await res.json() as { preview: string }
    },
  })
}
