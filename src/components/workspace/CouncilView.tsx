import { useMemo } from 'react'
import { Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { PhaseArtifactsPanel } from './PhaseArtifactsPanel'
import { CollapsiblePhaseLogSection } from './CollapsiblePhaseLogSection'
import { useTicketArtifactBundle, type TicketArtifactQueryScope } from '@/hooks/useTicketArtifacts'
import { PhaseAttemptSelector, PhaseAttemptsUnavailable } from './PhaseAttemptSelector'
import { useSelectedPhaseAttempt } from './useSelectedPhaseAttempt'
import { getModelDisplayName } from '@/components/shared/modelBadgeUtils'
import {
  findLatestArtifact,
  findLatestCompanionArtifact,
  mergeDraftArtifactContent,
  mergeVoteArtifactContent,
} from './artifactCompanionUtils'
import { isRecord } from '@shared/typeGuards'
import { getArtifactSourcePhases } from './phaseArtifactTypes'

import type { Ticket } from '@/hooks/useTickets'
import type { TicketArtifact } from '@/hooks/useTicketArtifacts'

interface VoteLike {
  voterId: string
  draftId: string
  totalScore: number
}

interface CouncilResultLike {
  votes?: VoteLike[]
  winnerId?: string
  voterOutcomes?: Record<string, string>
}

function getPhaseDomain(phase: string): 'interview' | 'prd' | 'beads' | null {
  if (phase.includes('INTERVIEW') || phase === 'COUNCIL_DELIBERATING' || phase === 'COMPILING_INTERVIEW') return 'interview'
  if (phase.includes('PRD')) return 'prd'
  if (phase.includes('BEADS')) return 'beads'
  return null
}

function parseCouncilResult(content: string | null | undefined): CouncilResultLike | null {
  if (!content) return null
  try {
    const parsed = JSON.parse(content) as unknown
    if (isRecord(parsed) && (parsed.drafts || parsed.votes || parsed.voterOutcomes || parsed.winnerId)) {
      return parsed as CouncilResultLike
    }
  } catch {
    return null
  }
  return null
}

interface VoteSummary {
  completedCount: number
  total: number
  leaderLabel: 'Leading' | 'Winner'
  leaderModelId: string
  leaderTotal: number
}

function deriveVoteSummary(phase: string, artifacts: TicketArtifact[]): VoteSummary | null {
  const domain = getPhaseDomain(phase)
  if (!domain) return null
  const voteArtifact = findLatestArtifact(
    artifacts,
    (artifact) => artifact.phase === phase && artifact.artifactType === `${domain}_votes`,
  )
  if (!voteArtifact) return null
  const voteCompanion = findLatestCompanionArtifact(artifacts, `${domain}_votes`, [phase])
  const draftArtifact = findLatestArtifact(artifacts, (artifact) => artifact.artifactType === `${domain}_drafts`)
  const draftCompanion = findLatestCompanionArtifact(artifacts, `${domain}_drafts`)
  const mergedDraft = mergeDraftArtifactContent(draftArtifact?.content, draftCompanion?.content)
  const mergedVote = mergeVoteArtifactContent(voteArtifact.content, voteCompanion?.content, mergedDraft)
  const result = parseCouncilResult(mergedVote)
  if (!result) return null
  const votes = Array.isArray(result.votes) ? result.votes : []
  const voterOutcomes = result.voterOutcomes ?? {}
  const voterIds = [
    ...Object.keys(voterOutcomes),
    ...votes.map((vote) => vote.voterId),
  ].filter((voterId, index, values) => Boolean(voterId) && values.indexOf(voterId) === index)
  if (voterIds.length === 0) return null
  const completedCount = voterIds.filter((voterId) => {
    const outcome = voterOutcomes[voterId]
    if (outcome === 'completed' || outcome === 'failed' || outcome === 'timed_out' || outcome === 'invalid_output' || outcome === 'pending') {
      return outcome === 'completed'
    }
    return votes.some((vote) => vote.voterId === voterId)
  }).length
  const totalsByDraft = new Map<string, number>()
  for (const vote of votes) {
    if (!vote.draftId) continue
    totalsByDraft.set(vote.draftId, (totalsByDraft.get(vote.draftId) ?? 0) + (typeof vote.totalScore === 'number' ? vote.totalScore : 0))
  }
  const draftScores = [...totalsByDraft.entries()]
    .map(([draftId, total]) => ({ draftId, total }))
    .sort((a, b) => b.total - a.total)
  const winnerId = typeof result.winnerId === 'string' && result.winnerId.trim() ? result.winnerId.trim() : ''
  const winnerTotal = winnerId ? totalsByDraft.get(winnerId) : undefined
  if (winnerId && winnerTotal !== undefined) {
    return { completedCount, total: voterIds.length, leaderLabel: 'Winner', leaderModelId: winnerId, leaderTotal: winnerTotal }
  }
  if (draftScores.length === 0) return null
  const leader = draftScores[0]!
  return { completedCount, total: voterIds.length, leaderLabel: 'Leading', leaderModelId: leader.draftId, leaderTotal: leader.total }
}

interface CouncilViewProps {
  phase: string
  ticket: Ticket
}

function getCouncilStepLabel(phase: string): string {
  if (phase === 'SCANNING_RELEVANT_FILES') return 'Scanning'
  if (phase === 'EXPANDING_BEADS') return 'Expanding'
  if (phase.includes('DELIBERATING') || phase.includes('DRAFTING')) return 'Drafting'
  if (phase.includes('VOTING')) return 'Voting'
  if (phase.includes('COMPILING') || phase.includes('REFINING')) return 'Refining'
  if (phase.includes('VERIFYING')) return 'Verifying Coverage'
  return 'Processing'
}

function getCouncilDomain(phase: string): string {
  if (phase === 'SCANNING_RELEVANT_FILES') return 'Relevant Files'
  if (phase.includes('INTERVIEW') || phase === 'COUNCIL_DELIBERATING' || phase === 'COMPILING_INTERVIEW' || phase === 'VERIFYING_INTERVIEW_COVERAGE') return 'Interview'
  if (phase.includes('PRD')) return 'PRD'
  if (phase.includes('BEADS')) return 'Beads'
  return ''
}

export function CouncilView({ phase, ticket }: CouncilViewProps) {
  const step = getCouncilStepLabel(phase)
  const domain = getCouncilDomain(phase)
  const isDrafting = step === 'Drafting'
  const isVoting = step === 'Voting'
  const isVerifying = step === 'Verifying Coverage'
  const isExpanding = step === 'Expanding'
  const {
    attempts,
    selectedAttempt,
    setManualSelectedAttemptNumber,
    archivedAttemptNumber,
    logPhaseAttempt,
    logMode,
    isError: isAttemptsError,
    error: attemptsError,
    refetch: refetchAttempts,
    isPhaseVersionUnknown,
  } = useSelectedPhaseAttempt(ticket.id, phase)
  const artifactScopes = useMemo<TicketArtifactQueryScope[]>(() => {
    if (!selectedAttempt) return []
    if (selectedAttempt.state === 'archived') {
      return [{ phase, phaseAttempt: selectedAttempt.attemptNumber }]
    }
    return getArtifactSourcePhases(phase).map((sourcePhase) => sourcePhase === phase
      ? { phase, phaseAttempt: selectedAttempt.attemptNumber }
      : { phase: sourcePhase })
  }, [phase, selectedAttempt])
  const artifactState = useTicketArtifactBundle(ticket.id, artifactScopes)
  const phaseArtifacts = useMemo(() => artifactState.artifacts ?? [], [artifactState.artifacts])
  const councilMemberNames = useMemo(
    () => ticket.lockedCouncilMembers,
    [ticket],
  )
  const councilMemberCount = councilMemberNames.length || 3
  const isLiveVoting = isVoting && archivedAttemptNumber == null
  const voteSummary = useMemo(
    () => (isLiveVoting ? deriveVoteSummary(phase, phaseArtifacts) : null),
    [isLiveVoting, phase, phaseArtifacts],
  )

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-2 space-y-1.5 shrink-0">
        {isAttemptsError ? (
          <PhaseAttemptsUnavailable error={attemptsError} onRetry={() => void refetchAttempts()} />
        ) : null}
        {attempts.length > 1 ? (
          <PhaseAttemptSelector
            attempts={attempts}
            value={selectedAttempt?.attemptNumber ?? attempts[0]!.attemptNumber}
            onChange={setManualSelectedAttemptNumber}
          />
        ) : null}

        <Card>
          <CardHeader className="px-3 py-1.5">
            <CardTitle className="text-[13px] flex items-center gap-1.5">
              {archivedAttemptNumber == null ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              AI Council — {domain} {step}
            </CardTitle>
          </CardHeader>
          <CardContent className="px-3 pb-1.5 pt-0">
            <p className="text-[11px] leading-[15px] text-muted-foreground">
              {phase === 'SCANNING_RELEVANT_FILES' && 'AI is reading relevant source files to build richer context for council deliberation.'}
              {isDrafting && phase !== 'SCANNING_RELEVANT_FILES' && `Each council model is independently generating a ${domain.toLowerCase()} draft.`}
              {isVoting && `Council members are scoring all ${domain.toLowerCase()} drafts.`}
              {step === 'Refining' && `Winning model incorporates best ideas from other drafts.`}
              {isVerifying && `Winning model verifies ${domain.toLowerCase()} covers all requirements.`}
              {isExpanding && 'Winning model expands the validated implementation plan into execution-ready bead records.'}
              {voteSummary && (
                <span className="font-semibold">
                  {' · '}
                  {voteSummary.completedCount}/{voteSummary.total} complete ·{' '}
                  <span className={voteSummary.leaderLabel === 'Winner' ? 'text-primary font-bold' : undefined}>
                    {voteSummary.leaderLabel}: {getModelDisplayName(voteSummary.leaderModelId)} · {voteSummary.leaderTotal} pts
                  </span>
                </span>
              )}
            </p>
          </CardContent>
        </Card>

        {/* Which attempt these belong to is unknown while the history request
            is failing with nothing cached, and artifacts and logs are scoped by
            it — they would be shown as the live version, which may not be the
            one the reader selected. The notice above says why they are gone. */}
        {isPhaseVersionUnknown ? null : (
          <PhaseArtifactsPanel
            phase={phase}
            isCompleted={false}
            ticketId={ticket.id}
            councilMemberCount={councilMemberCount}
            councilMemberNames={councilMemberNames.length > 0 ? councilMemberNames : undefined}
            artifactState={artifactState}
          />
        )}
      </div>

      {isPhaseVersionUnknown ? null : (
        <CollapsiblePhaseLogSection
          phase={phase}
          phaseAttempt={logPhaseAttempt}
          logMode={logMode}
          ticket={ticket}
          className="px-4 pb-4"
        />
      )}
    </div>
  )
}
