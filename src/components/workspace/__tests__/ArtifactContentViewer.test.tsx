import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render as baseRender, screen, within } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { encode } from 'gpt-tokenizer'
import { deriveStructuredInterventions } from '@shared/structuredInterventions'
import { ArtifactContent, BeadsDraftView, CollapsibleSection, InterviewAnswersView } from '../ArtifactContentViewer'
import { buildArtifactProcessingNoticeCopy } from '../artifactProcessingNotice'
import { serializeBeadCommitsDiffContent } from '../diffUtils'
import type { ArtifactStructuredOutputData } from '../phaseArtifactTypes'
import { LogContext } from '@/context/logContextDef'
import type { LogContextValue, LogEntry } from '@/context/logUtils'
import { TEST } from '@/test/factories'
import {
  buildBeadsDraftContent,
  buildCanonicalInterviewContent,
  buildExecutionSetupPlanContent,
  buildExecutionSetupPlanReportContent,
  buildExecutionSetupProfileContent,
  buildExecutionSetupRuntimeReportContent,
  buildInterviewDocumentContent,
  buildPrdDocumentContent,
} from '@/test/workspaceArtifactBuilders'
import { TooltipProvider } from '@/components/ui/tooltip'

function render(ui: ReactNode) {
  return baseRender(<TooltipProvider>{ui}</TooltipProvider>)
}

async function clickCopyRawOutput() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Copy raw output' }))
    await Promise.resolve()
  })
}

function openFoundationGroup() {
  fireEvent.click(screen.getByText('Foundation').closest('button')!)
}

function hasExactTextContent(text: string) {
  return (_content: string, element: Element | null) => element?.textContent === text
}

function hasTextContent(text: string) {
  return (_content: string, element: Element | null) => element?.textContent?.includes(text) ?? false
}

function openNotice(title: string) {
  fireEvent.click(screen.getByText(title).closest('button')!)
}

function mockClipboard() {
  const writeTextMock = vi.fn(() => Promise.resolve())
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: writeTextMock },
  })
  return writeTextMock
}

const LONG_EXPANDING_BLUEPRINT_TOKEN = `expanded-${'executionfield'.repeat(24)}`
const LONG_GLOBAL_THEME_PROMPT = 'For this test ticket, is the goal simply to replace the current default global theme with a pink-based one for all users, with no runtime theme switching?'
const LONG_PALETTE_PROMPT = 'For this test ticket, is the goal simply to replace the current default app palette with a single pink palette (no theme switcher), and is that the full definition of done?'

function futureStructuredOutput(output: ArtifactStructuredOutputData): ArtifactStructuredOutputData {
  const repairWarnings = output.repairWarnings ?? []
  const autoRetryCount = output.autoRetryCount ?? 0
  const validationError = output.validationError
  const interventions = output.interventions ?? deriveStructuredInterventions({
    repairWarnings,
    autoRetryCount,
    validationError,
  })

  return {
    ...output,
    repairApplied: output.repairApplied ?? (repairWarnings.length > 0 || autoRetryCount > 0 || Boolean(validationError)),
    repairWarnings,
    autoRetryCount,
    interventions,
  }
}

function makeLogEntry(line: string, options: Partial<LogEntry> = {}): LogEntry {
  return {
    id: options.id ?? line,
    entryId: options.entryId ?? options.id ?? line,
    line,
    source: options.source ?? 'system',
    status: options.status ?? 'DRAFTING_PRD',
    audience: options.audience ?? 'all',
    kind: options.kind ?? 'milestone',
    streaming: options.streaming ?? false,
    op: options.op ?? 'append',
    ...(options.timestamp ? { timestamp: options.timestamp } : {}),
    ...(options.modelId ? { modelId: options.modelId } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  }
}

function renderWithLogContext(ui: ReactElement, logsByPhase: Record<string, LogEntry[]>) {
  const value: LogContextValue = {
    logsByPhase,
    activePhase: null,
    isLoadingLogs: false,
    addLog: vi.fn(),
    addLogRecord: vi.fn(),
    getLogsForPhase: (phase) => logsByPhase[phase] ?? [],
    getAllLogs: () => Object.values(logsByPhase).flat(),
    setActivePhase: vi.fn(),
    clearLogs: vi.fn(),
  }
  return render(<LogContext.Provider value={value}>{ui}</LogContext.Provider>)
}

describe('ArtifactContentViewer', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scrolls a section into view when it is expanded', () => {
    render(
      <CollapsibleSection title="Expandable">
        <div>Expanded body</div>
      </CollapsibleSection>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Expandable/i }))

    expect(screen.getByText('Expanded body')).toBeInTheDocument()
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('renders Manual QA checklists as readable cards with the canonical YAML in Raw', () => {
    const checklist = `schema_version: 1
artifact: manual_qa_checklist
version: 2
generated_at: 2026-07-14T10:00:00.000Z
not_applicable_prd_refs:
  - ref: EP-2/ST-1/AC-3
    reason: Verified only by the build pipeline.
items:
  - id: QA-v2-1
    lineage_id: checkout-submit
    title: Submit checkout
    source: prd
    behavior: A valid checkout can be submitted.
    severity: required
    recheck_state: pending_recheck
    prerequisites:
      - Open a populated cart.
    actions:
      - Select Checkout.
      - Confirm the order.
    expected_result: The confirmation page displays the order number.
    watch_notes:
      - The submit button must not remain busy.
    bead_refs: [BEAD-2]
    prd_refs:
      - ref: EP-1/ST-1/AC-1
        coverage: full
`
    render(<ArtifactContent artifactId="manual-qa-checklist" content={JSON.stringify({ version: 2, checklist })} />)

    expect(screen.getByRole('button', { name: 'Checklist' })).toBeInTheDocument()
    expect(screen.getByText('1 check')).toBeInTheDocument()
    expect(screen.getByText('1. Submit checkout')).toBeInTheDocument()
    expect(screen.getByText('The confirmation page displays the order number.')).toBeInTheDocument()
    expect(screen.getByText('Not applicable to Manual QA')).toBeInTheDocument()
    expect(screen.getByText('Verified only by the build pipeline.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText((_, element) => element?.tagName === 'PRE' && element.textContent === checklist)).toBeInTheDocument()
  })

  it('shows Manual QA provenance in bead artifacts while keeping retry notes separate', () => {
    render(<BeadsDraftView content={JSON.stringify({ beads: [{
      id: 'QA-v2-1', title: 'Fix checkout', priority: 1, status: 'pending', notes: 'Retry note',
      qaOrigin: {
        schemaVersion: 1, actionId: 'action-1', sourceTicketId: '1:APP-1', sourceTicketExternalId: 'APP-1', version: 2, imageDelivery: 'references_only',
        sourceItems: [{ itemId: 'item-1', lineageId: 'checkout', behavior: 'Checkout submits', observation: 'Nothing happened', expectedResult: 'Order is created', evidence: [{ id: 'ev-1', originalName: 'screen.png', mediaType: 'image/png', size: 10, sha256: 'a'.repeat(64), relativePath: 'screen.png' }], links: [] }],
      },
    }] })} />)

    expect(screen.getByText('Manual QA Fix · v2')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Fix checkout/ }))
    expect(screen.getByText(/Nothing happened/)).toBeInTheDocument()
    expect(screen.getByText(/Order is created/)).toBeInTheDocument()
    expect(screen.getByText('screen.png')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Metadata' }))
    expect(screen.getByText('Retry note')).toBeInTheDocument()
  })

  it('shows why a bead has no automated test command', () => {
    render(<BeadsDraftView content={JSON.stringify({ beads: [{
      id: 'bead-no-command',
      title: 'Verify interactive behavior manually',
      description: 'Keep interactive verification in Manual QA.',
      acceptanceCriteria: ['The visual state is correct.'],
      tests: ['A human verifies the visual state.'],
      testCommands: [],
      testCommandReason: 'No appropriate automated command exists for this interactive check.',
    }] })} />)

    fireEvent.click(screen.getByRole('button', { name: /Verify interactive behavior manually/ }))

    expect(screen.getByText('No automated command')).toBeInTheDocument()
    expect(screen.getByText('No appropriate automated command exists for this interactive check.')).toBeInTheDocument()
  })

  it('uses the interview results header for approval-phase canonical interviews', () => {
    render(
      <ArtifactContent
        artifactId="final-interview"
        phase="WAITING_INTERVIEW_APPROVAL"
        content={JSON.stringify({
          interview: buildCanonicalInterviewContent([
            {
              id: 'Q01',
              prompt: 'Which constraints are fixed?',
              answer: { skipped: false, free_text: 'Keep imports idempotent.' },
            },
          ]),
        })}
      />,
    )

    expect(screen.getByText('Interview Results')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Q&A' })).toBeInTheDocument()
  })

  it('renders interview answers without the interview summary section', () => {
    render(
      <ArtifactContent
        artifactId="interview-answers"
        phase="WAITING_INTERVIEW_APPROVAL"
        content={buildCanonicalInterviewContent([
          {
            id: 'Q01',
            prompt: 'Which constraints are fixed?',
            answer: { skipped: false, free_text: 'Keep imports idempotent.' },
          },
        ])}
      />,
    )

    expect(screen.getByText('Interview Answers')).toBeInTheDocument()
    expect(screen.queryByText('Interview Summary')).not.toBeInTheDocument()

    openFoundationGroup()
    expect(screen.getByText('Which constraints are fixed?')).toBeInTheDocument()
    expect(screen.getByText('Keep imports idempotent.')).toBeInTheDocument()
  })

  it('merges execution setup plan diagnostics into the setup plan artifact view', () => {
    render(
      <ArtifactContent
        artifactId="execution-setup-plan"
        content={buildExecutionSetupPlanContent()}
        reportContent={buildExecutionSetupPlanReportContent()}
      />,
    )

    expect(screen.getByText('Prepare workspace runtime assets safely.')).toBeInTheDocument()
    expect(screen.getByText('Observed Evidence')).toBeInTheDocument()
    expect(screen.getByText('Workspace bootstrap outputs are still missing.')).toBeInTheDocument()
    expect(screen.getByText('Project Command Families')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Generation Details/i }))
    expect(screen.getByText('Regenerate Commentary')).toBeInTheDocument()
    expect(screen.getByText('Switch to the project-native bootstrap command.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByRole('button', { name: 'Copy raw output' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /gpt-5 · Execution setup plan raw output/i })).toBeInTheDocument()
    expect(screen.getByText(/summary: regenerated/)).toBeInTheDocument()
  }, 10_000)

  it('hides failed execution setup plan model output from details and exposes it in raw diagnostics', () => {
    const modelOutput = '<EXECUTION_SETUP_PLAN>\nsummary: failed draft\n</EXECUTION_SETUP_PLAN>'

    render(
      <ArtifactContent
        artifactId="execution-setup-plan"
        content={buildExecutionSetupPlanContent()}
        reportContent={JSON.stringify({
          status: 'failed',
          ready: false,
          summary: 'Setup plan generation failed.',
          modelOutput,
          errors: ['Planner returned an invalid setup plan.'],
          rawAttempts: [
            {
              attempt: 1,
              status: 'failed',
              modelOutput: 'attempt model output',
              error: 'Missing readiness block.',
            },
          ],
        })}
      />,
    )

    expect(screen.getByText('Generation Errors')).toBeInTheDocument()
    expect(screen.queryByText(modelOutput)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    fireEvent.click(screen.getByRole('button', { name: /Model Output/ }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === modelOutput)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Execution setup plan Attempt 1/i })).toBeInTheDocument()
  })

  it('renders execution setup profiles with structured sections and raw access', () => {
    render(
      <ArtifactContent
        artifactId="execution-setup-profile"
        phase="PREPARING_EXECUTION_ENV"
        content={buildExecutionSetupProfileContent()}
      />,
    )

    expect(screen.getByText('Execution Setup Profile')).toBeInTheDocument()
    expect(screen.getByText('Runtime cache and command policy are ready.')).toBeInTheDocument()
    expect(screen.getByText('Tooling Probes')).toBeInTheDocument()
    expect(screen.getByText('project --version')).toBeInTheDocument()
    expect(screen.getByText('Reusable Artifacts')).toBeInTheDocument()
    expect(screen.getByText('.ticket/runtime/execution-setup/cache.json')).toBeInTheDocument()
    expect(screen.getByText('Quality Gate Policy')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByRole('button', { name: 'Copy raw output' })).toBeInTheDocument()
    expect(screen.getByText(/execution_setup_profile/)).toBeInTheDocument()
  })

  it('renders execution setup reports with checks, attempts, commands, and raw access', () => {
    render(
      <ArtifactContent
        artifactId="execution-setup-report"
        phase="PREPARING_EXECUTION_ENV"
        content={buildExecutionSetupRuntimeReportContent()}
      />,
    )

    expect(screen.getAllByText('Runtime profile is ready for coding beads.').length).toBeGreaterThan(0)
    expect(screen.getByText('Checks')).toBeInTheDocument()
    expect(screen.getByText('Workspace')).toBeInTheDocument()
    expect(screen.getByText('Attempt History')).toBeInTheDocument()
    expect(screen.getByText('Attempt 1')).toBeInTheDocument()
    expect(screen.getByText('Probes')).toBeInTheDocument()
    expect(screen.getByText('Command Audit')).toBeInTheDocument()
    expect(screen.getByText('project cache verify')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByRole('button', { name: 'Copy raw output' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /gpt-5 · Execution setup raw output/i })).toBeInTheDocument()
    expect(screen.getByText(/EXECUTION_SETUP_RESULT/)).toBeInTheDocument()
  })

  it('renders the combined execution setup runtime artifact with one structured runtime tab', () => {
    render(
      <ArtifactContent
        artifactId="execution-setup-runtime"
        phase="PREPARING_EXECUTION_ENV"
        content={buildExecutionSetupRuntimeReportContent()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Runtime' })).toBeInTheDocument()
    expect(screen.getAllByText('Runtime profile is ready for coding beads.').length).toBeGreaterThan(0)
    expect(screen.getByText('Profile Snapshot')).toBeInTheDocument()
    expect(screen.getByText('Command Audit')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByRole('button', { name: 'Copy raw output' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /gpt-5 · Execution setup raw output/i })).toBeInTheDocument()
    expect(screen.getByText(/EXECUTION_SETUP_RESULT/)).toBeInTheDocument()
  })

  it('falls back to raw output for malformed execution setup runtime artifacts', () => {
    render(
      <div>
        <ArtifactContent
          artifactId="execution-setup-profile"
          phase="PREPARING_EXECUTION_ENV"
          content="not a profile"
        />
        <ArtifactContent
          artifactId="execution-setup-report"
          phase="PREPARING_EXECUTION_ENV"
          content="not a report"
        />
        <ArtifactContent
          artifactId="execution-setup-runtime"
          phase="PREPARING_EXECUTION_ENV"
          content="not runtime"
        />
      </div>,
    )

    expect(screen.getByText('not a profile')).toBeInTheDocument()
    expect(screen.getByText('not a report')).toBeInTheDocument()
    expect(screen.getByText('not runtime')).toBeInTheDocument()
  })

  it('renders canonical free-text answers', () => {
    render(
      <InterviewAnswersView
        content={buildCanonicalInterviewContent([
          {
            id: 'Q01',
            prompt: 'What outcome matters most?',
            answer: { skipped: false, free_text: 'Keep imports idempotent.' },
          },
        ])}
      />,
    )

    openFoundationGroup()
    expect(screen.getByText('What outcome matters most?')).toBeInTheDocument()
    expect(screen.getByText('Keep imports idempotent.')).toBeInTheDocument()
    expect(screen.queryByText('Skipped')).not.toBeInTheDocument()
  })

  it('emphasizes changed words inside execution commit diffs', () => {
    render(
      <ArtifactContent
        artifactId="bead-commits"
        content={[
          'diff --git a/src/feature.ts b/src/feature.ts',
          'index abc1234..def5678 100644',
          '--- a/src/feature.ts',
          '+++ b/src/feature.ts',
          '@@ -1,2 +1,2 @@',
          '-const status = "draft"',
          '+const status = "refined"',
          ' const untouched = true',
        ].join('\n')}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /src\/feature\.ts/i }))

    expect(Array.from(document.querySelectorAll('mark')).map((element) => element.textContent)).toEqual(
      expect.arrayContaining(['draft', 'refined']),
    )
    expect(screen.getByText(hasExactTextContent('+const status = "refined"'))).toHaveClass(
      'whitespace-pre-wrap',
      'break-all',
    )
  })

  it('defaults bead commits to the final net diff and keeps bead/file activity views available', () => {
    render(
      <ArtifactContent
        artifactId="bead-commits"
        content={serializeBeadCommitsDiffContent({
          netDiff: [
            'diff --git a/src/final.ts b/src/final.ts',
            '--- a/src/final.ts',
            '+++ b/src/final.ts',
            '@@ -1 +1 @@',
            '-draft',
            '+final',
          ].join('\n'),
          beads: [
            {
              beadId: 'bead-1',
              label: 'First pass',
              diff: [
                'diff --git a/src/final.ts b/src/final.ts',
                '--- a/src/final.ts',
                '+++ b/src/final.ts',
                '@@ -1 +1 @@',
                '-draft',
                '+middle',
              ].join('\n'),
            },
            {
              beadId: 'bead-2',
              label: 'Second pass',
              diff: [
                'diff --git a/src/final.ts b/src/final.ts',
                '--- a/src/final.ts',
                '+++ b/src/final.ts',
                '@@ -1 +1 @@',
                '-middle',
                '+final',
              ].join('\n'),
            },
          ],
        })}
      />,
    )

    expect(screen.getByRole('button', { name: 'Net Diff' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'By Bead' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'By File' })).toBeInTheDocument()
    expect(screen.getByText('Final PR net diff')).toBeInTheDocument()
    expect(screen.queryByText('Cumulative bead activity')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'By Bead' }))
    expect(screen.getByText('Cumulative bead activity')).toBeInTheDocument()
    expect(screen.getByText(/bead-1/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'By File' }))
    expect(screen.getByText('Grouped bead file touches')).toBeInTheDocument()
    expect(screen.getByText(/touched in 2 beads/)).toBeInTheDocument()
  })

  it('hides the interview summary when the canonical interview summary is empty', () => {
    render(
      <InterviewAnswersView
        content={buildInterviewDocumentContent({
          questions: [
            {
              id: 'Q01',
              phase: 'Foundation',
              prompt: 'What outcome matters most?',
              source: 'compiled',
              answer_type: 'free_text',
              options: [],
              answer: { skipped: false, free_text: 'Keep imports idempotent.', selected_option_ids: [] },
            },
          ],
        })}
      />,
    )

    expect(screen.queryByText('Interview Summary')).not.toBeInTheDocument()

    openFoundationGroup()
    expect(screen.getByText('What outcome matters most?')).toBeInTheDocument()
  })

  it('renders single-choice selections without marking them skipped', () => {
    render(
      <InterviewAnswersView
        content={buildCanonicalInterviewContent([
          {
            id: 'Q02',
            prompt: 'Which database engine should we use?',
            answer_type: 'single_choice',
            options: [
              { id: 'pg', label: 'PostgreSQL' },
              { id: 'mysql', label: 'MySQL' },
            ],
            answer: { skipped: false, free_text: '', selected_option_ids: ['pg'] },
          },
        ])}
      />,
    )

    openFoundationGroup()
    expect(screen.getByText('Which database engine should we use?')).toBeInTheDocument()
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
    expect(screen.queryByText('Skipped')).not.toBeInTheDocument()
  })

  it('renders multiple-choice selections with notes', () => {
    render(
      <InterviewAnswersView
        content={buildCanonicalInterviewContent([
          {
            id: 'Q03',
            prompt: 'Which platforms should we support?',
            answer_type: 'multiple_choice',
            options: [
              { id: 'web', label: 'Web' },
              { id: 'ios', label: 'iOS' },
              { id: 'android', label: 'Android' },
            ],
            answer: {
              skipped: false,
              free_text: 'Start with the first two only.',
              selected_option_ids: ['web', 'ios'],
            },
          },
        ])}
      />,
    )

    openFoundationGroup()
    expect(screen.getByText('Web')).toBeInTheDocument()
    expect(screen.getByText('iOS')).toBeInTheDocument()
    expect(screen.getByText('Start with the first two only.')).toBeInTheDocument()
  })

  it('renders skipped canonical answers as skipped', () => {
    render(
      <InterviewAnswersView
        content={buildCanonicalInterviewContent([
          {
            id: 'Q04',
            prompt: 'Do we need an admin panel?',
            answer: { skipped: true, free_text: '', selected_option_ids: [], answered_by: 'user', answered_at: '' },
          },
        ])}
      />,
    )

    openFoundationGroup()
    expect(screen.getByText('Do we need an admin panel?')).toBeInTheDocument()
    expect(screen.getByText(/This question was skipped/i)).toBeInTheDocument()
  })

  it('renders PRD full answers with the interview-style view and AI-answer badge', () => {
    render(
      <ArtifactContent
        artifactId="prd-fullanswers-member-openai%2Fgpt-5.2"
        phase="DRAFTING_PRD"
        content={JSON.stringify({
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: buildInterviewDocumentContent({
                questions: [
                  {
                    id: 'Q01',
                    phase: 'Foundation',
                    prompt: 'What should happen for skipped interview answers?',
                    source: 'compiled',
                    answer_type: 'free_text',
                    options: [],
                    answer: {
                      skipped: false,
                      free_text: 'Fill them in with explicit AI-authored answers.',
                      selected_option_ids: [],
                      answered_by: 'ai_skip',
                      answered_at: '2026-03-25T09:00:00.000Z',
                    },
                  },
                ],
              }),
              structuredOutput: futureStructuredOutput({
                repairApplied: true,
                repairWarnings: [
                  'Canonicalized resolved interview status from "approved" to "draft".',
                  'Cleared approval fields for the AI-generated Full Answers artifact.',
                  'Canonicalized generated_by.winner_model from "openai/gpt-5.4" to "openai/gpt-5.2".',
                ],
              }),
            },
          ],
          memberOutcomes: {
            'openai/gpt-5.2': 'completed',
          },
        })}
      />,
    )

    openFoundationGroup()
    expect(screen.getByText('What should happen for skipped interview answers?')).toBeInTheDocument()
    expect(screen.getByText('Fill them in with explicit AI-authored answers.')).toBeInTheDocument()
    expect(screen.getByText(/Answered automatically by AI in Drafting specs status/i)).toBeInTheDocument()
    expect(screen.getByText('LoopTroop adjusted these Full Answers.')).toBeInTheDocument()
    expect(screen.getByText('Cleanup 3')).toBeInTheDocument()
  })

  it('explains when Full Answers were reused from the approved interview', () => {
    render(
      <ArtifactContent
        artifactId="prd-fullanswers-member-openai%2Fgpt-5.2"
        phase="DRAFTING_PRD"
        content={JSON.stringify({
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: buildInterviewDocumentContent({
                questions: [
                  {
                    id: 'Q01',
                    phase: 'Foundation',
                    prompt: 'Do we need AI-filled follow-up answers?',
                    source: 'compiled',
                    answer_type: 'free_text',
                    options: [],
                    answer: {
                      skipped: false,
                      free_text: 'No, the approved interview was already complete.',
                      selected_option_ids: [],
                      answered_by: 'user',
                      answered_at: '2026-03-25T09:00:00.000Z',
                    },
                  },
                ],
              }),
              structuredOutput: futureStructuredOutput({
                repairApplied: true,
                repairWarnings: [
                  'Canonicalized resolved interview status from "approved" to "draft".',
                  'Cleared approval fields for the AI-generated Full Answers artifact.',
                ],
              }),
            },
          ],
          memberOutcomes: {
            'openai/gpt-5.2': 'completed',
          },
        })}
      />,
    )

    expect(screen.getByText('LoopTroop reused the approved interview for these answers.')).toBeInTheDocument()
    expect(screen.getByText('2 interventions: Interview Status, Approval Fields.')).toBeInTheDocument()
    expect(screen.getByText('Cleanup 2')).toBeInTheDocument()

    openNotice('LoopTroop reused the approved interview for these answers.')

    expect(screen.getByText(/This ticket had no skipped interview questions, so Part 1 did not need a model response/i)).toBeInTheDocument()
  })

  it('renders PRD draft member artifacts with structured epics and user stories', () => {
    render(
      <ArtifactContent
        artifactId="prd-draft-member-openai%2Fgpt-5.2"
        phase="DRAFTING_PRD"
        content={JSON.stringify({
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: buildPrdDocumentContent(),
            },
          ],
          memberOutcomes: {
            'openai/gpt-5.2': 'completed',
          },
        })}
      />,
    )

    expect(screen.getByText('Epics (1)')).toBeInTheDocument()
    expect(screen.getByText('Restore rich PRD views')).toBeInTheDocument()

    // Expand the epic section to reveal user stories
    fireEvent.click(screen.getByText('Restore rich PRD views').closest('button')!)

    expect(screen.getByText('Review PRD drafts')).toBeInTheDocument()
    expect(screen.getByText('Show epics and user stories in the structured view.')).toBeInTheDocument()
  })

  it('suppresses invalid PRD draft bodies and shows diagnostics with raw access', () => {
    const invalidBody = buildPrdDocumentContent({
      epicTitle: 'Do not render invalid draft body',
      storyTitle: 'Hidden invalid story',
      acceptanceCriterion: 'Invalid draft text stays out of the body.',
    })

    render(
      <ArtifactContent
        artifactId="prd-draft-member-openai%2Fgpt-5.2"
        phase="DRAFTING_PRD"
        content={JSON.stringify({
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'invalid_output',
              content: invalidBody,
              rawResponse: 'raw invalid prd payload',
              error: 'epics[0].user_stories is required',
              structuredOutput: futureStructuredOutput({
                repairApplied: false,
                repairWarnings: [],
                autoRetryCount: 1,
                validationError: 'PRD parser rejected the model output.',
              }),
            },
          ],
          memberOutcomes: {
            'openai/gpt-5.2': 'invalid_output',
          },
        })}
      />,
    )

    expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeInTheDocument()
    expect(screen.getAllByText('Invalid Output').length).toBeGreaterThan(0)
    expect(screen.getByText('epics[0].user_stories is required')).toBeInTheDocument()
    expect(screen.queryByText('Do not render invalid draft body')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden invalid story')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === 'raw invalid prd payload')).toBeInTheDocument()
  })

  it('suppresses invalid PRD winner draft bodies in future council views', () => {
    const invalidBody = buildPrdDocumentContent({
      epicTitle: 'Do not render invalid future winner body',
      storyTitle: 'Hidden future invalid story',
      acceptanceCriterion: 'Invalid winner body stays out of vote/refine views.',
    })

    render(
      <ArtifactContent
        artifactId="winner-prd-draft"
        phase="COUNCIL_VOTING_PRD"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'invalid_output',
              content: invalidBody,
              rawAttempts: [
                {
                  attempt: 1,
                  outcome: 'rejected',
                  rawResponse: 'raw invalid future winner payload',
                  validationError: 'PRD parser rejected the winner draft.',
                },
              ],
              error: 'PRD parser rejected the winner draft.',
              structuredOutput: futureStructuredOutput({
                repairApplied: false,
                repairWarnings: [],
                autoRetryCount: 1,
                validationError: 'PRD parser rejected the winner draft.',
              }),
            },
          ],
        })}
      />,
    )

    expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeInTheDocument()
    expect(screen.queryByText('Do not render invalid future winner body')).not.toBeInTheDocument()
    expect(screen.queryByText('Hidden future invalid story')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.queryByRole('button', { name: /gpt-5.2 Attempt 1 Output - Rejected/ })).not.toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === 'raw invalid future winner payload')).not.toBeInTheDocument()
    expect(screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && Boolean(element.textContent?.includes('"outcome": "invalid_output"'))
      && Boolean(element.textContent?.includes('"validationError": "PRD parser rejected the winner draft."')),
    )).toBeInTheDocument()
  })

  it('renders refined PRD artifacts with the same structured PRD viewer', () => {
    render(
      <ArtifactContent
        artifactId="refined-prd"
        phase="WAITING_PRD_APPROVAL"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          winnerDraftContent: buildPrdDocumentContent({
            epicTitle: 'Original PRD candidate',
            storyTitle: 'Inspect original stories',
            acceptanceCriterion: 'Keep the older candidate available for coverage diffing.',
          }),
          refinedContent: buildPrdDocumentContent({
            epicTitle: 'Refine the winning PRD',
            storyTitle: 'Inspect refined stories',
            acceptanceCriterion: 'Keep the PRD viewer structured after refinement.',
          }),
        })}
      />,
    )

    expect(screen.getByText('Epics (1)')).toBeInTheDocument()
    expect(screen.getByText('Refine the winning PRD')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).not.toBeInTheDocument()

    // Expand the epic section to reveal user stories
    fireEvent.click(screen.getByText('Refine the winning PRD').closest('button')!)

    expect(screen.getByText('Inspect refined stories')).toBeInTheDocument()
    expect(screen.getByText('Keep the PRD viewer structured after refinement.')).toBeInTheDocument()
  })

  it('renders structured bead guidance for winner artifacts without crashing', () => {
    render(
      <ArtifactContent
        artifactId="winner-beads-draft"
        phase="COUNCIL_VOTING_BEADS"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: buildBeadsDraftContent({
                guidance: {
                  patterns: ['Reuse the shared bead viewer for every artifact path.'],
                  anti_patterns: ['Do not render structured guidance objects directly into JSX.'],
                },
              }),
            },
          ],
        })}
      />,
    )

    expect(screen.queryByText(/^pending$/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Render structured guidance safely').closest('button')!)

    expect(screen.getByText('Patterns')).toBeInTheDocument()
    expect(screen.getByText('Anti-patterns')).toBeInTheDocument()
    expect(screen.getByText('Reuse the shared bead viewer for every artifact path.')).toBeInTheDocument()
    expect(screen.getByText('Do not render structured guidance objects directly into JSX.')).toBeInTheDocument()
    expect(screen.queryByText(/^pending$/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Something went wrong rendering this content/i)).not.toBeInTheDocument()
  })

  it('renders Voting on Blueprint results with shared vote rankings, presentation order, and processing notices', () => {
    render(
      <ArtifactContent
        artifactId="beads-votes"
        phase="COUNCIL_VOTING_BEADS"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          drafts: [
            {
              memberId: 'openai/gpt-5.1-codex',
              outcome: 'completed',
              content: buildBeadsDraftContent({
                title: 'Validate architecture votes',
              }),
            },
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: buildBeadsDraftContent({
                title: 'Surface vote ordering',
              }),
            },
          ],
          votes: [
            {
              voterId: 'openai/gpt-5.1-codex',
              draftId: 'openai/gpt-5.2',
              totalScore: 92,
              scores: [
                { category: 'Coverage of requirements', score: 19, justification: 'Strong coverage' },
                { category: 'Correctness / feasibility', score: 18, justification: 'Feasible' },
                { category: 'Testability', score: 19, justification: 'Testable' },
                { category: 'Minimal complexity / good decomposition', score: 18, justification: 'Well scoped' },
                { category: 'Risks / edge cases addressed', score: 18, justification: 'Good risk handling' },
              ],
            },
            {
              voterId: 'openai/gpt-5.2',
              draftId: 'openai/gpt-5.2',
              totalScore: 94,
              scores: [
                { category: 'Coverage of requirements', score: 19, justification: 'Strong coverage' },
                { category: 'Correctness / feasibility', score: 19, justification: 'Feasible' },
                { category: 'Testability', score: 19, justification: 'Testable' },
                { category: 'Minimal complexity / good decomposition', score: 18, justification: 'Well scoped' },
                { category: 'Risks / edge cases addressed', score: 19, justification: 'Good risk handling' },
              ],
            },
          ],
          voterOutcomes: {
            'openai/gpt-5.1-codex': 'completed',
            'openai/gpt-5.2': 'completed',
          },
          voterDetails: [
            {
              voterId: 'openai/gpt-5.1-codex',
              structuredOutput: futureStructuredOutput({
                repairApplied: true,
                repairWarnings: ['Normalized vote scorecard indentation under the wrapper key.'],
              }),
            },
            {
              voterId: 'openai/gpt-5.2',
              structuredOutput: futureStructuredOutput({
                repairApplied: false,
                repairWarnings: [],
                autoRetryCount: 1,
                validationError: 'Malformed scorecard',
              }),
            },
          ],
          presentationOrders: {
            'openai/gpt-5.1-codex': {
              seed: 'seed-alpha-1234',
              order: ['openai/gpt-5.1-codex', 'openai/gpt-5.2'],
            },
            'openai/gpt-5.2': {
              seed: 'seed-beta-5678',
              order: ['openai/gpt-5.2', 'openai/gpt-5.1-codex'],
            },
          },
          totalScore: 186,
          isFinal: true,
        })}
      />,
    )

    expect(screen.getByText('Voter Status')).toBeInTheDocument()
    expect(screen.getByText('Rankings')).toBeInTheDocument()
    expect(screen.getByText('Score Breakdown')).toBeInTheDocument()
    expect(screen.getByText('LoopTroop adjusted some vote scorecards.')).toBeInTheDocument()
    expect(screen.getByText('2 interventions across 2 categories: Wrapper Key, Validation Retry.')).toBeInTheDocument()
    expect(screen.queryByText('Affected Models')).not.toBeInTheDocument()

    openNotice('LoopTroop adjusted some vote scorecards.')
    expect(screen.getByText('Affected Models')).toBeInTheDocument()
    expect(screen.getByText('Malformed scorecard')).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Voter Details/i).closest('button')!)
    expect(screen.getAllByText('Presentation Order')).toHaveLength(2)
    expect(screen.getByText(/seed seed-alp/i)).toBeInTheDocument()
    expect(screen.getByText(/seed seed-bet/i)).toBeInTheDocument()
    expect(screen.getByText(hasExactTextContent('Draft 1: gpt-5.1-codex'))).toBeInTheDocument()
    expect(screen.getByText(hasExactTextContent('Draft 2: gpt-5.2'))).toBeInTheDocument()
    expect(screen.queryByText('LoopTroop adjusted this vote scorecard.')).not.toBeInTheDocument()
  })

  it('counts duplicate parser fixes across Voting on Blueprint detail owners', () => {
    render(
      <ArtifactContent
        artifactId="beads-votes"
        phase="COUNCIL_VOTING_BEADS"
        content={JSON.stringify({
          winnerId: 'vendor/draft-a',
          drafts: [
            { memberId: 'vendor/draft-a', outcome: 'completed', content: buildBeadsDraftContent({ title: 'Draft A' }) },
            { memberId: 'vendor/draft-b', outcome: 'completed', content: buildBeadsDraftContent({ title: 'Draft B' }) },
          ],
          votes: [
            {
              voterId: 'vendor/voter-a',
              draftId: 'vendor/draft-a',
              totalScore: 91,
              scores: [{ category: 'Coverage of requirements', score: 19 }],
            },
            {
              voterId: 'vendor/voter-b',
              draftId: 'vendor/draft-b',
              totalScore: 89,
              scores: [{ category: 'Coverage of requirements', score: 18 }],
            },
          ],
          voterOutcomes: {
            'vendor/voter-a': 'completed',
            'vendor/voter-b': 'completed',
          },
          voterDetails: [
            {
              voterId: 'vendor/voter-a',
              structuredOutput: futureStructuredOutput({
                repairApplied: true,
                repairWarnings: ['Unwrapped markdown code fence wrapping the YAML payload.'],
              }),
            },
            {
              voterId: 'vendor/voter-b',
              structuredOutput: futureStructuredOutput({
                repairApplied: true,
                repairWarnings: ['Unwrapped markdown code fence wrapping the YAML payload.'],
              }),
            },
          ],
        })}
      />,
    )

    expect(screen.getByText('LoopTroop adjusted some vote scorecards.')).toBeInTheDocument()
    expect(screen.getByText('2 interventions: Markdown Fence Unwrap.')).toBeInTheDocument()
    expect(screen.getByText('Parser Fix 2')).toBeInTheDocument()

    openNotice('LoopTroop adjusted some vote scorecards.')
    expect(screen.getByText('Affected Models')).toBeInTheDocument()
    expect(screen.getAllByText('Markdown Fence Unwrap')).toHaveLength(2)
  })

  it('keeps legacy string bead guidance working for final bead drafts', () => {
    render(
      <ArtifactContent
        artifactId="final-beads-draft"
        phase="WAITING_BEADS_APPROVAL"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          refinedContent: buildBeadsDraftContent({
            title: 'Keep legacy guidance readable',
            guidance: 'Preserve the old single-block guidance rendering for legacy bead artifacts.',
          }),
        })}
      />,
    )

    fireEvent.click(screen.getByText('Keep legacy guidance readable').closest('button')!)

    expect(screen.getByText('Preserve the old single-block guidance rendering for legacy bead artifacts.')).toBeInTheDocument()
    expect(screen.queryByText('Patterns')).not.toBeInTheDocument()
    expect(screen.queryByText('Anti-patterns')).not.toBeInTheDocument()
  })

  it('uses the same safe bead guidance renderer in coverage review sections', () => {
    render(
      <ArtifactContent
        artifactId="refined-beads"
        phase="WAITING_BEADS_APPROVAL"
        content={JSON.stringify({
          beads: buildBeadsDraftContent({
            title: 'Review prior bead guidance',
            guidance: {
              patterns: ['Carry forward the prior patterns list in review mode.'],
              anti_patterns: ['Do not lose structured guidance in the prior-context section.'],
            },
          }),
          refinedContent: buildBeadsDraftContent({
            title: 'Review refined bead guidance',
            guidance: {
              patterns: ['Render refined guidance with explicit list headings.'],
              anti_patterns: ['Do not special-case the review view with a different renderer.'],
            },
          }),
        })}
      />
    )

    // Merged into a single "Beads" section showing refinedContent (diff tab shows differences)
    expect(screen.getByText('Beads')).toBeInTheDocument()
    expect(screen.queryByText('Prior Context (Beads)')).not.toBeInTheDocument()
    expect(screen.queryByText('Under Verification (Beads)')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Review refined bead guidance').closest('button')!)

    expect(screen.getByText('Render refined guidance with explicit list headings.')).toBeInTheDocument()
    expect(screen.getByText('Do not special-case the review view with a different renderer.')).toBeInTheDocument()
  })

  it('wraps Expanding Blueprint raw output without horizontal overflow', () => {
    const semanticPlanContent = buildBeadsDraftContent({
      title: 'Expand raw output without clipping',
    })
    const expandedContent = JSON.stringify([
      {
        id: LONG_EXPANDING_BLUEPRINT_TOKEN,
        title: 'Expand raw output without clipping',
        prdRefs: [TEST.epicId, TEST.storyId],
        description: 'Render the raw expanded payload inside the artifact dialog.',
        contextGuidance: {
          patterns: ['Keep raw expansion payloads readable.'],
          anti_patterns: ['Do not rely on horizontal scrolling for long generated values.'],
        },
        acceptanceCriteria: ['The raw tab wraps long embedded payload lines.'],
        tests: ['The raw tab does not clip generated execution fields.'],
        testCommands: [`npm run test -- --filter ${LONG_EXPANDING_BLUEPRINT_TOKEN}`],
        priority: 1,
        status: 'pending',
        issueType: 'task',
        externalRef: TEST.externalId,
        labels: [`ticket:${TEST.externalId}`, LONG_EXPANDING_BLUEPRINT_TOKEN],
        dependencies: { blocked_by: [], blocks: [] },
        targetFiles: [`src/${LONG_EXPANDING_BLUEPRINT_TOKEN}.tsx`],
      },
    ])

    render(
      <ArtifactContent
        artifactId="refined-beads"
        phase="EXPANDING_BEADS"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          semanticPlanContent,
          refinedContent: expandedContent,
          candidateVersion: 2,
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const rawPre = screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && Boolean(element.textContent?.includes(LONG_EXPANDING_BLUEPRINT_TOKEN)),
    )
    expect(rawPre).toHaveClass('whitespace-pre-wrap', 'overflow-x-hidden', 'break-all')
    expect(rawPre.className).toContain('[overflow-wrap:anywhere]')
    expect(rawPre.className).not.toContain('overflow-x-auto')
  })

  it('hides persisted no-op beads ui diff entries in rendered bead diffs', () => {
    const beadsContent = buildBeadsDraftContent({
      title: 'Keep the switcher bead unchanged',
    })

    render(
      <ArtifactContent
        artifactId="final-beads-draft"
        phase="REFINING_BEADS"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          winnerDraftContent: beadsContent,
          refinedContent: beadsContent,
          uiRefinementDiff: {
            domain: 'beads',
            winnerId: 'openai/gpt-5.2',
            generatedAt: '2026-04-06T11:38:37.016Z',
            entries: [
              {
                key: 'bead:bead-1',
                changeType: 'modified',
                itemKind: 'bead',
                label: 'Keep the switcher bead unchanged',
                beforeId: 'bead-1',
                afterId: 'bead-1',
                beforeText: 'Title: Keep the switcher bead unchanged',
                afterText: '  Title: Keep the switcher bead unchanged  ',
                attributionStatus: 'synthesized_unattributed',
              },
            ],
          },
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    expect(screen.getByText('No refinement changes recorded.')).toBeInTheDocument()
  })

  it('hides persisted no-op PRD ui diff entries in rendered PRD diffs', () => {
    const prdContent = buildPrdDocumentContent({
      storyTitle: 'Keep the switcher bead unchanged',
    })

    render(
      <ArtifactContent
        artifactId="final-prd-draft"
        phase="REFINING_PRD"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          winnerDraftContent: prdContent,
          refinedContent: prdContent,
          uiRefinementDiff: {
            domain: 'prd',
            winnerId: 'openai/gpt-5.2',
            generatedAt: '2026-04-06T11:38:37.016Z',
            entries: [
              {
                key: 'user_story:US-1',
                changeType: 'modified',
                itemKind: 'user_story',
                label: 'Keep the switcher bead unchanged',
                beforeId: 'US-1',
                afterId: 'US-1',
                beforeText: 'Title: Keep the switcher bead unchanged',
                afterText: 'Title: Keep the switcher bead unchanged',
                attributionStatus: 'model_unattributed',
              },
            ],
          },
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    expect(screen.getByText('No refinement changes recorded.')).toBeInTheDocument()
  })

  it('shows PRD refinement auto retries as raw attempt variants', () => {
    const prdContent = buildPrdDocumentContent()
    const rejectedRawResponse = 'this is prose, not the PRD schema'
    const acceptedRawResponse = `${prdContent}\n`

    render(
      <ArtifactContent
        artifactId="final-prd-draft"
        phase="REFINING_PRD"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          winnerDraftContent: prdContent,
          refinedContent: prdContent,
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Missing PRD document fields.',
            retryDiagnostics: [
              {
                attempt: 1,
                validationError: 'Missing PRD document fields.',
                excerpt: rejectedRawResponse,
              },
            ],
          }),
          rawAttempts: [
            {
              attempt: 2,
              stage: 'refine',
              outcome: 'accepted',
              rawResponse: acceptedRawResponse,
            },
            {
              attempt: 1,
              stage: 'refine',
              outcome: 'rejected',
              rawResponse: rejectedRawResponse,
              validationError: 'Missing PRD document fields.',
            },
          ],
        })}
      />,
    )

    expect(screen.getByText('LoopTroop adjusted this diff.')).toBeInTheDocument()
    openNotice('LoopTroop adjusted this diff.')
    expect(screen.getByText(/Retry Attempts/i)).toBeInTheDocument()
    expect(screen.getAllByText('Missing PRD document fields.').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))
    expect(screen.queryByText('LoopTroop adjusted this diff.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    expect(screen.queryByText('LoopTroop adjusted this diff.')).not.toBeInTheDocument()
    expect(screen.queryByText('Retries 1')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accepted Output' })).not.toBeInTheDocument()
    const rawGroup = screen.getByRole('group', { name: /raw refinement attempts/i })
    expect(within(rawGroup).getByText(/gpt-5.2 · PRD refinement/i)).toBeInTheDocument()
    expect(within(rawGroup).queryByRole('button', { name: /Initial Prompt/i })).not.toBeInTheDocument()
    expect(within(rawGroup).getByRole('button', { name: /gpt-5.2 · PRD refinement Attempt 1 Output - Rejected/i })).toBeInTheDocument()
    expect(within(rawGroup).getByRole('button', { name: /gpt-5.2 · PRD refinement Attempt 2 Output - Accepted/i })).toBeInTheDocument()
    expect(within(rawGroup).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Attempt 1 Output - Rejected',
      'Attempt 2 Output - Accepted',
    ])
    expect(within(rawGroup).queryByRole('button', { name: /Artifact JSON/i })).not.toBeInTheDocument()
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedRawResponse)).toBeInTheDocument()

    fireEvent.click(within(rawGroup).getByRole('button', { name: /Attempt 2 Output - Accepted/i }))

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === acceptedRawResponse.trimEnd())).toBeInTheDocument()

    fireEvent.click(within(rawGroup).getByRole('button', { name: /Attempt 1 Output - Rejected/i }))

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedRawResponse)).toBeInTheDocument()
  })

  it('shows initial prompt before raw attempt variants when available', () => {
    const initialInput = '## Task\nDraft the PRD from the approved interview.'
    const acceptedRawResponse = buildPrdDocumentContent({
      epicTitle: 'Initial input audit',
      storyTitle: 'Inspect the initial model prompt',
      acceptanceCriterion: 'The Initial Prompt raw variant appears before model outputs.',
    })

    render(
      <ArtifactContent
        artifactId="final-prd-draft"
        phase="REFINING_PRD"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          winnerDraftContent: acceptedRawResponse,
          refinedContent: acceptedRawResponse,
          rawAttempts: [
            {
              attempt: 1,
              stage: 'refine',
              outcome: 'accepted',
              initialInput,
              rawResponse: acceptedRawResponse,
            },
          ],
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const rawGroup = screen.getByRole('group', { name: /raw refinement attempts/i })
    expect(within(rawGroup).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Initial Prompt',
      'Attempt 1 Output - Accepted',
    ])

    fireEvent.click(within(rawGroup).getByRole('button', { name: /Initial Prompt/i }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === initialInput)).toBeInTheDocument()

    fireEvent.click(within(rawGroup).getByRole('button', { name: /Attempt 1 Output - Accepted/i }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === acceptedRawResponse.trimEnd())).toBeInTheDocument()
  })

  it('renders coverage report with changes tab when only revision content is provided', () => {
    const revisionContent = JSON.stringify({
      winnerId: 'openai/gpt-5.2',
      candidateVersion: 2,
      winnerDraftContent: buildPrdDocumentContent({
        epicTitle: 'Audit input candidate',
        storyTitle: 'Inspect the audit input',
        acceptanceCriterion: 'Keep the original audit candidate visible.',
      }),
      refinedContent: buildPrdDocumentContent({
        epicTitle: 'Coverage revised candidate',
        storyTitle: 'Inspect the revised candidate',
        acceptanceCriterion: 'Show the coverage revised candidate by default.',
      }),
      changes: [
        {
          type: 'modified',
          itemType: 'epic',
          before: { id: 'EPIC-1', label: 'Audit input candidate' },
          after: { id: 'EPIC-1', label: 'Coverage revised candidate' },
          inspiration: null,
          attributionStatus: 'model_unattributed',
        },
      ],
    })
    render(
      <ArtifactContent
        artifactId="coverage-report"
        phase="WAITING_PRD_APPROVAL"
        content={JSON.stringify({
          coverageReviewContent: null,
          revisionContent,
        })}
      />,
    )

    // With no audit content, the Changes tab is selected by default
    expect(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i })).toBeInTheDocument()
    expect(screen.getAllByText(hasTextContent('Audit input candidate')).length).toBeGreaterThan(0)
    expect(screen.getByText('Coverage revised candidate')).toBeInTheDocument()
  })

  it('renders coverage report with resolution notes tab', () => {
    const revisionContent = JSON.stringify({
      winnerId: 'openai/gpt-5.2',
      candidateVersion: 2,
      refinedContent: buildPrdDocumentContent({
        epicTitle: 'Coverage revised candidate',
        storyTitle: 'Inspect the revised candidate',
      }),
      gapResolutions: [
        {
          gap: 'Missing retry-cap approval behavior.',
          action: 'updated_prd',
          rationale: 'Added explicit approval handling when unresolved gaps remain after the retry cap.',
          affectedItems: [
            { itemType: 'epic', id: 'EPIC-1', label: 'Coverage revised candidate' },
          ],
        },
      ],
    })
    render(
      <ArtifactContent
        artifactId="coverage-report"
        phase="WAITING_PRD_APPROVAL"
        content={JSON.stringify({
          coverageReviewContent: null,
          revisionContent,
        })}
      />,
    )

    // With no audit content, Resolution Notes tab is selected by default (no changes tab either)
    expect(screen.getByText('Missing retry-cap approval behavior.')).toBeInTheDocument()
    expect(screen.getByText(/Added explicit approval handling when unresolved gaps remain after the retry cap/i)).toBeInTheDocument()
    expect(screen.getByText('Epic EPIC-1: Coverage revised candidate')).toBeInTheDocument()
  })

  it('uses simpler PRD coverage resolution note copy during verification', () => {
    const revisionContent = JSON.stringify({
      winnerId: 'openai/gpt-5.2',
      candidateVersion: 2,
      refinedContent: buildPrdDocumentContent({
        epicTitle: 'Coverage revised candidate',
        storyTitle: 'Inspect the revised candidate',
      }),
      gapResolutions: [
        {
          gap: 'Missing retry-cap approval behavior.',
          action: 'updated_prd',
          rationale: 'Added explicit approval handling when unresolved gaps remain after the retry cap.',
          affectedItems: [
            { itemType: 'epic', id: 'EPIC-1', label: 'Coverage revised candidate' },
          ],
        },
      ],
    })

    render(
      <ArtifactContent
        artifactId="coverage-report"
        phase="VERIFYING_PRD_COVERAGE"
        content={JSON.stringify({
          coverageReviewContent: null,
          revisionContent,
        })}
      />,
    )

    expect(
      screen.getByText('Latest notes about how coverage gaps were handled for PRD Candidate v2.'),
    ).toBeInTheDocument()
  })

  it('shows PRD coverage gap details while hiding follow-up questions', () => {
    const coverageResponse = [
      'status: gaps',
      'gaps:',
      '  - "Missing PRD approval sequencing."',
      'follow_up_questions:',
      '  - id: FU01',
      '    question: "Which approval step should trigger Beads?"',
      '    phase: PRD',
    ].join('\n')
    const coverageContent = JSON.stringify({
      winnerId: 'openai/gpt-5.2',
      response: coverageResponse,
      hasGaps: true,
      coverageRunNumber: 2,
      maxCoveragePasses: 2,
      limitReached: true,
      terminationReason: 'coverage_pass_limit_reached',
      parsed: {
        status: 'gaps',
        gaps: ['Missing PRD approval sequencing.'],
        followUpQuestions: [
          {
            id: 'FU01',
            question: 'Which approval step should trigger Beads?',
            phase: 'PRD',
            priority: 'high',
            rationale: 'PRD coverage should stay diagnostic-only.',
          },
        ],
      },
    })
    const coverageDisplayContent = coverageResponse

    render(
      <ArtifactContent
        artifactId="prd-coverage-result"
        phase="VERIFYING_PRD_COVERAGE"
        content={coverageContent}
      />,
    )

    expect(screen.getByText('Coverage review found gaps')).toBeInTheDocument()
    expect(screen.getByText('This check found 1 gap between the current PRD candidate and the winner Full Answers.')).toBeInTheDocument()
    expect(screen.getByText('Retry cap reached; moving to approval with unresolved gaps.')).toBeInTheDocument()
    expect(screen.getByText('Open Coverage Gaps')).toBeInTheDocument()
    expect(screen.getByText('Missing PRD approval sequencing.')).toBeInTheDocument()
    expect(screen.queryByText('Follow-up Questions')).not.toBeInTheDocument()
    expect(screen.queryByText('Which approval step should trigger Beads?')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    expect(screen.getByRole('group', { name: /gpt-5.2 · coverage audit raw output/i })).toBeInTheDocument()
    expect(screen.getByText(`${coverageDisplayContent.split('\n').length.toLocaleString()} Lines`)).toBeInTheDocument()
    expect(screen.getByText(`${coverageDisplayContent.length.toLocaleString()} Characters`)).toBeInTheDocument()
    expect(screen.getByText(`${encode(coverageDisplayContent).length.toLocaleString()} Tokens (GPT-5 tokenizer)`)).toBeInTheDocument()
  })

  it('shows terminal beads coverage remaining gaps for the latest implementation plan', () => {
    render(
      <ArtifactContent
        artifactId="coverage-report"
        phase="WAITING_BEADS_APPROVAL"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          status: 'gaps',
          summary: 'Implementation Plan v5 still has 2 gaps.',
          finalCandidateVersion: 5,
          hasRemainingGaps: true,
          remainingGaps: [
            'Stable-channel feature-flag rollout behavior is still missing from the implementation plan.',
            'GUI verification needs a concrete repo-standard test path before approval.',
          ],
          attempts: [
            {
              candidateVersion: 5,
              status: 'gaps',
              summary: 'Implementation Plan v5 still has 2 gaps.',
              gaps: [
                'Stale attempt gap that should not win over remainingGaps.',
              ],
              auditNotes: 'status: gaps',
            },
          ],
          transitions: [
            {
              fromVersion: 4,
              toVersion: 5,
              summary: 'Coverage found 1 gap in Implementation Plan v4 and created Implementation Plan v5.',
              gaps: [
                'Historical transition gap that should not win over remainingGaps.',
              ],
              auditNotes: 'status: gaps',
              fromContent: buildBeadsDraftContent({ title: 'Previous implementation plan' }),
              toContent: buildBeadsDraftContent({ title: 'Latest implementation plan' }),
              gapResolutions: [],
              resolutionNotes: [],
            },
          ],
        })}
      />,
    )

    expect(screen.getByRole('button', { name: /Latest Check/i })).toBeInTheDocument()
    expect(screen.getByText('Coverage review found gaps')).toBeInTheDocument()
    expect(screen.getByText('Implementation Plan v5 still has 2 gaps.')).toBeInTheDocument()
    expect(screen.getByText('Open Coverage Gaps in Implementation Plan v5')).toBeInTheDocument()
    expect(screen.getByText('Stable-channel feature-flag rollout behavior is still missing from the implementation plan.')).toBeInTheDocument()
    expect(screen.getByText('GUI verification needs a concrete repo-standard test path before approval.')).toBeInTheDocument()
    expect(screen.queryByText('Stale attempt gap that should not win over remainingGaps.')).not.toBeInTheDocument()
    expect(screen.queryByText('Historical transition gap that should not win over remainingGaps.')).not.toBeInTheDocument()
  })

  it('labels user-triggered coverage fixes as Extra Fix tabs and keeps Latest Check last', () => {
    render(
      <ArtifactContent
        artifactId="coverage-report"
        phase="WAITING_PRD_APPROVAL"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          status: 'gaps',
          summary: 'PRD Candidate v4 still has 1 gap.',
          finalCandidateVersion: 4,
          hasRemainingGaps: true,
          remainingGaps: ['Remaining approval gap.'],
          transitions: [
            {
              fromVersion: 1,
              toVersion: 2,
              summary: 'Coverage found 1 gap in PRD Candidate v1 and created PRD Candidate v2.',
              gaps: ['Initial gap.'],
              auditNotes: 'status: gaps',
              fromContent: buildPrdDocumentContent({ epicTitle: 'Initial PRD' }),
              toContent: buildPrdDocumentContent({ epicTitle: 'Revised PRD' }),
              gapResolutions: [],
              resolutionNotes: [],
            },
            {
              fromVersion: 2,
              toVersion: 3,
              summary: 'Extra Fix 1 revised PRD Candidate v2 into PRD Candidate v3; 1 gap remains.',
              gaps: ['Manual extra gap.'],
              auditNotes: 'status: gaps',
              fromContent: buildPrdDocumentContent({ epicTitle: 'Revised PRD' }),
              toContent: buildPrdDocumentContent({ epicTitle: 'Extra fixed PRD' }),
              gapResolutions: [],
              resolutionNotes: [],
              source: 'ai_fix_button',
              extraFixNumber: 1,
              label: 'Extra Fix 1: v2 > v3',
            },
            {
              fromVersion: 3,
              toVersion: 3,
              summary: 'Extra Fix 2 made no artifact changes; 1 gap remains in PRD Candidate v3.',
              gaps: ['Remaining approval gap.'],
              auditNotes: 'status: gaps',
              fromContent: buildPrdDocumentContent({ epicTitle: 'Extra fixed PRD' }),
              toContent: buildPrdDocumentContent({ epicTitle: 'Extra fixed PRD' }),
              gapResolutions: [],
              resolutionNotes: [],
              source: 'ai_fix_button',
              extraFixNumber: 2,
              noChange: true,
              label: 'Extra Fix 2: no change',
            },
          ],
        })}
      />,
    )

    expect(
      screen
        .getAllByRole('button')
        .map((button) => button.textContent?.trim() ?? '')
        .filter((label) => /^v\d+ > v\d+$/.test(label) || /^Extra Fix \d+/.test(label) || label === 'Latest Check'),
    ).toEqual(['v1 > v2', 'Extra Fix 1: v2 > v3', 'Extra Fix 2: no change', 'Latest Check'])
    expect(screen.getByText('PRD Candidate v4 still has 1 gap.')).toBeInTheDocument()
  })

  it('uses implementation plan wording for versioned beads coverage reports', () => {
    render(
      <ArtifactContent
        artifactId="coverage-report"
        phase="WAITING_BEADS_APPROVAL"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          status: 'clean',
          summary: 'No remaining coverage gaps found in Implementation Plan v3.',
          finalCandidateVersion: 3,
          hasRemainingGaps: false,
          remainingGaps: [],
          attempts: [
            {
              candidateVersion: 2,
              status: 'gaps',
              summary: 'Implementation Plan v2 still had 1 gap.',
              gaps: ['Stale attempt gap that must not appear when no gaps remain.'],
              auditNotes: 'status: gaps',
            },
          ],
          transitions: [
            {
              fromVersion: 2,
              toVersion: 3,
              summary: 'Coverage found 1 gap in Implementation Plan v2 and created Implementation Plan v3.',
              gaps: ['Implementation plan v2 still omitted explicit rollout validation.'],
              auditNotes: 'status: gaps',
              fromContent: buildBeadsDraftContent({ title: 'Implementation Plan v2' }),
              toContent: buildBeadsDraftContent({ title: 'Implementation Plan v3' }),
              gapResolutions: [],
              resolutionNotes: [],
            },
          ],
        })}
      />,
    )

    expect(screen.getByText('No open coverage gaps remain for Implementation Plan v3')).toBeInTheDocument()
    expect(screen.queryByText(/Open Coverage Gaps in Implementation Plan v3/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Stale attempt gap that must not appear when no gaps remain.')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /v2 > v3/i }))

    expect(screen.getByText('Coverage Gaps Found in Implementation Plan v2')).toBeInTheDocument()
    expect(screen.getByText('Implementation plan v2 still omitted explicit rollout validation.')).toBeInTheDocument()
  })

  it('shows a friendly clean summary for PRD coverage results', () => {
    render(
      <ArtifactContent
        artifactId="prd-coverage-result"
        phase="VERIFYING_PRD_COVERAGE"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.4',
          response: 'status: clean\ngaps: []\nfollow_up_questions: []',
          hasGaps: false,
          coverageRunNumber: 1,
          maxCoveragePasses: 2,
          limitReached: false,
          terminationReason: 'clean',
          parsed: {
            status: 'clean',
            gaps: [],
            followUpQuestions: [],
          },
        })}
      />,
    )

    expect(screen.getByText('No coverage gaps found')).toBeInTheDocument()
    expect(screen.getByText('The current PRD candidate covers the winner Full Answers. No gaps were found in this check.')).toBeInTheDocument()
    expect(screen.getByText(/Coverage review of the current PRD candidate · pass 1 of 2/i)).toBeInTheDocument()
  })

  it('shows friendly labels for nested PRD technical requirement diffs', () => {
    render(
      <ArtifactContent
        artifactId="refined-prd"
        phase="REFINING_PRD"
        content={JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          winnerDraftContent: buildPrdDocumentContent({
            architectureConstraint: 'Keep the old pipeline intact.',
          }),
          refinedContent: buildPrdDocumentContent({
            architectureConstraint: 'Keep the diff UI aligned with the final PRD labels.',
          }),
        })}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /^Diff(?: \(\d+\))?$/i }))

    expect(screen.getByText('Technical Requirements')).toBeInTheDocument()
    expect(screen.getByText('Architecture Constraints')).toBeInTheDocument()
    expect(screen.queryByText('technical_requirements.architecture_constraints')).not.toBeInTheDocument()
    expect(screen.getByText(hasExactTextContent('- Keep the old pipeline intact.'))).toBeInTheDocument()
    expect(screen.getByText(hasExactTextContent('- Keep the diff UI aligned with the final PRD labels.'))).toBeInTheDocument()
  })

  it('falls back to raw content for unparseable PRD drafts', () => {
    render(
      <ArtifactContent
        artifactId="prd-draft-member-openai%2Fgpt-5.2"
        phase="DRAFTING_PRD"
        content={JSON.stringify({
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: 'plain draft text without PRD structure',
            },
          ],
          memberOutcomes: {
            'openai/gpt-5.2': 'completed',
          },
        })}
      />,
    )

    expect(screen.getByText('plain draft text without PRD structure')).toBeInTheDocument()
    expect(screen.queryByText(/Epics \(/)).not.toBeInTheDocument()
  })

  it('renders PRD vote details with voter progress, rankings, and presentation order', () => {
    render(
      <ArtifactContent
        artifactId="prd-votes"
        phase="COUNCIL_VOTING_PRD"
        content={JSON.stringify({
          drafts: [
            { memberId: 'vendor/draft-a', outcome: 'completed', content: 'draft-a' },
            { memberId: 'vendor/draft-b', outcome: 'completed', content: 'draft-b' },
          ],
          votes: [
            {
              voterId: 'vendor/voter-a',
              draftId: 'vendor/draft-a',
              totalScore: 91,
              scores: [
                { category: 'Coverage of requirements', score: 18, justification: 'Strong coverage' },
                { category: 'Correctness / feasibility', score: 19, justification: 'Feasible' },
                { category: 'Testability', score: 18, justification: 'Testable' },
                { category: 'Minimal complexity / good decomposition', score: 18, justification: 'Well scoped' },
                { category: 'Risks / edge cases addressed', score: 18, justification: 'Good risk handling' },
              ],
            },
          ],
          voterOutcomes: {
            'vendor/voter-a': 'completed',
            'vendor/voter-b': 'pending',
          },
          presentationOrders: {
            'vendor/voter-a': {
              seed: 'seed-alpha-1234',
              order: ['vendor/draft-b', 'vendor/draft-a'],
            },
          },
          winnerId: 'vendor/draft-a',
          totalScore: 91,
          isFinal: true,
        })}
      />,
    )

    expect(screen.getByText('Voter Status')).toBeInTheDocument()
    expect(screen.getAllByText('draft-a').length).toBeGreaterThan(0)
    expect(screen.getByText('Rankings')).toBeInTheDocument()
    expect(screen.getByText('Score Breakdown')).toBeInTheDocument()

    fireEvent.click(screen.getByText(/Voter Details/i).closest('button')!)
    expect(screen.getByText('Presentation Order')).toBeInTheDocument()
    expect(screen.getByText(/seed seed-alp/i)).toBeInTheDocument()
    expect(screen.getByText('Draft 1: draft-b')).toBeInTheDocument()
    expect(screen.getByText('Draft 2: draft-a')).toBeInTheDocument()
  })

  it('switches vote raw tabs between all models, exact voter raw, and validated voter output', async () => {
    const writeTextMock = mockClipboard()

    const firstRawResponse = '<think>Scoring each draft.</think>\n\ndraft_scores:\n  Draft 1:\n    total_score: 91'
    const firstNormalizedResponse = 'draft_scores:\n  Draft 1:\n    total_score: 91\n'
    const secondRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 89\n  Draft 2:\n    total_score: 86'
    const content = JSON.stringify({
      drafts: [
        { memberId: 'vendor/draft-a', outcome: 'completed', content: 'draft-a' },
        { memberId: 'vendor/draft-b', outcome: 'completed', content: 'draft-b' },
      ],
      votes: [
        {
          voterId: 'vendor/voter-a',
          draftId: 'vendor/draft-a',
          totalScore: 91,
          scores: [
            { category: 'Coverage of requirements', score: 19 },
            { category: 'Correctness / feasibility', score: 18 },
          ],
        },
      ],
      voterOutcomes: {
        'vendor/voter-a': 'completed',
        'vendor/voter-b': 'completed',
      },
      voterDetails: [
        {
          voterId: 'vendor/voter-a',
          rawResponse: firstRawResponse,
          normalizedResponse: firstNormalizedResponse,
          structuredOutput: { repairApplied: true, repairWarnings: ['Recovered structured scorecard.'], autoRetryCount: 0 },
        },
        { voterId: 'vendor/voter-b', rawResponse: secondRawResponse },
      ],
      winnerId: 'vendor/draft-a',
      isFinal: true,
    })

    render(<ArtifactContent artifactId="prd-votes" phase="COUNCIL_VOTING_PRD" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const allModelsButton = screen.getByRole('button', { name: 'All Models' })
    expect(allModelsButton).toHaveAttribute('aria-pressed', 'true')
    const voterAGroup = screen.getByRole('group', { name: /voter-a raw output/i })
    expect(within(voterAGroup).getByText('voter-a')).toBeInTheDocument()
    expect(within(voterAGroup).queryByRole('button', { name: /voter-a$/ })).not.toBeInTheDocument()
    expect(within(voterAGroup).getByRole('button', { name: /voter-a Raw Output/ })).toBeInTheDocument()
    expect(within(voterAGroup).getByRole('button', { name: /voter-a Validated/ })).toBeInTheDocument()
    const allModelsPre = screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && element.textContent?.includes('<think>Scoring each draft.</think>')
      && !element.textContent.includes('\\n  Draft 1'),
    )
    expect(allModelsPre).toBeInTheDocument()
    await clickCopyRawOutput()
    expect(writeTextMock).toHaveBeenLastCalledWith(content)

    fireEvent.click(within(voterAGroup).getByRole('button', { name: /voter-a Raw Output/ }))

    expect(within(voterAGroup).getByRole('button', { name: /voter-a Raw Output/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText(`${firstRawResponse.split('\n').length.toLocaleString()} Lines`)).toBeInTheDocument()
    expect(screen.getByText(`${firstRawResponse.length.toLocaleString()} Characters`)).toBeInTheDocument()
    expect(screen.getByText(`${encode(firstRawResponse).length.toLocaleString()} Tokens (GPT-5 tokenizer)`)).toBeInTheDocument()
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === firstRawResponse)).toBeInTheDocument()

    await clickCopyRawOutput()

    expect(writeTextMock).toHaveBeenLastCalledWith(firstRawResponse)

    fireEvent.click(within(voterAGroup).getByRole('button', { name: /voter-a Validated/ }))

    expect(within(voterAGroup).getByRole('button', { name: /voter-a Validated/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === firstNormalizedResponse)).toBeInTheDocument()
    await clickCopyRawOutput()
    expect(writeTextMock).toHaveBeenLastCalledWith(firstNormalizedResponse)
  })

  it('shows rejected vote raw output from logs when a vote needed a structured retry', () => {
    const voterId = 'vendor/voter-a'
    const rejectedRawResponse = 'I think Draft 1 is best, but here is prose instead of YAML.'
    const acceptedRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 91'
    const validatedResponse = 'draft_scores:\n  Draft 1:\n    total_score: 91\n'
    const content = JSON.stringify({
      drafts: [
        { memberId: 'vendor/draft-a', outcome: 'completed', content: 'draft-a' },
      ],
      votes: [
        {
          voterId,
          draftId: 'vendor/draft-a',
          totalScore: 91,
          scores: [{ category: 'Coverage of requirements', score: 19 }],
        },
      ],
      voterOutcomes: {
        [voterId]: 'completed',
      },
      voterDetails: [
        {
          voterId,
          rawResponse: acceptedRawResponse,
          normalizedResponse: validatedResponse,
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Vote scorecard output required a structured retry',
          }),
        },
      ],
      winnerId: 'vendor/draft-a',
      isFinal: true,
    })
    const logs = [
      makeLogEntry(`[MODEL] ${rejectedRawResponse}`, { modelId: voterId, source: `model:${voterId}`, audience: 'ai', kind: 'text' }),
      makeLogEntry(`[MODEL] ${acceptedRawResponse}`, { modelId: voterId, source: `model:${voterId}`, audience: 'ai', kind: 'text' }),
    ]

    renderWithLogContext(<ArtifactContent artifactId="prd-votes" phase="COUNCIL_VOTING_PRD" content={content} />, {
      COUNCIL_VOTING_PRD: logs,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    expect(screen.queryByRole('button', { name: 'All Models' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Artifact' })).not.toBeInTheDocument()
    const voterGroup = screen.getByRole('group', { name: /voter-a raw output/i })
    expect(within(voterGroup).getByText('voter-a')).toBeInTheDocument()
    expect(within(voterGroup).queryByRole('button', { name: /voter-a$/ })).not.toBeInTheDocument()
    expect(within(voterGroup).queryByRole('button', { name: /voter-a Raw Output/ })).not.toBeInTheDocument()
    expect(within(voterGroup).getByRole('button', { name: /voter-a Attempt 2 Validated/ })).toBeInTheDocument()
    const rejectedButton = within(voterGroup).getByRole('button', { name: /voter-a Attempt 1 Output - Rejected/ })
    expect(rejectedButton).toBeEnabled()

    fireEvent.click(rejectedButton)

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedRawResponse)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === acceptedRawResponse)).not.toBeInTheDocument()
  })

  it('reconstructs a validated vote raw source for legacy repaired vote artifacts', () => {
    const messyRawResponse = '<think>I compared the drafts.</think>\n\ndraft_scores:\nDraft 1:\n  total_score: 91'
    const content = JSON.stringify({
      drafts: [
        { memberId: 'vendor/draft-a', outcome: 'completed', content: 'draft-a' },
        { memberId: 'vendor/draft-b', outcome: 'completed', content: 'draft-b' },
      ],
      votes: [
        {
          voterId: 'vendor/voter-a',
          draftId: 'vendor/draft-a',
          totalScore: 91,
          scores: [
            { category: 'Coverage of requirements', score: 19 },
            { category: 'Correctness / feasibility', score: 18 },
          ],
        },
        {
          voterId: 'vendor/voter-a',
          draftId: 'vendor/draft-b',
          totalScore: 86,
          scores: [
            { category: 'Coverage of requirements', score: 17 },
            { category: 'Correctness / feasibility', score: 16 },
          ],
        },
      ],
      voterOutcomes: {
        'vendor/voter-a': 'completed',
      },
      presentationOrders: {
        'vendor/voter-a': {
          seed: 'seed-alpha',
          order: ['vendor/draft-a', 'vendor/draft-b'],
        },
      },
      voterDetails: [
        {
          voterId: 'vendor/voter-a',
          rawResponse: messyRawResponse,
          structuredOutput: { repairApplied: true, repairWarnings: ['Recovered structured scorecard.'], autoRetryCount: 0 },
        },
      ],
      winnerId: 'vendor/draft-a',
      isFinal: true,
    })

    render(<ArtifactContent artifactId="prd-votes" phase="COUNCIL_VOTING_PRD" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    fireEvent.click(screen.getByRole('button', { name: /voter-a Validated/ }))

    expect(screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && element.textContent?.includes('draft_scores:')
      && element.textContent.includes('Draft 2:')
      && element.textContent.includes('total_score: 86')
      && !element.textContent.includes('<think>'),
    )).toBeInTheDocument()
  })

  it('does not fabricate a validated vote raw source for invalid prompt-echo output without votes', () => {
    const content = JSON.stringify({
      votes: [],
      voterOutcomes: {
        'vendor/voter-a': 'invalid_output',
      },
      voterDetails: [
        {
          voterId: 'vendor/voter-a',
          rawResponse: 'CRITICAL OUTPUT RULE:\nReturn only YAML.',
          error: 'Vote scorecard output echoed the prompt instead of returning a structured scorecard',
          structuredOutput: { repairApplied: false, repairWarnings: [], autoRetryCount: 1 },
        },
      ],
      isFinal: false,
    })

    render(<ArtifactContent artifactId="prd-votes" phase="COUNCIL_VOTING_PRD" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const voterGroup = screen.getByRole('group', { name: /voter-a raw output/i })
    expect(within(voterGroup).queryByRole('button', { name: /voter-a$/ })).not.toBeInTheDocument()
    expect(within(voterGroup).getByRole('button', { name: /voter-a Raw Output/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /voter-a Validated/ })).not.toBeInTheDocument()
  })

  it('keeps legacy vote raw details on all models when exact voter raw responses are missing', () => {
    const content = JSON.stringify({
      drafts: [
        { memberId: 'vendor/draft-a', outcome: 'completed', content: 'draft-a' },
        { memberId: 'vendor/draft-b', outcome: 'completed', content: 'draft-b' },
      ],
      votes: [
        {
          voterId: 'vendor/voter-a',
          draftId: 'vendor/draft-a',
          totalScore: 91,
          scores: [{ category: 'Coverage of requirements', score: 19 }],
        },
      ],
      voterOutcomes: {
        'vendor/voter-a': 'completed',
        'vendor/voter-b': 'pending',
      },
      winnerId: 'vendor/draft-a',
      isFinal: true,
    })

    render(<ArtifactContent artifactId="prd-votes" phase="COUNCIL_VOTING_PRD" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    expect(screen.getByRole('button', { name: 'All Models' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /voter-a/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /voter-b/ })).toBeDisabled()
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === content)).toBeInTheDocument()
  })

  it.each([
    {
      label: 'interview',
      artifactId: 'winner-draft',
      phase: 'COUNCIL_VOTING_INTERVIEW',
      draftContent: 'questions:\n  - id: Q01\n    phase: foundation\n    question: "Winning interview question?"',
    },
    {
      label: 'PRD',
      artifactId: 'winner-prd-draft',
      phase: 'COUNCIL_VOTING_PRD',
      draftContent: buildPrdDocumentContent({ epicTitle: 'Winning PRD draft raw content' }),
    },
    {
      label: 'beads',
      artifactId: 'winner-beads-draft',
      phase: 'COUNCIL_VOTING_BEADS',
      draftContent: buildBeadsDraftContent({ title: 'Winning beads draft raw content' }),
    },
  ])('keeps $label winner raw views on the winning draft when voting logs are present', ({ artifactId, phase, draftContent }) => {
    const winnerId = 'vendor/draft-a'
    const voteRawResponse = 'draft_scores:\n  Draft 1:\n    total_score: 99'
    const content = JSON.stringify({
      drafts: [
        {
          memberId: winnerId,
          outcome: 'completed',
          content: draftContent,
          structuredOutput: {
            repairApplied: true,
            repairWarnings: ['Normalized the winning draft.'],
            autoRetryCount: 0,
          },
        },
      ],
      votes: [
        {
          voterId: winnerId,
          draftId: winnerId,
          totalScore: 99,
          scores: [{ category: 'Coverage of requirements', score: 20 }],
        },
      ],
      voterOutcomes: { [winnerId]: 'completed' },
      winnerId,
      isFinal: true,
    })
    const logs = [
      makeLogEntry(`[MODEL] ${voteRawResponse}`, {
        modelId: winnerId,
        source: `model:${winnerId}`,
        status: phase,
        audience: 'ai',
        kind: 'text',
      }),
    ]

    renderWithLogContext(<ArtifactContent artifactId={artifactId} phase={phase} content={content} />, {
      [phase]: logs,
    })

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const draftGroup = screen.getByRole('group', { name: /draft-a raw output/i })
    expect(within(draftGroup).queryByRole('button', { name: /draft-a Raw Output/ })).not.toBeInTheDocument()
    expect(within(draftGroup).getByRole('button', { name: /draft-a Validated/ })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === draftContent)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === voteRawResponse)).not.toBeInTheDocument()
  })

  it.each([
    {
      label: 'voting winner',
      artifactId: 'winner-prd-draft',
      phase: 'COUNCIL_VOTING_PRD',
    },
    {
      label: 'refining previous draft',
      artifactId: `prd-draft-member-${encodeURIComponent('vendor/draft-a')}`,
      phase: 'REFINING_PRD',
    },
  ])('shows only the validated draft in Raw for a $label artifact', ({ artifactId, phase }) => {
    const modelId = 'vendor/draft-a'
    const rejectedDraftResponse = 'schema_version: 1\nartifact: prd\nstatus: draft\nepics: []'
    const rawDraftResponse = `<think>Normalizing PRD.</think>\n\n${buildPrdDocumentContent({ epicTitle: 'Wrapped PRD draft' })}`
    const validatedDraftResponse = buildPrdDocumentContent({ epicTitle: 'Validated PRD draft' })
    const content = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: validatedDraftResponse,
          rawResponse: rawDraftResponse,
          normalizedResponse: validatedDraftResponse,
          rawAttempts: [
            {
              attempt: 1,
              outcome: 'rejected',
              rawResponse: rejectedDraftResponse,
              validationError: 'Missing user stories.',
            },
            {
              attempt: 2,
              outcome: 'accepted',
              rawResponse: rawDraftResponse,
            },
          ],
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Missing user stories.',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
      votes: [
        {
          voterId: modelId,
          draftId: modelId,
          totalScore: 99,
          scores: [{ category: 'Coverage of requirements', score: 20 }],
        },
      ],
      voterOutcomes: { [modelId]: 'completed' },
      winnerId: modelId,
      isFinal: true,
    })

    render(<ArtifactContent artifactId={artifactId} phase={phase} content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const draftGroup = screen.getByRole('group', { name: /draft-a raw output/i })
    expect(within(draftGroup).getAllByRole('button').map((button) => button.textContent)).toEqual(['Validated'])
    expect(within(draftGroup).queryByRole('button', { name: /draft-a Raw Output/ })).not.toBeInTheDocument()
    expect(within(draftGroup).queryByRole('button', { name: /draft-a Rejected/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /draft-a Attempt 1 Output - Rejected/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /draft-a Attempt 2 Output - Accepted/ })).not.toBeInTheDocument()
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === validatedDraftResponse)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rawDraftResponse)).not.toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedDraftResponse)).not.toBeInTheDocument()
  })

  it('switches draft raw tabs between raw output and validated version when both exist', async () => {
    const writeTextMock = mockClipboard()

    const rawDraftResponse = '<think>Building interview questions.</think>\n\nquestions:\n  - text: What is the scope?'
    const validatedDraftResponse = 'questions:\n  - text: What is the scope?\n'
    const content = JSON.stringify({
      drafts: [
        {
          memberId: 'vendor/draft-a',
          outcome: 'completed',
          content: validatedDraftResponse,
          rawResponse: rawDraftResponse,
          normalizedResponse: validatedDraftResponse,
          structuredOutput: { repairApplied: true, repairWarnings: ['Stripped thinking block.'], autoRetryCount: 0 },
        },
      ],
      memberOutcomes: { 'vendor/draft-a': 'completed' },
      isFinal: true,
    })

    render(<ArtifactContent artifactId="draft-member-vendor%2Fdraft-a" phase="COUNCIL_DRAFTING_INTERVIEW" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    expect(screen.queryByRole('button', { name: 'All Models' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Artifact' })).not.toBeInTheDocument()
    const draftGroup = screen.getByRole('group', { name: /draft-a raw output/i })
    expect(within(draftGroup).getByRole('button', { name: /draft-a Raw Output/ })).toBeInTheDocument()
    expect(within(draftGroup).getByRole('button', { name: /draft-a Validated/ })).toBeInTheDocument()

    fireEvent.click(within(draftGroup).getByRole('button', { name: /draft-a Raw Output/ }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rawDraftResponse)).toBeInTheDocument()
    await clickCopyRawOutput()
    expect(writeTextMock).toHaveBeenLastCalledWith(rawDraftResponse)

    fireEvent.click(within(draftGroup).getByRole('button', { name: /draft-a Validated/ }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === validatedDraftResponse)).toBeInTheDocument()
    await clickCopyRawOutput()
    expect(writeTextMock).toHaveBeenLastCalledWith(validatedDraftResponse)
  })

  it('shows a draft adjustment notice when raw and validated output differ without parser warnings', () => {
    const rawDraftResponse = 'questions:\n  - id: Q1\n    question: What is the scope?'
    const validatedDraftResponse = 'questions:\n  - id: Q01\n    question: What is the scope?\n'
    const content = JSON.stringify({
      drafts: [
        {
          memberId: 'vendor/draft-a',
          outcome: 'completed',
          content: validatedDraftResponse,
          rawResponse: rawDraftResponse,
          normalizedResponse: validatedDraftResponse,
          structuredOutput: { repairApplied: false, repairWarnings: [], autoRetryCount: 0 },
        },
      ],
      memberOutcomes: { 'vendor/draft-a': 'completed' },
      isFinal: true,
    })

    render(<ArtifactContent artifactId="draft-member-vendor%2Fdraft-a" phase="COUNCIL_DELIBERATING" content={content} />)

    expect(screen.getByText('LoopTroop adjusted this interview draft.')).toBeInTheDocument()
    expect(screen.getByText('Cleanup 1')).toBeInTheDocument()

    openNotice('LoopTroop adjusted this interview draft.')
    expect(screen.getAllByText((_text, element) =>
      element?.tagName === 'PRE'
      && element.textContent === 'Normalized saved artifact details from raw model output before saving the validated artifact.',
    )).toHaveLength(1)
    expect(screen.queryByText(/Raw Source Messages/i)).not.toBeInTheDocument()
  })

  it('shows a vote adjustment notice when raw and validated scorecards differ without parser warnings', () => {
    const rawVoteResponse = 'draft_scores:\n  Draft 1:\n    total_score: 91'
    const validatedVoteResponse = 'draft_scores:\n  Draft 1:\n    total_score: 91\n'
    const content = JSON.stringify({
      drafts: [
        { memberId: 'vendor/draft-a', outcome: 'completed', content: 'draft-a' },
      ],
      votes: [
        {
          voterId: 'vendor/voter-a',
          draftId: 'vendor/draft-a',
          totalScore: 91,
          scores: [{ category: 'Coverage of requirements', score: 19 }],
        },
      ],
      voterOutcomes: { 'vendor/voter-a': 'completed' },
      voterDetails: [
        {
          voterId: 'vendor/voter-a',
          rawResponse: rawVoteResponse,
          normalizedResponse: validatedVoteResponse,
          structuredOutput: { repairApplied: false, repairWarnings: [], autoRetryCount: 0 },
        },
      ],
      winnerId: 'vendor/draft-a',
      isFinal: true,
    })

    render(<ArtifactContent artifactId="prd-votes" phase="COUNCIL_VOTING_PRD" content={content} />)

    expect(screen.getByText('LoopTroop adjusted some vote scorecards.')).toBeInTheDocument()
    expect(screen.getByText('Cleanup 1')).toBeInTheDocument()
    openNotice('LoopTroop adjusted some vote scorecards.')
    expect(screen.getByText('Affected Models')).toBeInTheDocument()
    expect(screen.getAllByText('voter-a').length).toBeGreaterThan(0)
  })

  it('recovers missing PRD Full Answers raw output from phase logs', () => {
    const modelId = 'opencode/hy3-preview-free'
    const rawFullAnswers = 'schema_version: 1\nticket_id: TEST\nartifact: interview\ngenerated_by:\n  winner_model: wrong-model'
    const validatedFullAnswers = 'schema_version: 1\nticket_id: TEST\nartifact: interview\ngenerated_by:\n  winner_model: opencode/hy3-preview-free\n'
    const rawPrdDraft = 'schema_version: 1\nartifact: prd\nstatus: draft'
    const content = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: validatedFullAnswers,
          structuredOutput: { repairApplied: true, repairWarnings: ['Canonicalized generated_by.winner_model.'], autoRetryCount: 0 },
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
      isFinal: true,
    })
    const logs = [
      makeLogEntry(`[SYS] ${modelId} Full Answers started.`, { modelId, source: 'system' }),
      makeLogEntry(`[MODEL] ${rawFullAnswers}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
      makeLogEntry(`[SYS] ${modelId} Full Answers completed.`, { modelId, source: 'system' }),
      makeLogEntry(`[SYS] ${modelId} PRD draft started.`, { modelId, source: 'system' }),
      makeLogEntry(`[MODEL] ${rawPrdDraft}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
    ]

    renderWithLogContext(
      <ArtifactContent artifactId={`prd-fullanswers-member-${encodeURIComponent(modelId)}`} phase="DRAFTING_PRD" content={content} />,
      { DRAFTING_PRD: logs },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const draftGroup = screen.getByRole('group', { name: /hy3-preview-free raw output/i })
    const rawButton = within(draftGroup).getByRole('button', { name: /hy3-preview-free Raw Output/ })
    expect(rawButton).toBeEnabled()
    fireEvent.click(rawButton)
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rawFullAnswers)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rawPrdDraft)).not.toBeInTheDocument()
    expect(within(draftGroup).getByRole('button', { name: /hy3-preview-free Validated/ })).toBeInTheDocument()
  })

  it('shows rejected draft raw output from logs next to raw and validated draft output', () => {
    const modelId = 'openai/gpt-5.2'
    const rejectedRawResponse = 'schema_version: 1\nartifact: prd\nstatus: draft\nepics: []'
    const acceptedRawResponse = `${buildPrdDocumentContent()}\n`
    const validatedResponse = buildPrdDocumentContent()
    const content = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: validatedResponse,
          rawResponse: acceptedRawResponse,
          normalizedResponse: validatedResponse,
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Every epic must include at least one user story',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
      isFinal: true,
    })
    const logs = [
      makeLogEntry(`[SYS] ${modelId} PRD draft started.`, { modelId, source: 'system' }),
      makeLogEntry(`[MODEL] ${rejectedRawResponse}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
      makeLogEntry(`[MODEL] ${acceptedRawResponse}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
    ]

    renderWithLogContext(
      <ArtifactContent artifactId={`prd-draft-member-${encodeURIComponent(modelId)}`} phase="DRAFTING_PRD" content={content} />,
      { DRAFTING_PRD: logs },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const draftGroup = screen.getByRole('group', { name: /gpt-5.2 raw output/i })
    expect(within(draftGroup).getByText('gpt-5.2')).toBeInTheDocument()
    expect(within(draftGroup).queryByRole('button', { name: /^gpt-5.2$/ })).not.toBeInTheDocument()
    expect(within(draftGroup).queryByRole('button', { name: /gpt-5.2 Raw Output/ })).not.toBeInTheDocument()
    expect(within(draftGroup).getByRole('button', { name: /gpt-5.2 Attempt 2 Validated/ })).toBeInTheDocument()
    const rejectedButton = within(draftGroup).getByRole('button', { name: /gpt-5.2 Attempt 1 Output - Rejected/ })
    expect(rejectedButton).toBeEnabled()
    expect(within(draftGroup).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Attempt 1 Output - Rejected',
      'Attempt 2 Validated',
    ])
    expect(within(draftGroup).getByText('Attempt 1 Output - Rejected')).toHaveClass('italic')

    fireEvent.click(rejectedButton)

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedRawResponse)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === acceptedRawResponse)).not.toBeInTheDocument()
  })

  it('prefers rawAttempts over log-derived rejected draft output', () => {
    const modelId = 'openai/gpt-5.2'
    const loggedRejectedRawResponse = 'logged rejected draft'
    const attemptedRejectedRawResponse = 'attempt recorded rejected draft'
    const acceptedRawResponse = `${buildPrdDocumentContent()}\n`
    const validatedResponse = buildPrdDocumentContent()
    const content = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: validatedResponse,
          rawResponse: acceptedRawResponse,
          normalizedResponse: validatedResponse,
          rawAttempts: [
            {
              attempt: 1,
              status: 'invalid_output',
              rawResponse: attemptedRejectedRawResponse,
              validationError: 'Missing user stories.',
            },
          ],
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Every epic must include at least one user story',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
    })
    const logs = [
      makeLogEntry(`[SYS] ${modelId} PRD draft started.`, { modelId, source: 'system' }),
      makeLogEntry(`[MODEL] ${loggedRejectedRawResponse}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
      makeLogEntry(`[MODEL] ${acceptedRawResponse}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
    ]

    renderWithLogContext(
      <ArtifactContent artifactId={`prd-draft-member-${encodeURIComponent(modelId)}`} phase="DRAFTING_PRD" content={content} />,
      { DRAFTING_PRD: logs },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.queryByRole('button', { name: /^gpt-5.2 Rejected$/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /gpt-5.2 Raw Output/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /gpt-5.2 Attempt 1 Output - Rejected/ }))

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === attemptedRejectedRawResponse)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === loggedRejectedRawResponse)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /gpt-5.2 Attempt 1/ })).toBeInTheDocument()
  })

  it('labels validated draft output with the accepted retry attempt number', () => {
    const modelId = 'vendor/draft-a'
    const rejectedRawResponse = 'questions: prose instead of structured interview yaml'
    const acceptedRawResponse = '<think>Normalizing question ids.</think>\n\nquestions:\n  - id: Q1\n    question: What is the scope?'
    const validatedResponse = 'questions:\n  - id: Q01\n    question: What is the scope?\n'
    const content = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: validatedResponse,
          rawResponse: acceptedRawResponse,
          normalizedResponse: validatedResponse,
          rawAttempts: [
            {
              attempt: 1,
              outcome: 'rejected',
              rawResponse: rejectedRawResponse,
              validationError: 'Missing required question fields.',
            },
            {
              attempt: 2,
              outcome: 'accepted',
              rawResponse: acceptedRawResponse,
            },
          ],
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Missing required question fields.',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
    })

    render(<ArtifactContent artifactId={`draft-member-${encodeURIComponent(modelId)}`} phase="COUNCIL_DRAFTING_INTERVIEW" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const draftGroup = screen.getByRole('group', { name: /draft-a raw output/i })
    expect(within(draftGroup).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Attempt 1 Output - Rejected',
      'Attempt 2 Output - Accepted',
      'Attempt 2 Validated',
    ])

    fireEvent.click(within(draftGroup).getByRole('button', { name: /draft-a Attempt 2 Validated/ }))

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === validatedResponse)).toBeInTheDocument()
  })

  it('deduplicates raw output and retry shortcuts when raw attempts have the same payloads', () => {
    const modelId = 'openai/gpt-5.2'
    const rejectedRawResponse = 'rejected draft payload'
    const acceptedRawResponse = `${buildPrdDocumentContent()}\n`
    const validatedResponse = buildPrdDocumentContent()
    const content = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: validatedResponse,
          rawResponse: acceptedRawResponse,
          normalizedResponse: validatedResponse,
          rawAttempts: [
            {
              attempt: 1,
              outcome: 'rejected',
              rawResponse: rejectedRawResponse,
              validationError: 'Missing user stories.',
            },
            {
              attempt: 2,
              outcome: 'accepted',
              rawResponse: acceptedRawResponse,
            },
          ],
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Every epic must include at least one user story',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
    })

    render(<ArtifactContent artifactId={`prd-draft-member-${encodeURIComponent(modelId)}`} phase="DRAFTING_PRD" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const draftGroup = screen.getByRole('group', { name: /gpt-5.2 raw output/i })
    expect(within(draftGroup).queryByRole('button', { name: /gpt-5.2 Raw Output/ })).not.toBeInTheDocument()
    expect(within(draftGroup).queryByRole('button', { name: /^gpt-5.2 Rejected$/ })).not.toBeInTheDocument()
    expect(within(draftGroup).queryByRole('button', { name: /gpt-5.2 Validated/ })).not.toBeInTheDocument()
    expect(within(draftGroup).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Attempt 1 Output - Rejected',
      'Attempt 2 Validated',
    ])
    // Validated variant is selected by default now
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === validatedResponse)).toBeInTheDocument()

    fireEvent.click(within(draftGroup).getByRole('button', { name: /Attempt 1 Output - Rejected/i }))

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedRawResponse)).toBeInTheDocument()

    fireEvent.click(within(draftGroup).getByRole('button', { name: /Attempt 2 Validated/i }))

    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === acceptedRawResponse.trimEnd())).toBeInTheDocument()
  })

  it('keeps rejected retry output disabled when retry metadata exists but logs are unavailable', () => {
    const modelId = 'openai/gpt-5.2'
    const acceptedRawResponse = buildPrdDocumentContent()
    const content = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: acceptedRawResponse,
          rawResponse: acceptedRawResponse,
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'PRD parser rejected the first pass',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
      isFinal: true,
    })

    renderWithLogContext(
      <ArtifactContent artifactId={`prd-draft-member-${encodeURIComponent(modelId)}`} phase="DRAFTING_PRD" content={content} />,
      { DRAFTING_PRD: [] },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const draftGroup = screen.getByRole('group', { name: /gpt-5.2 raw output/i })
    expect(within(draftGroup).getByRole('button', { name: /gpt-5.2 Raw Output/ })).toBeEnabled()
    expect(within(draftGroup).getByRole('button', { name: /gpt-5.2 Attempt 1 Output - Rejected/ })).toBeDisabled()
  })

  it('uses PRD drafting stage logs so Full Answers and PRD draft rejected outputs do not cross over', () => {
    const modelId = 'opencode/hy3-preview-free'
    const rejectedFullAnswers = 'full_answers: rejected prose'
    const acceptedFullAnswers = buildInterviewDocumentContent({
      questions: [
        {
          id: 'Q01',
          phase: 'Foundation',
          prompt: 'Which answer should be filled?',
          source: 'compiled',
          answer_type: 'free_text',
          options: [],
          answer: {
            skipped: false,
            free_text: 'Use the accepted full answer.',
            selected_option_ids: [],
            answered_by: 'ai_skip',
            answered_at: '2026-03-25T09:00:00.000Z',
          },
        },
      ],
    })
    const rejectedPrdDraft = 'prd: rejected prose'
    const acceptedPrdDraft = buildPrdDocumentContent()
    const logs = [
      makeLogEntry(`[SYS] ${modelId} Full Answers started.`, { modelId, source: 'system' }),
      makeLogEntry(`[MODEL] ${rejectedFullAnswers}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
      makeLogEntry(`[MODEL] ${acceptedFullAnswers}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
      makeLogEntry(`[SYS] ${modelId} Full Answers completed.`, { modelId, source: 'system' }),
      makeLogEntry(`[SYS] ${modelId} PRD draft started.`, { modelId, source: 'system' }),
      makeLogEntry(`[MODEL] ${rejectedPrdDraft}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
      makeLogEntry(`[MODEL] ${acceptedPrdDraft}`, { modelId, source: `model:${modelId}`, audience: 'ai', kind: 'text' }),
    ]
    const fullAnswersContent = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: acceptedFullAnswers,
          rawResponse: acceptedFullAnswers,
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Full Answers first pass was invalid',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
      isFinal: true,
    })
    const prdContent = JSON.stringify({
      drafts: [
        {
          memberId: modelId,
          outcome: 'completed',
          content: acceptedPrdDraft,
          rawResponse: acceptedPrdDraft,
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'PRD first pass was invalid',
          }),
        },
      ],
      memberOutcomes: { [modelId]: 'completed' },
      isFinal: true,
    })

    const { unmount } = renderWithLogContext(
      <ArtifactContent artifactId={`prd-fullanswers-member-${encodeURIComponent(modelId)}`} phase="DRAFTING_PRD" content={fullAnswersContent} />,
      { DRAFTING_PRD: logs },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    fireEvent.click(screen.getByRole('button', { name: /hy3-preview-free Attempt 1 Output - Rejected/ }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedFullAnswers)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedPrdDraft)).not.toBeInTheDocument()

    unmount()

    renderWithLogContext(
      <ArtifactContent artifactId={`prd-draft-member-${encodeURIComponent(modelId)}`} phase="DRAFTING_PRD" content={prdContent} />,
      { DRAFTING_PRD: logs },
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    fireEvent.click(screen.getByRole('button', { name: /hy3-preview-free Attempt 1 Output - Rejected/ }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedPrdDraft)).toBeInTheDocument()
    expect(screen.queryByText((_text, element) => element?.tagName === 'PRE' && element.textContent === rejectedFullAnswers)).not.toBeInTheDocument()
  })

  it('does not show raw/validated variant buttons for drafts without rawResponse', () => {
    const content = JSON.stringify({
      drafts: [
        {
          memberId: 'vendor/draft-a',
          outcome: 'completed',
          content: 'questions:\n  - text: What is the scope?\n',
        },
      ],
      memberOutcomes: { 'vendor/draft-a': 'completed' },
      isFinal: true,
    })

    render(<ArtifactContent artifactId="draft-member-vendor%2Fdraft-a" phase="COUNCIL_DRAFTING_INTERVIEW" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    expect(screen.queryByRole('group', { name: /draft-a raw output/i })).not.toBeInTheDocument()
  })

  it('classifies common parser notice repairs across structured artifacts', () => {
    const parserNoticeCases = [
      {
        artifactType: 'diff' as const,
        repairWarnings: [
          'Dropped no-op interview refinement modified at index 0 because the question is unchanged across the winning and final drafts.',
        ],
        expectedTitle: 'LoopTroop adjusted this diff.',
        expectedSummary: '1 intervention: No Op Change.',
        expectedIntervention: { category: 'dropped', code: 'dropped_no_op_change' },
      },
      {
        artifactType: 'diff' as const,
        repairWarnings: ['Inferred missing PRD refinement item_type at index 0 as epic.'],
        expectedTitle: 'LoopTroop adjusted this diff.',
        expectedSummary: '1 intervention: Missing Field Inference.',
        expectedIntervention: { category: 'synthesized', code: 'synthesized_inferred_detail' },
      },
      {
        artifactType: 'final-test' as const,
        repairWarnings: ['Removed surrounding markdown code fence before parsing the final test commands.'],
        expectedTitle: 'LoopTroop adjusted this final test plan.',
        expectedSummary: '1 intervention: Markdown Fence Unwrap.',
        expectedIntervention: { category: 'parser_fix', code: 'parser_markdown_fence' },
      },
      {
        artifactType: 'full-answers' as const,
        repairWarnings: [
          'Canonicalized generated_by.winner_model from "openai/gpt-5.4" to "github-copilot/gpt-4.1".',
        ],
        expectedIntervention: {
          code: 'cleanup_winner_model',
          exactCorrection: 'Changed generated_by.winner_model from "openai/gpt-5.4" to "github-copilot/gpt-4.1".',
          rule: {
            id: 'cleanup_winner_model',
            label: 'Winner Model',
          },
          examples: [
            {
              scope: 'generated_by.winner_model',
              before: 'openai/gpt-5.4',
              after: 'github-copilot/gpt-4.1',
            },
          ],
        },
      },
      {
        artifactType: 'diff' as const,
        repairWarnings: ['Synthesized missing PRD refinement change at index 0 from the validated records.'],
        expectedSummary: '1 intervention: Missing Detail.',
        expectedIntervention: { category: 'synthesized', code: 'synthesized_missing_detail' },
      },
    ]

    for (const testCase of parserNoticeCases) {
      const copy = buildArtifactProcessingNoticeCopy(futureStructuredOutput({
        repairApplied: true,
        repairWarnings: testCase.repairWarnings,
        autoRetryCount: 0,
      }), testCase.artifactType)

      if (testCase.expectedTitle) {
        expect(copy?.title).toBe(testCase.expectedTitle)
      }
      if (testCase.expectedSummary) {
        expect(copy?.summary).toBe(testCase.expectedSummary)
      }
      expect(copy?.interventions).toEqual([
        expect.objectContaining(testCase.expectedIntervention),
      ])
    }
  })

  it('describes retry-only parser interventions in the parser notice copy', () => {
    const copy = buildArtifactProcessingNoticeCopy(futureStructuredOutput({
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 1,
      validationError: 'Coverage parser rejected the first pass.',
    }), 'coverage')

    expect(copy?.summary).toBe('1 intervention: Validation Retry.')
    expect(copy?.body).toMatch(/validated this coverage review/i)
    expect(copy?.interventions).toEqual([
      expect.objectContaining({ category: 'retry', code: 'retry_after_validation_failure' }),
    ])
  })

  it('counts retry attempts rather than retry intervention rows in parser notice badges', () => {
    const copy = buildArtifactProcessingNoticeCopy(futureStructuredOutput({
      repairApplied: false,
      repairWarnings: [],
      autoRetryCount: 2,
      validationError: 'PRD parser rejected the second retry.',
    }), 'prd-draft')

    expect(copy?.badges).toEqual([
      expect.objectContaining({ label: 'Retries', count: 2 }),
    ])
    expect(copy?.interventions).toEqual([
      expect.objectContaining({ category: 'retry', code: 'retry_after_validation_failure' }),
    ])
  })

  it('counts aggregate notice badges from affected model intervention rows', () => {
    const ownerA = futureStructuredOutput({
      repairApplied: true,
      repairWarnings: [
        'Unwrapped markdown code fence wrapping the YAML payload.',
        'Canonicalized source_interview.content_sha256 from the approved Interview Results artifact.',
      ],
      autoRetryCount: 2,
      validationError: 'Vote parser rejected the second retry.',
    })
    const ownerB = futureStructuredOutput({
      repairApplied: true,
      repairWarnings: [
        'Unwrapped markdown code fence wrapping the YAML payload.',
        'Synthesized omitted beads refinement modified change for bead "bead-1" by matching id across the winning and refined drafts.',
        'Dropped no-op beads refinement modified change at index 0 because the winning and refined bead "bead-1" are identical.',
        'Cleared out-of-range beads refinement inspiration at index 0.',
      ],
      autoRetryCount: 0,
    })
    const copy = buildArtifactProcessingNoticeCopy(ownerA, 'vote-aggregate', {
      affectedCount: 2,
      ownerInterventions: [
        { label: 'model-a', structuredOutput: ownerA },
        { label: 'model-b', structuredOutput: ownerB },
      ],
    })

    expect(copy?.summary).toBe('7 interventions across 6 categories: Markdown Fence Unwrap, Content Hash, Validation Retry, +3 more.')
    expect(copy?.badges).toEqual([
      expect.objectContaining({ label: 'Parser Fix', count: 2 }),
      expect.objectContaining({ label: 'Cleanup', count: 1 }),
      expect.objectContaining({ label: 'Synthesized', count: 1 }),
      expect.objectContaining({ label: 'Dropped', count: 1 }),
      expect.objectContaining({ label: 'Attribution', count: 1 }),
      expect.objectContaining({ label: 'Retries', count: 2 }),
    ])
  })

  it('keeps reserved-scalar parser fixes separate from retry interventions in parser notices', () => {
    const copy = buildArtifactProcessingNoticeCopy(futureStructuredOutput({
      repairApplied: true,
      repairWarnings: ['Quoted plain YAML scalars that began with reserved indicator characters (` or @) before reparsing.'],
      autoRetryCount: 1,
      validationError: 'PRD parser rejected the first pass.',
    }), 'prd-draft')

    expect(copy?.summary).toBe('2 interventions across 2 categories: Reserved Scalar Repair, Validation Retry.')
    expect(copy?.badges).toEqual([
      expect.objectContaining({ label: 'Parser Fix', count: 1 }),
      expect.objectContaining({ label: 'Retries', count: 1 }),
    ])
    expect(copy?.interventions).toEqual([
      expect.objectContaining({
        category: 'parser_fix',
        code: 'parser_reserved_indicator_scalar',
        exactCorrection: 'Quoted the plain YAML scalar that began with a reserved indicator character before reparsing the payload.',
      }),
      expect.objectContaining({ category: 'retry', code: 'retry_after_validation_failure' }),
    ])
  })

  it('shows retry diagnostics with the failing excerpt in the expanded warning notice', () => {
    render(
      <ArtifactContent
        artifactId="relevant-files-scan"
        content={JSON.stringify({
          fileCount: 1,
          files: [
            {
              path: 'src/app.ts',
              rationale: 'Entry point',
              relevance: 'high',
              likely_action: 'modify',
              contentPreview: 'export const app = true',
              contentLength: 24,
            },
          ],
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Relevant files output was empty.',
            retryDiagnostics: [
              {
                attempt: 1,
                validationError: 'Relevant files output was empty.',
                target: 'files',
                line: 4,
                column: 3,
                excerpt: '  4 | files:\n  5 |   - path: src/app.ts',
              },
            ],
          }),
        })}
      />,
    )

    const noticeButton = screen.getByText('LoopTroop adjusted this relevant files scan.').closest('button')
    expect(noticeButton).toBeInTheDocument()
    expect(screen.queryByText(/Retry Attempts/i)).not.toBeInTheDocument()

    fireEvent.click(noticeButton!)

    expect(screen.queryByText(/Raw Source Messages/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Retry Attempts/i)).toBeInTheDocument()
    expect(screen.getByText('Attempt 1')).toBeInTheDocument()
    expect(screen.getAllByText('Relevant files output was empty.').length).toBeGreaterThan(0)
    expect(screen.getByText(/files · line 4, column 3/i)).toBeInTheDocument()
    expect(screen.getAllByText(/4 \| files:/i).length).toBeGreaterThan(0)
  })

  it('keeps multiple rejected relevant-files attempts available in Raw without duplicating the intervention warning', () => {
    render(
      <ArtifactContent
        artifactId="relevant-files-scan"
        content={JSON.stringify({
          fileCount: 0,
          files: [],
          modelId: 'openai/gpt-5.2',
          structuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Relevant files output still had no files.',
            retryDiagnostics: [
              {
                attempt: 1,
                validationError: 'Relevant files output was empty.',
                excerpt: '[empty response]',
              },
              {
                attempt: 2,
                validationError: 'Relevant files output still had no files.',
                excerpt: 'files: []',
              },
            ],
          }),
          rawAttempts: [
            {
              attempt: 1,
              stage: 'relevant_files_scan',
              outcome: 'rejected',
              rawResponse: '',
              validationError: 'Relevant files output was empty.',
            },
            {
              attempt: 2,
              stage: 'relevant_files_scan',
              outcome: 'rejected',
              rawResponse: 'files: []',
              validationError: 'Relevant files output still had no files.',
            },
          ],
        })}
      />,
    )

    expect(screen.getByText('LoopTroop adjusted this relevant files scan.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    expect(screen.queryByText('LoopTroop adjusted this relevant files scan.')).not.toBeInTheDocument()
    const rawGroup = screen.getByRole('group', { name: /relevant files raw attempts/i })
    expect(within(rawGroup).getByText(/gpt-5.2 · relevant files scan/i)).toBeInTheDocument()
    expect(within(rawGroup).getByRole('button', { name: /gpt-5.2 · relevant files scan Attempt 1 Output - Rejected/i })).toBeInTheDocument()
    expect(within(rawGroup).getByRole('button', { name: /gpt-5.2 · relevant files scan Attempt 2 Output - Rejected/i })).toBeInTheDocument()
    expect(within(rawGroup).getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Attempt 1 Output - Rejected',
      'Attempt 2 Output - Rejected',
    ])
    expect(within(rawGroup).queryByRole('button', { name: /Artifact JSON/i })).not.toBeInTheDocument()

    fireEvent.click(within(rawGroup).getByRole('button', { name: /Attempt 2 Output - Rejected/i }))
    expect(screen.getByText((_text, element) => element?.tagName === 'PRE' && element.textContent === 'files: []')).toBeInTheDocument()
  })

  it('does not derive parser notices from bare legacy repair warnings', () => {
    const copy = buildArtifactProcessingNoticeCopy({
      repairApplied: true,
      repairWarnings: ['Validator repair step completed.'],
      autoRetryCount: 0,
    }, 'artifact')

    expect(copy).toBeNull()
  })

  it('uses output-specific wording for Full Answers cleanup notices', () => {
    const metadataCleanupWarnings = [
      'Canonicalized resolved interview status from "approved" to "draft".',
      'Cleared approval fields for the AI-generated Full Answers artifact.',
      'Canonicalized generated_by.winner_model from "openai/gpt-5.4" to "github-copilot/gpt-4.1".',
    ]

    for (const testCase of [
      {
        options: undefined,
        expectedTitle: 'LoopTroop adjusted these Full Answers.',
        expectedBody: undefined,
      },
      {
        options: { fullAnswersOrigin: 'reused-approved-interview' as const },
        expectedTitle: 'LoopTroop reused the approved interview for these answers.',
        expectedBody: /copied the approved interview/i,
      },
    ]) {
      const copy = buildArtifactProcessingNoticeCopy(futureStructuredOutput({
        repairApplied: true,
        repairWarnings: metadataCleanupWarnings,
        autoRetryCount: 0,
      }), 'full-answers', testCase.options)

      expect(copy?.title).toBe(testCase.expectedTitle)
      expect(copy?.summary).toBe('3 interventions: Interview Status, Approval Fields, Winner Model.')
      expect(copy?.badges).toEqual([
        expect.objectContaining({ label: 'Cleanup', count: 3 }),
      ])
      if (testCase.expectedBody) {
        expect(copy?.body).toMatch(testCase.expectedBody)
      }
    }
  })

  it('shows specific cleanup copy for selected option id repairs in Full Answers notices', () => {
    const copy = buildArtifactProcessingNoticeCopy(futureStructuredOutput({
      repairApplied: true,
      repairWarnings: [
        'Mapped selected option ids to canonical option ids for AI-filled question Q01.',
      ],
      autoRetryCount: 0,
    }), 'full-answers')

    expect(copy?.title).toBe('LoopTroop adjusted these Full Answers.')
    expect(copy?.summary).toBe('1 intervention: Mapped Free Text.')
    expect(copy?.interventions).toEqual([
      expect.objectContaining({
        category: 'cleanup',
        code: 'cleanup_mapped_free_text',
        exactCorrection: 'Mapped the answer content to canonical option IDs for question Q01.',
      }),
    ])
  })


  it('suppresses parser notices when a bare repair flag has no details', () => {
    const copy = buildArtifactProcessingNoticeCopy({
      repairApplied: true,
      repairWarnings: [],
      autoRetryCount: 0,
    }, 'relevant-files')

    expect(copy).toBeNull()
  })

  it('deduplicates identical explicit interventions in parser notices', () => {
    const copy = buildArtifactProcessingNoticeCopy({
      repairApplied: true,
      repairWarnings: ['Recovered the structured artifact from surrounding transcript or wrapper text before validation.'],
      autoRetryCount: 0,
      interventions: [
        {
          code: 'parser_transcript_recovery',
          stage: 'parse',
          category: 'parser_fix',
          title: 'Extracted payload from surrounding prose or transcript',
          summary: 'The structured payload was embedded inside conversational text, preamble, or transcript output.',
          why: 'The model included explanatory prose or transcript text alongside the structured data instead of returning only the raw YAML/JSON payload.',
          how: 'LoopTroop isolated the structured data block from the surrounding text, discarded the prose, and reparsed the extracted payload.',
          technicalDetail: 'Recovered the structured artifact from surrounding transcript or wrapper text before validation.',
        },
        {
          code: 'parser_transcript_recovery',
          stage: 'parse',
          category: 'parser_fix',
          title: 'Extracted payload from surrounding prose or transcript',
          summary: 'The structured payload was embedded inside conversational text, preamble, or transcript output.',
          why: 'The model included explanatory prose or transcript text alongside the structured data instead of returning only the raw YAML/JSON payload.',
          how: 'LoopTroop isolated the structured data block from the surrounding text, discarded the prose, and reparsed the extracted payload.',
          technicalDetail: 'Recovered the structured artifact from surrounding transcript or wrapper text before validation.',
        },
      ],
    }, 'relevant-files')

    expect(copy?.summary).toBe('1 intervention: Transcript Recovery.')
    expect(copy?.badges).toEqual([
      expect.objectContaining({ label: 'Parser Fix', count: 1 }),
    ])
    expect(copy?.interventions).toHaveLength(1)
  })

  it('shows collapsed parser notices for common structured artifact variants', () => {
    const parserNoticeCases = [
      {
        artifactId: 'prd-draft-member-openai%2Fgpt-5.2',
        phase: 'DRAFTING_PRD' as const,
        content: JSON.stringify({
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: buildPrdDocumentContent(),
              structuredOutput: futureStructuredOutput({
                repairApplied: true,
                repairWarnings: ['Inferred missing PRD refinement item_type at index 0 as epic.'],
              }),
            },
          ],
        }),
        title: 'LoopTroop adjusted this PRD draft.',
        badge: 'Synthesized 1',
        expandedCopy: /LoopTroop validated this PRD draft and recorded the intervention details below/i,
        warningText: /Inferred missing PRD refinement item_type at index 0 as epic/i,
        afterOpen: () => {
          expect(screen.getByText(/Exact correction:/i)).toBeInTheDocument()
          expect(screen.getByText(/Rule:/i)).toBeInTheDocument()
          expect(screen.getByText(/Before:/i)).toBeInTheDocument()
          expect(screen.getByText(/\[missing\]/i)).toBeInTheDocument()
          expect(screen.getByText(/After:/i)).toBeInTheDocument()
          expect(screen.getByText(/^epic$/i)).toBeInTheDocument()
          expect(screen.getByText(/What:/i)).toBeInTheDocument()
        },
      },
      {
        artifactId: 'prd-coverage-result',
        phase: 'VERIFYING_PRD_COVERAGE' as const,
        content: JSON.stringify({
          winnerId: 'openai/gpt-5.2',
          response: 'status: gaps\ngaps:\n  - "Missing approval sequencing."',
          hasGaps: true,
          coverageRunNumber: 1,
          maxCoveragePasses: 2,
          parsed: {
            status: 'gaps',
            gaps: ['Missing approval sequencing.'],
            followUpQuestions: [],
          },
          structuredOutput: futureStructuredOutput({
            repairApplied: true,
            repairWarnings: ['Trimmed empty PRD coverage gap strings before persisting the normalized result.'],
          }),
        }),
        title: 'LoopTroop adjusted this coverage review.',
        badge: 'Cleanup 1',
        expandedCopy: /LoopTroop validated this coverage review and recorded the intervention details below/i,
        warningText: /Trimmed empty PRD coverage gap strings before persisting the normalized result/i,
      },
      {
        artifactId: 'relevant-files-scan',
        phase: 'PREPARING_CONTEXT' as const,
        content: JSON.stringify({
          fileCount: 1,
          files: [
            {
              path: 'src/app.ts',
              rationale: 'Main app entry point.',
              relevance: 'high',
              likely_action: 'modify',
              contentPreview: 'export function app() {}',
              contentLength: 25,
            },
          ],
          structuredOutput: futureStructuredOutput({
            repairApplied: true,
            repairWarnings: ['Removed surrounding markdown code fence before parsing the relevant files result.'],
          }),
        }),
        title: 'LoopTroop adjusted this relevant files scan.',
        badge: 'Parser Fix 1',
        expandedCopy: /LoopTroop validated this relevant files scan and recorded the intervention details below/i,
        warningText: /Removed surrounding markdown code fence before parsing the relevant files result/i,
      },
    ]

    for (const [index, testCase] of parserNoticeCases.entries()) {
      if (index > 0) {
        cleanup()
      }

      render(
        <ArtifactContent
          artifactId={testCase.artifactId}
          phase={testCase.phase}
          content={testCase.content}
        />,
      )

      expect(screen.getByText(testCase.title)).toBeInTheDocument()
      expect(screen.getByText(testCase.badge)).toBeInTheDocument()
      expect(screen.queryByText(testCase.expandedCopy)).not.toBeInTheDocument()

      openNotice(testCase.title)

      expect(screen.getByText(testCase.expandedCopy)).toBeInTheDocument()
      expect(screen.getAllByText(testCase.warningText).length).toBeGreaterThan(0)
      testCase.afterOpen?.()
    }
  })

  it('renders exact correction, rule, and before/after blocks for explicit interventions', () => {
    render(
      <ArtifactContent
        artifactId="prd-draft-member-openai%2Fgpt-5.2"
        phase="DRAFTING_PRD"
        content={JSON.stringify({
          drafts: [
            {
              memberId: 'openai/gpt-5.2',
              outcome: 'completed',
              content: buildPrdDocumentContent(),
              structuredOutput: {
                repairApplied: true,
                interventions: [
                  {
                    code: 'cleanup_ticket_id',
                    stage: 'normalize',
                    category: 'cleanup',
                    title: 'Corrected the ticket_id field',
                    summary: 'The ticket_id did not match the current ticket.',
                    why: 'The model produced a ticket_id that does not match the current ticket.',
                    how: 'LoopTroop replaced ticket_id with the runtime value.',
                    exactCorrection: `Changed ticket_id from "${TEST.shortname}-OLD" to "${TEST.shortname}-123".`,
                    rule: { id: 'cleanup_ticket_id', label: 'Ticket ID' },
                    examples: [
                      {
                        scope: 'ticket_id',
                        before: `${TEST.shortname}-OLD`,
                        after: `${TEST.shortname}-123`,
                      },
                    ],
                    technicalDetail: `Canonicalized ticket_id from "${TEST.shortname}-OLD" to "${TEST.shortname}-123".`,
                  },
                ],
              },
            },
          ],
        })}
      />,
    )

    openNotice('LoopTroop adjusted this PRD draft.')

    expect(screen.getByText('Exact correction:')).toBeInTheDocument()
    expect(screen.getByText(`Changed ticket_id from "${TEST.shortname}-OLD" to "${TEST.shortname}-123".`)).toBeInTheDocument()
    expect(screen.getByText('Rule:')).toBeInTheDocument()
    expect(screen.getByText('Ticket ID')).toBeInTheDocument()
    expect(screen.getByText('cleanup_ticket_id')).toBeInTheDocument()
    expect(screen.getByText('Before:')).toBeInTheDocument()
    expect(screen.getByText(`${TEST.shortname}-OLD`)).toBeInTheDocument()
    expect(screen.getByText('After:')).toBeInTheDocument()
    expect(screen.getByText(`${TEST.shortname}-123`)).toBeInTheDocument()
  })


  it('shows invalid YAML escape parser repairs with specific details', () => {
    const warning = 'Escaped invalid YAML double-quoted scalar backslash sequences before reparsing.'

    render(
      <ArtifactContent
        artifactId="relevant-files-scan"
        phase="PREPARING_CONTEXT"
        content={JSON.stringify({
          fileCount: 1,
          files: [
            {
              path: 'src/app.ts',
              rationale: 'Main app entry point.',
              relevance: 'high',
              likely_action: 'modify',
              contentPreview: 'export function app() {}',
              contentLength: 25,
            },
          ],
          structuredOutput: futureStructuredOutput({
            repairApplied: true,
            repairWarnings: [warning],
          }),
        })}
      />,
    )

    expect(screen.getByText('LoopTroop adjusted this relevant files scan.')).toBeInTheDocument()
    expect(screen.getByText('1 intervention: YAML Escape Repair.')).toBeInTheDocument()
    expect(screen.getByText('Parser Fix 1')).toBeInTheDocument()

    openNotice('LoopTroop adjusted this relevant files scan.')

    expect(screen.getByText('Escaped invalid YAML backslash sequences')).toBeInTheDocument()
    expect(screen.getByText('YAML Escape Repair')).toBeInTheDocument()
    expect(screen.getByText('parser_double_quoted_scalar_escape')).toBeInTheDocument()
    expect(screen.getByText(/Escaped invalid backslash sequences inside double-quoted YAML scalars/i)).toBeInTheDocument()
    expect(screen.getAllByText(hasTextContent(warning)).length).toBeGreaterThan(0)
  })

  it('hides the relevant-files parser notice when there are no warnings or retries to explain', () => {
    render(
      <ArtifactContent
        artifactId="relevant-files-scan"
        phase="PREPARING_CONTEXT"
        content={JSON.stringify({
          fileCount: 1,
          files: [
            {
              path: 'src/app.ts',
              rationale: 'Main app entry point.',
              relevance: 'high',
              likely_action: 'modify',
              contentPreview: 'export function app() {}',
              contentLength: 25,
            },
          ],
          structuredOutput: {
            repairApplied: true,
            repairWarnings: [],
            autoRetryCount: 0,
          },
        })}
      />,
    )

    expect(screen.queryByText('LoopTroop adjusted this relevant files scan.')).not.toBeInTheDocument()
  })

  it('keeps relevant files without raw attempts focused on structured file details', () => {
    const longQuestion = LONG_GLOBAL_THEME_PROMPT
    render(
      <ArtifactContent
        artifactId="relevant-files-scan"
        phase="SCANNING_RELEVANT_FILES"
        content={JSON.stringify({
          fileCount: 1,
          question: longQuestion,
          files: [
            {
              path: 'src/theme.ts',
              rationale: 'Defines the default global theme.',
              relevance: 'high',
              likely_action: 'modify',
              contentPreview: 'export const primary = "blue"\nexport const accent = "slate"',
              contentLength: 58,
            },
          ],
        })}
      />,
    )

    expect(screen.queryByRole('button', { name: 'Raw' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /src\/theme\.ts/i }))

    const previewPre = screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && element.textContent.includes('export const primary = "blue"'),
    )
    expect(previewPre.textContent).toBe('export const primary = "blue"\nexport const accent = "slate"')
    expect(screen.queryByText(`question: "${longQuestion}"`)).not.toBeInTheDocument()
    expect(previewPre).toHaveClass('whitespace-pre-wrap')
  })

  it('renders simple folded YAML scalars in raw tabs as quoted single-line values', async () => {
    const writeTextMock = mockClipboard()

    const prompt = LONG_PALETTE_PROMPT
    const content = [
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: >-',
      '      For this test ticket, is the goal simply to replace the current default app palette with a single pink palette (no',
      '      theme switcher), and is that the full definition of done?',
      '    source: compiled',
      '    answer_type: single_choice',
    ].join('\n')

    render(
      <ArtifactContent
        artifactId="interview-answers"
        content={content}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const rawPre = screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && element.textContent?.includes(`prompt: "${prompt}"`),
    )
    expect(rawPre.textContent).not.toContain('prompt: >-')
    expect(rawPre.textContent).not.toContain('no\n      theme switcher')
    expect(rawPre.textContent).toContain('    source: compiled')

    await clickCopyRawOutput()
    expect(writeTextMock).toHaveBeenLastCalledWith(content)
  })

  it('renders folded YAML scalars inside JSON artifact content fields without altering copy content', async () => {
    const writeTextMock = mockClipboard()

    const prompt = 'Should every PRD draft keep long interview prompts readable when viewing aggregate raw artifacts?'
    const draftContent = [
      'schema_version: 1',
      'artifact: interview',
      'questions:',
      '  - id: Q01',
      '    prompt: >-',
      '      Should every PRD draft keep long interview prompts readable',
      '      when viewing aggregate raw artifacts?',
    ].join('\n')
    const content = JSON.stringify({
      drafts: [
        { memberId: 'vendor/draft-a', outcome: 'completed', content: draftContent },
      ],
      votes: [],
      voterOutcomes: {},
      winnerId: 'vendor/draft-a',
      isFinal: false,
    })

    render(<ArtifactContent artifactId="prd-votes" phase="COUNCIL_VOTING_PRD" content={content} />)

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const rawPre = screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && element.textContent?.includes('content: |-')
      && element.textContent.includes(`prompt: "${prompt}"`),
    )
    expect(rawPre.textContent).not.toContain('prompt: >-')
    expect(rawPre.textContent).not.toContain('readable\n        when viewing')

    await clickCopyRawOutput()
    expect(writeTextMock).toHaveBeenLastCalledWith(content)
  })

  it('renders final interview raw JSON wrappers with real line breaks', () => {
    const longPrompt = LONG_GLOBAL_THEME_PROMPT
    const refinedContent = [
      'artifact: interview',
      'questions:',
      '  - id: Q01',
      '    phase: Foundation',
      '    prompt: >-',
      '      For this test ticket, is the goal simply to replace the current default global theme with a pink-based one',
      '      for all users, with no runtime theme switching?',
      '    source: compiled',
      '    answer_type: free_text',
      '    options: []',
    ].join('\n')
    const content = JSON.stringify({
      originalContent: 'questions:\n  - id: Q01\n    prompt: Old prompt',
      refinedContent,
      structuredOutput: futureStructuredOutput({
        repairApplied: true,
        repairWarnings: ['Recovered the structured interview from wrapper JSON.'],
      }),
    })

    render(
      <ArtifactContent
        artifactId="final-interview"
        phase="REFINING_INTERVIEW"
        content={content}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))

    const rawPre = screen.getByText((_text, element) =>
      element?.tagName === 'PRE'
      && element.textContent?.includes('refinedContent: |-')
      && element.textContent.includes('questions:'),
    )
    expect(rawPre.textContent).toMatch(/originalContent: \|-\n\s+questions:/)
    expect(rawPre.textContent).toContain(`prompt: "${longPrompt}"`)
    expect(rawPre.textContent).not.toContain('prompt: >-')
    expect(rawPre.textContent).not.toContain('\\n')
    expect(rawPre.textContent).not.toContain('all\n      users')
    expect(rawPre).toHaveClass('whitespace-pre-wrap', 'overflow-x-hidden')
  })

  it('shows voting intervention details only in the per-model aggregate breakdown', () => {
    render(
      <ArtifactContent
        artifactId="prd-votes"
        phase="COUNCIL_VOTING_PRD"
        content={JSON.stringify({
          drafts: [
            { memberId: 'vendor/draft-a', outcome: 'completed', content: 'draft-a' },
            { memberId: 'vendor/draft-b', outcome: 'completed', content: 'draft-b' },
          ],
          votes: [
            {
              voterId: 'vendor/voter-a',
              draftId: 'vendor/draft-a',
              totalScore: 91,
              scores: [{ category: 'Coverage of requirements', score: 18, justification: 'Strong coverage' }],
            },
          ],
          voterOutcomes: {
            'vendor/voter-a': 'completed',
            'vendor/voter-b': 'invalid_output',
          },
          voterDetails: [
            {
              voterId: 'vendor/voter-a',
              structuredOutput: futureStructuredOutput({
                repairApplied: true,
                repairWarnings: ['Reordered vote scorecards before persistence.'],
              }),
            },
            {
              voterId: 'vendor/voter-b',
              structuredOutput: futureStructuredOutput({
                repairApplied: false,
                repairWarnings: [],
                autoRetryCount: 1,
                validationError: 'Malformed scorecard',
                retryDiagnostics: [
                  {
                    attempt: 1,
                    validationError: 'Malformed scorecard',
                    target: 'Draft 2',
                    excerpt: 'Draft 2: score: pending',
                  },
                ],
              }),
            },
          ],
        })}
      />,
    )

    expect(screen.getByText('LoopTroop adjusted some vote scorecards.')).toBeInTheDocument()
    expect(screen.getByText('2 interventions across 2 categories: Reordering, Validation Retry.')).toBeInTheDocument()
    expect(screen.getByText('Cleanup 1')).toBeInTheDocument()
    expect(screen.getByText('Retries 1')).toBeInTheDocument()
    expect(screen.queryByText('Affected Models')).not.toBeInTheDocument()
    expect(screen.queryByText(/Retry Attempts/i)).not.toBeInTheDocument()

    openNotice('LoopTroop adjusted some vote scorecards.')
    expect(screen.getByText('Affected Models')).toBeInTheDocument()
    expect(screen.getAllByText('voter-a').length).toBeGreaterThan(0)
    expect(screen.getAllByText('voter-b').length).toBeGreaterThan(0)
    expect(screen.queryByText(/Raw Source Messages/i)).not.toBeInTheDocument()
    expect(screen.getByText(/Retry Attempts/i)).toBeInTheDocument()
    expect(screen.getAllByText('Draft 2: score: pending')).toHaveLength(1)

    fireEvent.click(screen.getByText(/Voter Details/i).closest('button')!)
    expect(screen.queryByText('LoopTroop adjusted this vote scorecard.')).not.toBeInTheDocument()
    expect(screen.getAllByText(/Retry Attempts/i)).toHaveLength(1)
    expect(screen.getAllByText('Draft 2: score: pending')).toHaveLength(1)
  })

  it('shows a collapsed parser notice for final test results', () => {
    render(
      <ArtifactContent
        artifactId="test-results"
        phase="RUNNING_FINAL_TEST"
        content={JSON.stringify({
          status: 'failed',
          passed: false,
          checkedAt: '2026-03-30T12:00:00.000Z',
          plannedBy: 'openai/gpt-5.2',
          attempt: 2,
          maxIterations: 3,
          modelOutput: '<FINAL_TEST_COMMANDS>commands: []</FINAL_TEST_COMMANDS>',
          commands: [],
          errors: ['No final test commands were executed'],
          retryNotes: ['Retry note: keep the contrast assertion limited to destructive tokens.'],
          attemptHistory: [
            {
              attempt: 1,
              status: 'failed',
              checkedAt: '2026-03-30T11:58:00.000Z',
              commands: ['npm run test:client -- src/theme/__tests__/pinkTheme.test.ts'],
              testFiles: ['src/theme/__tests__/pinkTheme.test.ts'],
              errors: ['Command failed (1): npm run test:client -- src/theme/__tests__/pinkTheme.test.ts'],
              noteAppended: 'Retry note: keep the contrast assertion limited to destructive tokens.',
            },
          ],
          planStructuredOutput: futureStructuredOutput({
            repairApplied: false,
            repairWarnings: [],
            autoRetryCount: 1,
            validationError: 'Missing final test marker on first pass.',
          }),
        })}
      />,
    )

    expect(screen.getByText('LoopTroop adjusted this final test plan.')).toBeInTheDocument()
    expect(screen.getByText('Retries 1')).toBeInTheDocument()
    expect(screen.queryByText(/LoopTroop validated this final test plan and recorded the intervention details below/i)).not.toBeInTheDocument()

    openNotice('LoopTroop adjusted this final test plan.')

    expect(screen.getByText(/LoopTroop validated this final test plan and recorded the intervention details below/i)).toBeInTheDocument()
    expect(screen.getAllByText(/Missing final test marker on first pass/i).length).toBeGreaterThan(0)
    expect(screen.getByText('Retried after validation failed and preserved the rejected response in Raw attempts.')).toBeInTheDocument()
    expect(screen.getByText('LoopTroop preserved each rejected model response in Raw attempts, retried the structured output request, and recorded the final accepted or rejected artifact state.')).toBeInTheDocument()
    expect(screen.queryByText(/successful validated result/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/successful pass/i)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(screen.queryByText('LoopTroop adjusted this final test plan.')).not.toBeInTheDocument()
    expect(screen.queryByText('Retries 1')).not.toBeInTheDocument()
  })

  it('renders integration reports with structured metadata and deferred push guidance', () => {
    render(
      <ArtifactContent
        artifactId="commit-summary"
        phase="WAITING_PR_REVIEW"
        content={JSON.stringify({
          status: 'passed',
          completedAt: '2026-04-10T15:54:47.116Z',
          baseBranch: 'master',
          preSquashHead: 'ed7609abd7c99ad8f0bfae28442f69b24aff7871',
          candidateCommitSha: 'c2708197a117389f594e4f6f8cc4262bf9d3bd6d',
          mergeBase: '010cd33773494fcbaba0af86e9d84dd3c3548206',
          commitCount: 2,
          pushed: false,
          pushDeferred: true,
          pushError: null,
          message: 'Integration phase completed. Manual verification is required before cleanup.',
        })}
      />,
    )

    expect(screen.getByText('Integration Report')).toBeInTheDocument()
    expect(screen.getByText('Integration candidate prepared')).toBeInTheDocument()
    expect(screen.getByText('Integration phase completed. Manual verification is required before cleanup.')).toBeInTheDocument()
    expect(screen.getByText('Base Branch')).toBeInTheDocument()
    expect(screen.getByText('master')).toBeInTheDocument()
    expect(screen.getByText('Candidate Commit')).toBeInTheDocument()
    expect(screen.getByText('c2708197a117389f594e4f6f8cc4262bf9d3bd6d')).toBeInTheDocument()
    expect(screen.getByText('Squashed Commits')).toBeInTheDocument()
    expect(screen.getByText(/remote ticket branch stays on the last bead backup until manual verification/i)).toBeInTheDocument()
  })

  it('renders failed integration reports with the remote push error callout', () => {
    render(
      <ArtifactContent
        artifactId="commit-summary"
        phase="INTEGRATING_CHANGES"
        content={JSON.stringify({
          status: 'failed',
          completedAt: '2026-04-10T15:54:47.116Z',
          baseBranch: 'master',
          candidateCommitSha: null,
          commitCount: null,
          pushed: false,
          pushDeferred: false,
          pushError: 'git push failed after 3 attempts: permission denied',
          message: 'git merge-base failed',
        })}
      />,
    )

    expect(screen.getByText('Integration failed')).toBeInTheDocument()
    expect(screen.getByText('git merge-base failed')).toBeInTheDocument()
    expect(screen.getByText('Remote update failed')).toBeInTheDocument()
    expect(screen.getByText(/permission denied/i)).toBeInTheDocument()
  })

  it('renders pull request reports with a prominent GitHub link and generated description', () => {
    render(
      <ArtifactContent
        artifactId="pull-request-report"
        phase="CREATING_PULL_REQUEST"
        content={JSON.stringify({
          status: 'passed',
          completedAt: '2026-04-10T15:58:47.116Z',
          baseBranch: 'master',
          headBranch: 'POBA-9',
          candidateCommitSha: 'c2708197a117389f594e4f6f8cc4262bf9d3bd6d',
          prNumber: 42,
          prUrl: 'https://github.com/looptroop-ai/pocketbase-master/pull/42',
          prState: 'draft',
          prHeadSha: 'c2708197a117389f594e4f6f8cc4262bf9d3bd6d',
          title: 'POBA-9: t13',
          body: [
            '## Summary',
            '- Adds the scoped theme regression test.',
            '',
            '## Validation',
            '- npm test -- src/theme-scope.test.js',
          ].join('\n'),
          createdAt: '2026-04-10T15:58:40.116Z',
          updatedAt: '2026-04-10T15:58:47.116Z',
          message: 'Draft pull request ready at https://github.com/looptroop-ai/pocketbase-master/pull/42.',
        })}
      />,
    )

    expect(screen.getByText('Pull Request Report')).toBeInTheDocument()
    expect(screen.getByText('Draft pull request ready')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /open draft pr in github/i })).toHaveAttribute(
      'href',
      'https://github.com/looptroop-ai/pocketbase-master/pull/42',
    )
    expect(screen.getByText('PR Number')).toBeInTheDocument()
    expect(screen.getByText('#42')).toBeInTheDocument()
    expect(screen.getByText('Head Branch')).toBeInTheDocument()
    expect(screen.getByText('POBA-9')).toBeInTheDocument()
    expect(screen.getByText('Generated PR Description')).toBeInTheDocument()
    expect(screen.getByText('Adds the scoped theme regression test.')).toBeInTheDocument()
    expect(screen.getByText('npm test -- src/theme-scope.test.js')).toBeInTheDocument()
  })

  it('renders ignored candidate files and reasons in pull request reports', () => {
    render(
      <ArtifactContent
        artifactId="pull-request-report"
        phase="CREATING_PULL_REQUEST"
        content={JSON.stringify({
          status: 'passed',
          completedAt: '2026-04-10T15:58:47.116Z',
          candidateCommitSha: 'filtered123',
          prUrl: 'https://github.com/looptroop-ai/pocketbase-master/pull/42',
          prState: 'draft',
          title: 'POBA-9: t13',
          body: '## Summary\n- Adds the scoped theme regression test.',
          candidateFileAudit: {
            status: 'passed',
            includedFiles: ['src/feature.ts'],
            excludedFiles: ['tmp/output.log'],
            reviewedFiles: ['dist/bundle.js'],
            entries: [
              {
                path: 'src/feature.ts',
                decision: 'include',
                reason: 'Implements the requested feature.',
              },
              {
                path: 'tmp/output.log',
                decision: 'exclude',
                reason: 'Temporary test log output.',
              },
              {
                path: 'dist/bundle.js',
                decision: 'review',
                reason: 'Generated tracked artifact kept for review.',
              },
            ],
            stats: {
              totalFiles: 3,
              includedFiles: 2,
              excludedFiles: 1,
              reviewedFiles: 1,
            },
            message: 'Candidate file audit excluded 1 file from the final PR.',
            warnings: [],
          },
        })}
      />,
    )

    expect(screen.getByText('Candidate File Audit')).toBeInTheDocument()
    expect(screen.getByText('tmp/output.log')).toBeInTheDocument()
    expect(screen.getByText('Temporary test log output.')).toBeInTheDocument()
    expect(screen.getByText('Reviewed')).toBeInTheDocument()
  })

  it('does not render unsafe pull request report URLs as links', () => {
    render(
      <ArtifactContent
        artifactId="pull-request-report"
        phase="CREATING_PULL_REQUEST"
        content={JSON.stringify({
          status: 'passed',
          completedAt: '2026-04-10T15:58:47.116Z',
          prNumber: 42,
          prUrl: 'javascript:alert(1)',
          prState: 'draft',
          message: 'Draft pull request ready.',
        })}
      />,
    )

    expect(screen.queryByRole('link', { name: /open draft pr in github/i })).not.toBeInTheDocument()
    expect(screen.getByText('Recorded pull request URL is not a valid GitHub PR link.')).toBeInTheDocument()
  })

  it('renders cleanup reports with counts and categorized path sections', () => {
    render(
      <ArtifactContent
        artifactId="cleanup-report"
        phase="CLEANING_ENV"
        content={JSON.stringify({
          removedDirs: ['/tmp/ticket/.ticket/runtime/locks'],
          removedFiles: ['/tmp/ticket/.ticket/runtime/state.yaml'],
          preservedPaths: [
            '/tmp/ticket/.ticket/interview.yaml',
            '/tmp/ticket/.ticket/runtime/execution-log.jsonl',
          ],
          errors: ['Failed to remove /tmp/ticket/.ticket/runtime/tmp: EBUSY'],
        })}
      />,
    )

    expect(screen.getByText('Cleanup Report')).toBeInTheDocument()
    expect(screen.getByText('Cleanup completed with warnings')).toBeInTheDocument()
    expect(screen.getByText('Removed Dirs')).toBeInTheDocument()
    expect(screen.getAllByText('Removed Files').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Preserved Paths').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Errors').length).toBeGreaterThan(0)
    expect(screen.getByText('/tmp/ticket/.ticket/runtime/locks')).toBeInTheDocument()
    expect(screen.getByText('/tmp/ticket/.ticket/runtime/state.yaml')).toBeInTheDocument()
    expect(screen.getByText('/tmp/ticket/.ticket/interview.yaml')).toBeInTheDocument()
    expect(screen.getByText(/EBUSY/i)).toBeInTheDocument()
  })

  it('falls back to the raw viewer for malformed report payloads', () => {
    const malformedReportCases = [
      {
        artifactId: 'commit-summary',
        phase: 'WAITING_PR_REVIEW' as const,
        content: 'not valid integration json',
      },
      {
        artifactId: 'pull-request-report',
        phase: 'CREATING_PULL_REQUEST' as const,
        content: 'not valid pull request json',
      },
      {
        artifactId: 'cleanup-report',
        phase: 'CLEANING_ENV' as const,
        content: 'not valid cleanup json',
      },
    ]

    for (const [index, testCase] of malformedReportCases.entries()) {
      if (index > 0) {
        cleanup()
      }

      render(
        <ArtifactContent
          artifactId={testCase.artifactId}
          phase={testCase.phase}
          content={testCase.content}
        />,
      )

      expect(screen.getByText(testCase.content)).toBeInTheDocument()
    }
  })
})
