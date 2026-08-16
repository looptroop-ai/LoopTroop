import { useQuery } from '@tanstack/react-query'

export type InstallChannel = 'npm' | 'bun' | 'pnpm' | 'yarn' | 'homebrew' | 'scoop' | 'chocolatey' | 'winget' | 'aur' | 'binary' | 'container' | 'source' | 'unknown'

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
  release: {
    version: string
    name: string
    url: string
    publishedAt: string | null
    notes: string
  } | null
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
