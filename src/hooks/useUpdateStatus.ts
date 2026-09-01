import { useQuery } from '@tanstack/react-query'

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

export const UPDATE_STATUS_QUERY_KEY = ['update-status'] as const

async function fetchUpdateStatus(): Promise<UpdateStatus> {
  const response = await fetch('/api/health/update')
  if (!response.ok) throw new Error('Failed to check for LoopTroop updates')
  return response.json()
}

export function useUpdateStatus() {
  return useQuery({
    queryKey: UPDATE_STATUS_QUERY_KEY,
    queryFn: fetchUpdateStatus,
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: true,
  })
}
