import { useQuery } from '@tanstack/react-query'
import { throwIfNotOk } from '@/lib/fetchError'

import type { InstallChannel, ReleaseDetails } from '@shared/installChannel'
export type { InstallChannel, ReleaseDetails }

export interface UpdateStatus {
  currentVersion: string
  latestVersion: string | null
  updateAvailable: boolean
  checkedAt: string | null
  installChannel: InstallChannel
  upgradeCommand: string
  upgradeFirst?: string
  postUpgradeCommand?: string
  upgradeNote?: string
  release: ReleaseDetails | null
}

// Exported so any module that needs to read or invalidate this cache names
// the key rather than repeating the literal — a second copy that drifts
// silently stops invalidating anything.
export const UPDATE_STATUS_QUERY_KEY = ['update-status'] as const

async function fetchUpdateStatus(signal?: AbortSignal): Promise<UpdateStatus> {
  const response = await fetch('/api/health/update', { signal })
  await throwIfNotOk(response, 'Failed to check for LoopTroop updates')
  return response.json()
}

export function useUpdateStatus() {
  return useQuery({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: ({ signal }) => fetchUpdateStatus(signal),
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: true,
  })
}
