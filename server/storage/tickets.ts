// Barrel re-exports – all public API from sub-modules
export type {
  PublicTicket,
  PublicPhaseArtifactRow,
  TicketContext,
  TicketErrorOccurrence,
  TicketErrorResolutionStatus,
} from './ticketQueries'
export type { PublicTicketPhaseAttemptRow } from './ticketPhaseAttempts'
export {
  buildTicketRef,
  DISPLAY_ONLY_MOCK_BRANCH_NAME,
  parseTicketRef,
  isDisplayOnlyMockTicket,
  listTickets,
  getTicketByRef,
  findTicketRefByLocalId,
  getTicketContext,
  resolveTicketContinuationCandidate,
  getTicketStorageContext,
  listNonTerminalTickets,
  getTicketPaths,
  findProjectExecutionBandConflict,
  parseLockedCouncilMembers,
  parseLockedCouncilMemberVariants,
} from './ticketQueries'

export {
  createTicket,
  createManualQaImprovementTicket,
  updateTicket,
  patchTicket,
  recordTicketErrorOccurrence,
  resolveLatestTicketErrorOccurrence,
  lockTicketStartConfiguration,
  deleteTicket,
  cleanupCanceledTicketData,
} from './ticketMutations'

export {
  listPhaseArtifacts,
  listArtifactManifest,
  getPhaseArtifactById,
  toArtifactManifestEntry,
  getLatestPhaseArtifact,
  countPhaseArtifacts,
  insertPhaseArtifact,
  upsertLatestPhaseArtifact,
} from './ticketArtifacts'

export {
  INTERVIEW_EDIT_RESTART_PHASES,
  PRD_EDIT_RESTART_PHASES,
  EXECUTION_SETUP_PLAN_RESTART_PHASES,
  EXECUTION_SETUP_RUNTIME_REWIND_PHASES,
  isAttemptTrackedPhase,
  getActivePhaseAttempt,
  resolvePhaseAttempt,
  ensureActivePhaseAttempt,
  listPhaseAttempts,
  archiveActivePhaseAttempts,
  createFreshPhaseAttempts,
} from './ticketPhaseAttempts'
