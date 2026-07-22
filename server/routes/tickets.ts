import { Hono } from 'hono'
import {
  handleListTickets,
  handleGetTicket,
  handleGetTicketSize,
  handleGetUiState,
  handlePutUiState,
  handleCreateTicket,
  handlePatchTicket,
  handleDeleteTicket,
  handleStartTicket,
  handleApproveTicket,
  handleCancelTicket,
  handleAnswerTicket,
  handleSkipTicket,
  handleAnswerBatch,
  handleEditAnswer,
  handleApproveInterview,
  handleApprovePrd,
  handleApproveBeads,
  handleApproveExecutionSetupPlan,
  handleFixCoverageGaps,
  handleMergeTicket,
  handleCloseUnmergedTicket,
  handleVerifyTicket,
  handleRetryTicket,
  handleContinueTicket,
  handleListAllOpenCodeQuestions,
  handleListOpenCodeQuestions,
  handleReplyOpenCodeQuestion,
  handleRejectOpenCodeQuestion,
  handleDevEvent,
  handleGetInterview,
  handleGetExecutionSetupPlan,
  handleEditBlockedExecutionSetupPlan,
  handlePutInterview,
  handlePutInterviewAnswers,
  handlePutExecutionSetupPlan,
  handleRegenerateExecutionSetupPlan,
  handleGetArtifacts,
  handleGetArtifactManifest,
  handleGetArtifactContent,
  handlePostArtifactContentBatch,
  handleListPhaseAttempts,
  handleGetManualQa,
  handleGetManualQaVersion,
  handleUploadManualQaEvidence,
  handleReadManualQaEvidence,
  handleRemoveManualQaEvidence,
  handleSubmitManualQa,
  handleSkipManualQa,
  handleIncludeManualQaDrift,
  handleDiscardManualQaDrift,
  handleGetTicketLogs,
  handleExportTicketLogs,
} from './ticketHandlers'

const ticketRouter = new Hono()

ticketRouter.get('/tickets', (c) => handleListTickets(c))
ticketRouter.get('/tickets/:id', (c) => handleGetTicket(c))
ticketRouter.get('/tickets/:id/size', async (c) => handleGetTicketSize(c))
ticketRouter.get('/tickets/:id/ui-state', (c) => handleGetUiState(c))
ticketRouter.put('/tickets/:id/ui-state', async (c) => handlePutUiState(c))
ticketRouter.post('/tickets', async (c) => handleCreateTicket(c))
ticketRouter.patch('/tickets/:id', async (c) => handlePatchTicket(c))
ticketRouter.delete('/tickets/:id', async (c) => handleDeleteTicket(c))
ticketRouter.post('/tickets/:id/start', async (c) => handleStartTicket(c))
ticketRouter.post('/tickets/:id/approve', (c) => handleApproveTicket(c))
ticketRouter.post('/tickets/:id/cancel', (c) => handleCancelTicket(c))
ticketRouter.post('/tickets/:id/answer', async (c) => handleAnswerTicket(c))
ticketRouter.post('/tickets/:id/skip', async (c) => handleSkipTicket(c))
ticketRouter.post('/tickets/:id/answer-batch', async (c) => handleAnswerBatch(c))
ticketRouter.patch('/tickets/:id/edit-answer', async (c) => handleEditAnswer(c))
ticketRouter.put('/tickets/:id/interview', async (c) => handlePutInterview(c))
ticketRouter.put('/tickets/:id/interview-answers', async (c) => handlePutInterviewAnswers(c))
ticketRouter.get('/tickets/:id/execution-setup-plan', (c) => handleGetExecutionSetupPlan(c))
ticketRouter.post('/tickets/:id/edit-execution-setup-plan', async (c) => handleEditBlockedExecutionSetupPlan(c))
ticketRouter.put('/tickets/:id/execution-setup-plan', async (c) => handlePutExecutionSetupPlan(c))
ticketRouter.post('/tickets/:id/regenerate-execution-setup-plan', async (c) => handleRegenerateExecutionSetupPlan(c))
ticketRouter.post('/tickets/:id/approve-interview', (c) => handleApproveInterview(c))
ticketRouter.post('/tickets/:id/approve-prd', (c) => handleApprovePrd(c))
ticketRouter.post('/tickets/:id/approve-beads', (c) => handleApproveBeads(c))
ticketRouter.post('/tickets/:id/approve-execution-setup-plan', (c) => handleApproveExecutionSetupPlan(c))
ticketRouter.post('/tickets/:id/coverage/fix-gaps', async (c) => handleFixCoverageGaps(c))
ticketRouter.post('/tickets/:id/merge', (c) => handleMergeTicket(c))
ticketRouter.post('/tickets/:id/close-unmerged', (c) => handleCloseUnmergedTicket(c))
ticketRouter.post('/tickets/:id/verify', (c) => handleVerifyTicket(c))
ticketRouter.post('/tickets/:id/retry', async (c) => handleRetryTicket(c))
ticketRouter.post('/tickets/:id/continue', async (c) => handleContinueTicket(c))
ticketRouter.get('/opencode/questions', (c) => handleListAllOpenCodeQuestions(c))
ticketRouter.get('/tickets/:id/opencode/questions', (c) => handleListOpenCodeQuestions(c))
ticketRouter.post('/tickets/:id/opencode/questions/:requestId/reply', (c) => handleReplyOpenCodeQuestion(c))
ticketRouter.post('/tickets/:id/opencode/questions/:requestId/reject', (c) => handleRejectOpenCodeQuestion(c))
ticketRouter.post('/tickets/:id/dev-event', async (c) => handleDevEvent(c))
ticketRouter.get('/tickets/:id/interview', (c) => handleGetInterview(c))
ticketRouter.get('/tickets/:id/artifacts', (c) => handleGetArtifacts(c))
ticketRouter.get('/tickets/:id/logs', (c) => handleGetTicketLogs(c))
ticketRouter.get('/tickets/:id/logs/export', (c) => handleExportTicketLogs(c))
ticketRouter.get('/tickets/:id/artifacts/manifest', (c) => handleGetArtifactManifest(c))
ticketRouter.get('/tickets/:id/artifacts/:artifactId/content', (c) => handleGetArtifactContent(c))
ticketRouter.post('/tickets/:id/artifacts/content/batch', async (c) => handlePostArtifactContentBatch(c))
ticketRouter.get('/tickets/:id/phases/:phase/attempts', (c) => handleListPhaseAttempts(c))
ticketRouter.get('/tickets/:id/manual-qa', (c) => handleGetManualQa(c))
ticketRouter.get('/tickets/:id/manual-qa/versions/:version', (c) => handleGetManualQaVersion(c))
ticketRouter.put('/tickets/:id/manual-qa/versions/:version/evidence', (c) => handleUploadManualQaEvidence(c))
ticketRouter.get('/tickets/:id/manual-qa/versions/:version/evidence/:itemId/:evidenceId', (c) => handleReadManualQaEvidence(c))
ticketRouter.delete('/tickets/:id/manual-qa/versions/:version/evidence/:itemId/:evidenceId', (c) => handleRemoveManualQaEvidence(c))
ticketRouter.post('/tickets/:id/manual-qa/submit', (c) => handleSubmitManualQa(c))
ticketRouter.post('/tickets/:id/manual-qa/skip', (c) => handleSkipManualQa(c))
ticketRouter.post('/tickets/:id/manual-qa/workspace-drift/include', (c) => handleIncludeManualQaDrift(c))
ticketRouter.post('/tickets/:id/manual-qa/workspace-drift/discard', (c) => handleDiscardManualQaDrift(c))

export { ticketRouter }
