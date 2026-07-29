import { FileText, CheckCircle2, Trophy } from 'lucide-react'
import type { ArtifactDef } from './phaseArtifactTypes'

export function getSupplementalArtifacts(phase: string, isCompleted = false): ArtifactDef[] {
  if (phase === 'COUNCIL_VOTING_INTERVIEW') {
    return [
      { id: 'vote-details', label: 'Voting Details', description: 'Weighted scoring across all council votes', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'winner-draft', label: 'Winning Draft', description: 'Highest-scored interview draft', icon: <Trophy className="h-3.5 w-3.5" /> },
    ]
  }
  if (phase === 'COMPILING_INTERVIEW') {
    return [{ id: 'final-interview', label: 'Final Interview Results', description: 'Interview refined by the winning model', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'WAITING_INTERVIEW_ANSWERS') {
    return [
      { id: 'final-interview', label: 'Final Interview Results', description: 'Interview refined by the winning model', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'interview-answers', label: 'Interview Answers', description: 'User responses', icon: <FileText className="h-3.5 w-3.5" /> },
    ]
  }
  if (phase === 'VERIFYING_INTERVIEW_COVERAGE' || phase === 'WAITING_INTERVIEW_APPROVAL') {
    return [{ id: 'final-interview', label: 'Interview Results', description: 'Canonical interview questions and answers', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'COUNCIL_VOTING_PRD') {
    return [
      { id: 'vote-details', label: 'Voting Details', description: 'Weighted scoring across all council votes', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'winner-prd-draft', label: 'Winning PRD Draft', description: 'Highest-scored PRD draft', icon: <Trophy className="h-3.5 w-3.5" /> },
    ]
  }
  if (phase === 'REFINING_PRD') {
    return [{ id: 'final-prd-draft', label: 'PRD Candidate v1', description: 'Initial PRD candidate consolidated from the winning draft', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'DRAFTING_PRD') {
    return []
  }
  if (phase === 'VERIFYING_PRD_COVERAGE' || phase === 'WAITING_PRD_APPROVAL') {
    return [{ id: 'refined-prd', label: 'PRD Candidate', description: 'Latest PRD candidate under coverage review', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'REFINING_BEADS') {
    return [{ id: 'final-beads-draft', label: 'Final Blueprint Draft', description: 'Semantic blueprint consolidated from the winning draft with the strongest ideas from the losing drafts.', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'COUNCIL_VOTING_BEADS') {
    return [
      { id: 'vote-details', label: 'Voting Details', description: 'Weighted scoring across all council votes', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'winner-beads-draft', label: 'Winning Beads Draft', description: 'Highest-scored beads draft', icon: <Trophy className="h-3.5 w-3.5" /> },
    ]
  }
  if (phase === 'VERIFYING_BEADS_COVERAGE' || phase === 'EXPANDING_BEADS' || phase === 'WAITING_BEADS_APPROVAL') {
    return [{ id: 'refined-beads', label: 'Refined Beads', description: 'Latest blueprint candidate — semantic during coverage review, expanded into execution-ready beads after expansion.', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'SCANNING_RELEVANT_FILES') {
    return [{ id: 'relevant-files-scan', label: 'Relevant Files', description: 'Source files identified as relevant by AI analysis', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'PRE_FLIGHT_CHECK') {
    return [{ id: 'diagnostics', label: 'Doctor Diagnostics', description: 'Pre-flight validation report', icon: <CheckCircle2 className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'GENERATING_EXECUTION_SETUP_PLAN') {
    return [
      { id: 'execution-setup-plan', label: 'Workspace Setup Plan', description: 'Full generated readiness assessment and workspace setup contract', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'execution-setup-plan-report', label: 'Generation Report', description: 'Structured-output validation, raw attempts, diagnostics, and regeneration context', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    ]
  }
  if (phase === 'WAITING_EXECUTION_SETUP_APPROVAL') {
    return []
  }
  if (phase === 'PREPARING_EXECUTION_ENV') {
    return [
      { id: 'execution-setup-runtime', label: 'Execution Setup Runtime', description: 'Reusable setup profile, attempt history, and final setup status', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
    ]
  }
  if (phase === 'CODING') {
    return isCompleted
      ? [{ id: 'bead-commits', label: 'Bead Commits', description: 'Per-bead/file git commits', icon: <FileText className="h-3.5 w-3.5" /> }]
      : []
  }
  if (phase === 'RUNNING_FINAL_TEST') {
    return [{ id: 'test-results', label: 'Test Results', description: 'Full test suite results', icon: <CheckCircle2 className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'GENERATING_QA_CHECKLIST') {
    return [{ id: 'manual-qa-checklist', label: 'Manual QA Checklist', description: 'Generated user-run checks and their expected results', icon: <CheckCircle2 className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'WAITING_MANUAL_QA') {
    return [{ id: 'manual-qa', label: 'Manual QA', description: 'Versioned checklist, advisory coverage, submitted results, and evidence references', icon: <CheckCircle2 className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'INTEGRATING_CHANGES') {
    return [{ id: 'commit-summary', label: 'Commit Summary', description: 'Squashed commit history', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'CREATING_PULL_REQUEST') {
    return [{ id: 'pull-request-report', label: 'Pull Request Report', description: 'Draft pull request metadata and body', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  if (phase === 'WAITING_PR_REVIEW') {
    return [
      { id: 'test-results', label: 'Test Results', description: 'Full test suite results', icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
      { id: 'commit-summary', label: 'Integration Report', description: 'Squash commit and integration details', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'pull-request-report', label: 'Pull Request Report', description: 'Draft pull request metadata and body', icon: <FileText className="h-3.5 w-3.5" /> },
      { id: 'bead-commits', label: 'Bead Commits', description: 'Per-bead/file git commits', icon: <FileText className="h-3.5 w-3.5" /> },
    ]
  }
  if (phase === 'CLEANING_ENV') {
    return [{ id: 'cleanup-report', label: 'Cleanup Report', description: 'Resource cleanup', icon: <FileText className="h-3.5 w-3.5" /> }]
  }
  return []
}
