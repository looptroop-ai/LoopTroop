import type { ExecutionResult } from './executor';
import type { Bead } from '../beads/types';
import { compareBeadRecoveryOrder } from '../beads/recoveryOrder';
import { readBeadsFile } from '../beads/beadsFile';
import { getTicketPaths } from '../../storage/ticketQueries';
import { getLatestPhaseArtifact } from '../../storage/ticketArtifacts';

function getBeadExecutionArtifactType(beadId: string): string { return `bead_execution:${beadId}`; }

interface ExecutionCheckpointMetadata {
  beadId: string;
  iteration: number;
  startedAt: string;
  updatedAt: string;
  beadStartCommit: string | null;
}

type PersistedExecutionCheckpoint = ExecutionResult & {
  checkpoint?: ExecutionCheckpointMetadata;
};

export function isPersistedExecutionResult(
  value: unknown,
  beadId: string,
): value is ExecutionResult {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ExecutionResult>;
  return (
    candidate.beadId === beadId &&
    typeof candidate.success === "boolean" &&
    typeof candidate.iteration === "number" &&
    typeof candidate.output === "string" &&
    Array.isArray(candidate.errors) &&
    candidate.errors.every((entry) => typeof entry === "string") &&
    (candidate.errorCodes == null ||
      (Array.isArray(candidate.errorCodes) &&
        candidate.errorCodes.every((entry) => typeof entry === "string")))
  );
}

function getExecutionCheckpointMetadata(
  value: unknown,
): ExecutionCheckpointMetadata | null {
  if (!value || typeof value !== "object") return null;
  const checkpoint = (value as PersistedExecutionCheckpoint).checkpoint;
  if (!checkpoint || typeof checkpoint !== "object") return null;
  if (
    typeof checkpoint.beadId !== "string" ||
    typeof checkpoint.iteration !== "number" ||
    typeof checkpoint.startedAt !== "string" ||
    typeof checkpoint.updatedAt !== "string" ||
    !(
      checkpoint.beadStartCommit === null ||
      typeof checkpoint.beadStartCommit === "string"
    )
  ) {
    return null;
  }
  return checkpoint;
}

export function isCurrentExecutionCheckpoint(
  value: unknown,
  bead: Bead,
): value is PersistedExecutionCheckpoint {
  if (!isPersistedExecutionResult(value, bead.id)) return false;
  const checkpoint = getExecutionCheckpointMetadata(value);
  if (!checkpoint) return false;
  return (
    checkpoint.beadId === bead.id &&
    checkpoint.iteration === bead.iteration &&
    checkpoint.startedAt === bead.startedAt &&
    checkpoint.updatedAt === bead.updatedAt &&
    checkpoint.beadStartCommit === (bead.beadStartCommit ?? null)
  );
}

export function withExecutionCheckpoint(
  result: ExecutionResult,
  bead: Bead,
): PersistedExecutionCheckpoint {
  return {
    ...result,
    checkpoint: {
      beadId: bead.id,
      iteration: bead.iteration,
      startedAt: bead.startedAt,
      updatedAt: bead.updatedAt,
      beadStartCommit: bead.beadStartCommit ?? null,
    },
  };
}

export function findRecoverableSuccessfulCheckpoint(
  ticketId: string,
  beads: Bead[],
): Bead | null {
  const candidates = [...beads]
    .filter((bead) => bead.status === "error" || bead.status === "in_progress")
    .sort(compareBeadRecoveryOrder);

  for (const bead of candidates) {
    const executionArtifact = getLatestPhaseArtifact(
      ticketId,
      getBeadExecutionArtifactType(bead.id),
      "CODING",
    );
    if (!executionArtifact) continue;
    try {
      const parsed = JSON.parse(executionArtifact.content) as unknown;
      if (
        isPersistedExecutionResult(parsed, bead.id) &&
        parsed.success === true &&
        isCurrentExecutionCheckpoint(parsed, bead)
      ) {
        return bead;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function hasSuccessfulExecutionCheckpointForFinalization(ticketId: string): boolean {
  const paths = getTicketPaths(ticketId);
  if (!paths) return false;
  return findRecoverableSuccessfulCheckpoint(ticketId, readBeadsFile(paths.beadsPath)) !== null;
}
