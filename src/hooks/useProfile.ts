import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { GitHookPolicy } from '@/lib/executionSetupPlan'
import { normalizeGitHookPolicySetting } from '@/lib/gitHookPolicySetting'

interface Profile {
  id: number
  mainImplementer: string | null
  mainImplementerVariant: string | null
  councilMembers: string | null
  councilMemberVariants: string | null
  minCouncilQuorum: number
  perIterationTimeout: number
  executionSetupTimeout: number
  councilResponseTimeout: number
  interviewQuestions: number
  coverageFollowUpBudgetPercent: number
  maxCoveragePasses: number
  maxPrdCoveragePasses: number
  maxBeadsCoveragePasses: number
  structuredRetryCount: number
  maxIterations: number
  opencodeRetryLimit: number
  opencodeRetryDelay: number
  opencodeSteps: number
  toolInputMaxChars: number
  toolOutputMaxChars: number
  toolErrorMaxChars: number
  manualQaEnabled: boolean
  gitHookPolicy: GitHookPolicy
  createdAt: string
  updatedAt: string
}

interface CreateProfileInput {
  mainImplementer?: string
  mainImplementerVariant?: string
  councilMembers?: string
  councilMemberVariants?: string
  minCouncilQuorum?: number
  perIterationTimeout?: number
  executionSetupTimeout?: number
  councilResponseTimeout?: number
  interviewQuestions?: number
  coverageFollowUpBudgetPercent?: number
  maxCoveragePasses?: number
  maxPrdCoveragePasses?: number
  maxBeadsCoveragePasses?: number
  structuredRetryCount?: number
  maxIterations?: number
  opencodeRetryLimit?: number
  opencodeRetryDelay?: number
  opencodeSteps?: number
  toolInputMaxChars?: number
  toolOutputMaxChars?: number
  toolErrorMaxChars?: number
  manualQaEnabled?: boolean
  gitHookPolicy?: GitHookPolicy
}

async function fetchProfile(): Promise<Profile | null> {
  const res = await fetch('/api/profile')
  if (!res.ok) throw new Error('Failed to fetch profile')
  const profile = await res.json() as Profile | null
  return profile
    ? {
        ...profile,
        gitHookPolicy: normalizeGitHookPolicySetting(profile.gitHookPolicy) ?? 'validate_advisory',
      }
    : null
}

async function createProfile(input: CreateProfileInput): Promise<Profile> {
  const res = await fetch('/api/profile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error || 'Failed to create profile')
  }
  const profile = await res.json() as Profile
  return {
    ...profile,
    gitHookPolicy: normalizeGitHookPolicySetting(profile.gitHookPolicy) ?? 'validate_advisory',
  }
}

async function updateProfile(input: Partial<CreateProfileInput>): Promise<Profile> {
  const res = await fetch('/api/profile', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const err = await res.json()
    throw new Error(err.error || 'Failed to update profile')
  }
  const profile = await res.json() as Profile
  return {
    ...profile,
    gitHookPolicy: normalizeGitHookPolicySetting(profile.gitHookPolicy) ?? 'validate_advisory',
  }
}

export function useProfile() {
  return useQuery({
    queryKey: ['profile'],
    queryFn: fetchProfile,
    staleTime: Infinity,
  })
}

export function useCreateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: createProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export function useUpdateProfile() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: updateProfile,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profile'] })
    },
  })
}

export type { Profile, CreateProfileInput }
