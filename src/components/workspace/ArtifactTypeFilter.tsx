import type React from 'react'
import type { ArtifactDef, CouncilOutcome } from './phaseArtifactTypes'
import {
  type CouncilAction,
} from './councilArtifacts'
import { CouncilStatusIcon } from './CouncilStatusIcon'

export interface ArtifactTypeFilterProps {
  artifacts: ArtifactDef[]
  getArtifactState: (artifact: ArtifactDef) => { outcome?: CouncilOutcome; detail?: React.ReactNode }
  action: CouncilAction
  isCompleted: boolean
  onSelect: (id: string) => void
  variant: 'prominent' | 'inline'
}

export function ArtifactTypeFilter({ artifacts, getArtifactState, action, isCompleted, onSelect, variant }: ArtifactTypeFilterProps) {
  if (artifacts.length === 0) return null

  return (
    <>
      {artifacts.map((artifact) => {
        const artifactState = getArtifactState(artifact)
        const statusOutcome = artifactState.outcome ?? (isCompleted ? 'completed' : undefined)

        if (variant === 'prominent') {
          return (
            <button
              key={artifact.id}
              onClick={() => onSelect(artifact.id)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/50 bg-muted/40 px-2.5 py-1.5 text-xs text-foreground shadow-2xs transition-all hover:bg-muted/70 active:scale-[0.98] whitespace-nowrap"
            >
              <span className="text-muted-foreground">{artifact.icon}</span>
              <div className="text-left">
                <span className="font-mono font-medium">{artifact.label}</span>
                {artifactState.detail && <div className="max-w-[28rem] whitespace-normal break-all text-[10px] text-blue-500">{artifactState.detail}</div>}
              </div>
              <CouncilStatusIcon outcome={statusOutcome} action={action} className="ml-auto h-3 w-3" />
            </button>
          )
        }

        return (
          <button
            key={artifact.id}
            onClick={() => onSelect(artifact.id)}
            className="flex items-center gap-1.5 rounded-lg border border-border/70 px-2.5 py-1.5 hover:bg-muted/30 cursor-pointer transition-all active:scale-[0.98] text-xs whitespace-nowrap shadow-2xs"
          >
            <span className="text-muted-foreground">{artifact.icon}</span>
            <div className="text-left">
              <span className="font-mono font-medium">{artifact.label}</span>
              {artifactState.detail && <div className="max-w-[28rem] whitespace-normal break-all text-[10px] text-blue-500">{artifactState.detail}</div>}
            </div>
            <CouncilStatusIcon outcome={statusOutcome} action={action} className="ml-auto h-3 w-3" />
          </button>
        )
      })}
    </>
  )
}
