import type { ReactElement } from "react";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";
import { ticketMachine } from "@server/machines/ticketMachine";
import type { LogContextValue, LogEntry } from "@/context/logUtils";
import { LogProvider } from "@/context/LogContext";
import { TEST, makeTicket } from "@/test/factories";
import { getTicketArtifactsQueryKey } from "@/hooks/useTicketArtifacts";
import { getTicketPhaseAttemptsQueryKey } from "@/hooks/useTicketPhaseAttempts";
import { normalizeTicketResponse } from "@/lib/ticketNormalization";
import {
  renderWithProviders,
  createTestQueryClient,
  createJsonResponse,
  withLogContext,
} from "@/test/renderHelpers";
import { WorkspacePhaseSummary } from "../WorkspacePhaseSummary";

function createLogEntry(
  line: string,
  timestamp: string | undefined,
  status: LogEntry["status"] = "VERIFYING_PRD_COVERAGE",
  source = "system",
  kind = "milestone",
  phaseAttempt = 1,
): LogEntry {
  return {
    id: `${timestamp}:${line}`,
    entryId: `${timestamp}:${line}`,
    line,
    source,
    status,
    phaseAttempt,
    timestamp,
    audience: "all",
    kind,
    streaming: false,
    op: "append",
  };
}

function phaseFromAttemptsUrl(url: string): string | null {
  const phase = /\/phases\/([^/]+)\/attempts(?:\?|$)/.exec(url)?.[1]
  return phase ? decodeURIComponent(phase) : null
}

function createPhaseAttempt(
  phase: string,
  attemptNumber: number,
  state: "active" | "archived" = "active",
  archivedReason: string | null = null,
) {
  return {
    ticketId: TEST.ticketId,
    phase,
    attemptNumber,
    state,
    archivedReason,
    createdAt: "2026-01-01T00:00:00.000Z",
    archivedAt: state === "archived" ? "2026-01-01T00:01:00.000Z" : null,
  };
}

function createCoverageRevisionArtifact(
  phase: string,
  candidateVersion: number,
  phaseAttempt = 1,
  coverageRunNumber?: number,
  maxCoveragePasses?: number,
) {
  return {
    id: candidateVersion,
    ticketId: TEST.ticketId,
    phase,
    phaseAttempt,
    artifactType: phase === "VERIFYING_PRD_COVERAGE" ? "prd_coverage_revision" : "beads_coverage_revision",
    filePath: null,
    content: JSON.stringify({
      candidateVersion,
      ...(coverageRunNumber !== undefined ? { coverageRunNumber } : {}),
      ...(maxCoveragePasses !== undefined ? { maxCoveragePasses } : {}),
    }),
    createdAt: "2026-01-01T00:00:03.000Z",
    updatedAt: "2026-01-01T00:00:03.000Z",
  };
}

function mockWorkspacePhaseQueries(
  artifacts: unknown[] = [],
  retriedPhase?: string,
) {
  vi.mocked(globalThis.fetch).mockImplementation((input) => {
    const url = String(input);
    if (
      url.split("?")[0]?.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)
    )
      return createJsonResponse(artifacts);
    const attemptPhase = phaseFromAttemptsUrl(url);
    if (attemptPhase) {
      return createJsonResponse(retriedPhase === attemptPhase
        ? [
            createPhaseAttempt(retriedPhase, 2),
            createPhaseAttempt(retriedPhase, 1, "archived", "manual_retry_after_blocked_error"),
          ]
        : [createPhaseAttempt(attemptPhase, 1)]);
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
}

function renderWithLogContext(
  ui: ReactElement,
  logsByPhase: Record<string, LogEntry[]>,
  queryClient = createTestQueryClient(),
) {
  const value: LogContextValue = {
    logsByPhase,
    activePhase: null,
    isLoadingLogs: false,
    addLog: vi.fn(),
    addLogRecord: vi.fn(),
    getLogsForPhase: (phase: string, options?: { phaseAttempt?: number }) => {
      const logs = logsByPhase[phase] ?? [];
      if (options?.phaseAttempt !== undefined) {
        return logs.filter((e) => e.phaseAttempt === options.phaseAttempt);
      }
      return logs;
    },
    getAllLogs: () => Object.values(logsByPhase).flat(),
    setActivePhase: vi.fn(),
    clearLogs: vi.fn(),
  };

  return renderWithProviders(withLogContext(value, ui), { queryClient });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = String(input);
    const attemptPhase = phaseFromAttemptsUrl(url);
    if (attemptPhase) {
      return createJsonResponse([createPhaseAttempt(attemptPhase, 1)]);
    }
    if (
      url.split("?")[0]?.endsWith(`/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`)
    ) {
      return createJsonResponse([]);
    }
    throw new Error(`Unhandled fetch: ${url}`);
  });
});

describe("WorkspacePhaseSummary", () => {
  it("renders the phase description and opens detailed status copy", () => {
    const ticket = makeTicket({ status: "DRAFTING_PRD" });

    renderWithProviders(
      <WorkspacePhaseSummary phase="DRAFTING_PRD" ticket={ticket} />,
    );

    expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: /show detailed explanation for council drafting specs/i,
      }),
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveClass("max-h-[min(80vh,calc(100dvh-2rem))]", "overflow-y-auto");
    expect(screen.getByRole("heading", { name: "Council Drafting Specs" }).parentElement).toHaveClass("shrink-0");
    expect(screen.getByRole("heading", { name: "Overview" }).parentElement?.parentElement)
      .toHaveClass("min-h-24", "flex-1", "overflow-y-auto");
    expect(
      screen.getByText(
        /Part 1, Full Answers: For each skipped interview question/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Part 2, PRD drafting: Each model uses its own completed answer set/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Quorum Met → Voting on Specs: The workflow advances once enough valid PRDs exist to score\./,
      ),
    ).toBeInTheDocument();
  });

  it("collapses and re-expands the description when clicking the phase name", () => {
    const ticket = makeTicket({ status: "DRAFTING_PRD" });

    renderWithProviders(
      <WorkspacePhaseSummary phase="DRAFTING_PRD" ticket={ticket} />,
    );

    const toggle = screen.getByRole("button", {
      name: "Council Drafting Specs",
    });
    expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(
      screen.queryByText(/drafting competing PRDs\./),
    ).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText(/drafting competing PRDs\./)).toBeInTheDocument();
  });

  it("shows the failed phase, actual error, and live recovery choices for a blocked error", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "REFINING_PRD",
      availableActions: ["retry", "continue", "cancel"],
    });

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="BLOCKED_ERROR"
        ticket={ticket}
        errorMessage={
          "The runner crashed while executing bead B-12.\n\n112 | noisy parser excerpt"
        }
      />,
    );

    expect(
      screen.getByRole("button", { name: "Error: Refining Specs" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Refining Specs failed: The runner crashed while executing bead B-12\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Retry starts a fresh Refining Specs attempt\./),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Continue resumes the preserved provider session\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/noisy parser excerpt/)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/CODING exposes three separate histories/),
    ).not.toBeInTheDocument();
  });

  it("summarizes the final stopping reason from a bead failure instead of an earlier attempt", () => {
    const initial = createActor(ticketMachine, { input: {} });
    const actor = createActor(ticketMachine, {
      snapshot: ticketMachine.resolveState({
        value: "CODING",
        context: { ...initial.getSnapshot().context, status: "CODING" },
      }),
      input: {},
    });
    const stoppingReason =
      "Reached the configured per-bead retry budget at iteration 5.";
    actor.start();
    actor.send({
      type: "BEAD_ERROR",
      errors: [
        ...Array.from(
          { length: 5 },
          (_, index) => `Iteration ${index + 1}: No completion marker found.`,
        ),
        stoppingReason,
      ],
    });
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
      errorMessage: actor.getSnapshot().context.error,
      availableActions: ["retry", "cancel"],
    });
    actor.stop();

    renderWithProviders(
      <WorkspacePhaseSummary phase="BLOCKED_ERROR" ticket={ticket} />,
    );

    expect(screen.getByText(new RegExp(stoppingReason))).toBeInTheDocument();
    expect(
      screen.queryByText(/Iteration 1: No completion marker found/),
    ).not.toBeInTheDocument();
  });

  it("does not advertise live recovery actions for a historical error occurrence", () => {
    const ticket = makeTicket({
      status: "CODING",
      availableActions: ["cancel"],
    });

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="BLOCKED_ERROR"
        ticket={ticket}
        errorOccurrence={{
          id: "error-1",
          occurrenceNumber: 1,
          blockedFromStatus: "DRAFTING_PRD",
          errorMessage: "Provider connection closed.",
          errorCodes: [],
          occurredAt: TEST.timestamp,
          resolvedAt: TEST.timestamp,
          resolutionStatus: "RETRIED",
          resumedToStatus: "DRAFTING_PRD",
        }}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Past error: Council Drafting Specs",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Council Drafting Specs failed: Provider connection closed\./,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/This saved occurrence is read-only/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Retry starts/)).not.toBeInTheDocument();
  });

  it("truncates oversized error payloads in the top summary", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "REFINING_PRD",
      availableActions: ["retry", "cancel"],
    });
    const oversizedError = `Malformed provider output: ${"invalid YAML payload ".repeat(30)}`;

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="BLOCKED_ERROR"
        ticket={ticket}
        errorMessage={oversizedError}
      />,
    );

    const summary = screen.getByText(
      /Refining Specs failed: Malformed provider output:/,
    );
    expect(summary.textContent).toContain(
      "… Retry starts a fresh Refining Specs attempt.",
    );
    expect(summary.textContent).not.toContain(oversizedError.trim());
    expect(summary.textContent?.length).toBeLessThan(350);
  });

  it("renders with runtime defaults when the server sent no runtime", () => {
    const ticket = normalizeTicketResponse({
      ...makeTicket({ status: "CODING" }),
      runtime: undefined,
      currentBead: 2,
      totalBeads: 4,
    });

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    );

    expect(
      screen.getByRole("button", {
        name: "Implementing (working on bead 2 of 4)",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /LoopTroop is implementing the ticket one bead at a time/,
      ),
    ).toBeInTheDocument();
  });

  it("shows a visible warning when the bead tracker has unreadable lines", () => {
    const ticket = makeTicket({
      status: "CODING",
      runtime: {
        ...makeTicket().runtime,
        beadsDiagnostics: { malformedLines: [4], unrepresentableLines: [] },
      },
    });

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /bead tracker needs repair/i,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      /progress may be incomplete/i,
    );
  });

  it("shows live coding bead and iteration progress in the main title", () => {
    const ticket = makeTicket({
      status: "CODING",
      runtime: {
        ...makeTicket().runtime,
        currentBead: 3,
        totalBeads: 10,
        activeBeadIteration: 2,
        maxIterationsPerBead: 5,
      },
    });

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    );

    expect(
      screen.getByRole("button", {
        name: "Implementing (working on bead 3 of 10, iteration 2 of 5)",
      }),
    ).toBeInTheDocument();
  });

  it("hides live coding progress when reviewing CODING after the ticket moved on", () => {
    const ticket = makeTicket({
      status: "RUNNING_FINAL_TEST",
      runtime: {
        ...makeTicket().runtime,
        currentBead: 3,
        totalBeads: 10,
        activeBeadIteration: 2,
        maxIterationsPerBead: 5,
      },
    });

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    );

    expect(
      screen.getByRole("button", { name: "Implementing" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/working on bead/)).not.toBeInTheDocument();
  });

  it("shows the bead countdown from the active iteration update while CODING is live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const runtime = {
      ...makeTicket().runtime,
      activeBeadId: "bead-1",
      perIterationTimeoutMs: 8 * 60 * 1000,
      beads: [
        {
          id: "bead-1",
          title: "Active bead",
          status: "in_progress",
          iteration: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:01:00.000Z",
        },
      ],
    };
    const liveTicket = makeTicket({
      status: "CODING",
      runtime,
    });

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={liveTicket} />,
    );

    expect(screen.getByText("07:00")).toBeInTheDocument();
    expect(screen.getByText("08:00")).toBeInTheDocument();
  });

  it("does not show a live bead countdown when reviewing CODING from a blocked ticket", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const blockedTicket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
      runtime: {
        ...makeTicket().runtime,
        activeBeadId: "bead-1",
        perIterationTimeoutMs: 8 * 60 * 1000,
        beads: [
          {
            id: "bead-1",
            title: "Paused bead",
            status: "in_progress",
            iteration: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
            updatedAt: null,
          },
        ],
      },
    });

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={blockedTicket} />,
    );

    expect(screen.queryByText("06:00")).not.toBeInTheDocument();
    expect(screen.queryByText("08:00")).not.toBeInTheDocument();
  });

  it("shows the next live PRD coverage version and pass in the main title when revision work starts", async () => {
    mockWorkspacePhaseQueries();

    const ticket = makeTicket({
      id: TEST.ticketId,
      status: "VERIFYING_PRD_COVERAGE",
    });
    const logsByPhase = {
      VERIFYING_PRD_COVERAGE: [
        createLogEntry(
          "[SYS] Transition: REFINING_PRD -> VERIFYING_PRD_COVERAGE",
          "2026-01-01T00:00:00.000Z",
        ),
        createLogEntry(
          "[SYS] Coverage verification started using winning model: test-vendor/test-model (run 2/5).",
          "2026-01-01T00:00:01.000Z",
        ),
        createLogEntry(
          "[SYS] Coverage found 2 gap(s) in PRD Candidate v1. Revising candidate before the next audit pass.",
          "2026-01-01T00:00:02.000Z",
        ),
        createLogEntry(
          "Reconnected to existing OpenCode session ses-example ready for PRD coverage check 2 of 5: revising PRD Candidate v1 after 2 gap(s) were found; response attempt 2 of 3. Preparing the request.",
          "2026-01-01T00:00:03.000Z",
        ),
      ],
    };

    renderWithLogContext(
      <WorkspacePhaseSummary phase="VERIFYING_PRD_COVERAGE" ticket={ticket} />,
      logsByPhase,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Coverage Check (PRD) (checking version 2, pass 2 of 5)",
        }),
      ).toBeInTheDocument();
    });
  });

  it('waits for coverage artifacts before using a version from older log evidence', async () => {
    let resolveArtifacts!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      const attemptPhase = phaseFromAttemptsUrl(url);
      if (attemptPhase) return createJsonResponse([createPhaseAttempt(attemptPhase, 1)]);
      if (url.split('?')[0]?.endsWith('/artifacts')) {
        return new Promise<Response>((resolve) => { resolveArtifacts = resolve; });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ id: TEST.ticketId, status: 'VERIFYING_PRD_COVERAGE' });
    const queryClient = createTestQueryClient();

    renderWithLogContext(
      <WorkspacePhaseSummary phase="VERIFYING_PRD_COVERAGE" ticket={ticket} />,
      {
        VERIFYING_PRD_COVERAGE: [
          createLogEntry(
            '[SYS] Transition: REFINING_PRD -> VERIFYING_PRD_COVERAGE',
            '2026-01-01T00:00:00.000Z',
          ),
          createLogEntry(
            'Auditing PRD Candidate v1.',
            '2026-01-01T00:00:01.000Z',
          ),
        ],
      },
      queryClient,
    );

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'Coverage Check (PRD) (loading progress)',
      })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', {
      name: 'Coverage Check (PRD) (checking version 1)',
    })).not.toBeInTheDocument();

    await waitFor(() => expect(resolveArtifacts).toBeTypeOf('function'));
    await act(async () => resolveArtifacts(await createJsonResponse([{
      id: 4,
      ticketId: TEST.ticketId,
      phase: 'VERIFYING_PRD_COVERAGE',
      phaseAttempt: 1,
      artifactType: 'prd_coverage_revision',
      filePath: null,
      content: JSON.stringify({ candidateVersion: 4 }),
      createdAt: '2026-01-01T00:00:03.000Z',
      updatedAt: '2026-01-01T00:00:03.000Z',
    }])));

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'Coverage Check (PRD) (checking version 4)',
      })).toBeInTheDocument();
    });
  });

  it('hides cached candidate versions until the current attempt and its artifact refresh finish', async () => {
    let resolveAttempts!: (response: Response) => void;
    let resolveArtifacts!: (response: Response) => void;
    let resolveLogs!: (response: Response) => void;
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      if (phaseFromAttemptsUrl(url)) {
        return new Promise<Response>((resolve) => { resolveAttempts = resolve; });
      }
      if (url.includes('/logs?')) {
        return new Promise<Response>((resolve) => { resolveLogs = resolve; });
      }
      if (url.split('?')[0]?.endsWith('/artifacts')) {
        return new Promise<Response>((resolve) => { resolveArtifacts = resolve; });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ id: TEST.ticketId, status: 'VERIFYING_PRD_COVERAGE' });
    const phase = 'VERIFYING_PRD_COVERAGE';
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(getTicketPhaseAttemptsQueryKey(ticket.id, phase), [createPhaseAttempt(phase, 1)]);
    queryClient.setQueryData(getTicketArtifactsQueryKey(ticket.id, { phase, phaseAttempt: 1 }), [
      createCoverageRevisionArtifact(phase, 1, 1),
    ]);
    queryClient.setQueryData(getTicketArtifactsQueryKey(ticket.id, { phase, phaseAttempt: 2 }), [
      createCoverageRevisionArtifact(phase, 1, 2),
    ]);

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={phase}>
        <WorkspacePhaseSummary phase={phase} ticket={ticket} />
      </LogProvider>,
      { queryClient },
    );

    await waitFor(() => expect(resolveAttempts).toBeTypeOf('function'));
    expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (loading progress)',
    })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /checking version 1/i })).not.toBeInTheDocument();

    await act(async () => resolveAttempts(await createJsonResponse([
      createPhaseAttempt(phase, 2),
      createPhaseAttempt(phase, 1, 'archived', 'manual_retry_after_blocked_error'),
    ])));
    await waitFor(() => expect(resolveArtifacts).toBeTypeOf('function'));
    await waitFor(() => expect(resolveLogs).toBeTypeOf('function'));
    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (loading progress)',
    })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /checking version [14]/i })).not.toBeInTheDocument();

    const artifactRequest = fetchMock.mock.calls.map(([input]) => String(input))
      .find((url) => url.split('?')[0]?.endsWith('/artifacts'));
    expect(artifactRequest).toContain('phaseAttempt=2');

    await act(async () => resolveArtifacts(await createJsonResponse([
      createCoverageRevisionArtifact(phase, 4, 2),
    ])));
    expect(screen.queryByRole('button', { name: /checking version [14]/i })).not.toBeInTheDocument();

    await act(async () => resolveLogs(await createJsonResponse([{
      phase,
      status: phase,
      phaseAttempt: 2,
      content: 'Auditing PRD Candidate v4.',
      timestamp: '2026-01-01T00:00:04.000Z',
    }])));

    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (checking version 4)',
    })).toBeInTheDocument());
  });

  it('keeps saved coverage version and pass after a successful empty phase-log response', async () => {
    let resolveLogs!: (response: Response) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      const attemptPhase = phaseFromAttemptsUrl(url);
      if (attemptPhase) return createJsonResponse([createPhaseAttempt(attemptPhase, 1)]);
      if (url.includes('/logs?')) {
        return new Promise<Response>((resolve) => { resolveLogs = resolve; });
      }
      if (url.split('?')[0]?.endsWith('/artifacts')) {
        return createJsonResponse([{
          id: 4,
          ticketId: TEST.ticketId,
          phase: 'VERIFYING_PRD_COVERAGE',
          phaseAttempt: 1,
          artifactType: 'prd_coverage_revision',
          filePath: null,
          content: JSON.stringify({ candidateVersion: 4, coverageRunNumber: 2, maxCoveragePasses: 5 }),
          createdAt: '2026-01-01T00:00:03.000Z',
          updatedAt: '2026-01-01T00:00:03.000Z',
        }]);
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ id: TEST.ticketId, status: 'VERIFYING_PRD_COVERAGE' });
    const phase = 'VERIFYING_PRD_COVERAGE';

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={phase}>
        <WorkspacePhaseSummary phase={phase} ticket={ticket} />
      </LogProvider>,
    );

    await waitFor(() => expect(resolveLogs).toBeTypeOf('function'));
    await act(async () => resolveLogs(await createJsonResponse([])));

    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (checking version 4, pass 2 of 5)',
    })).toBeInTheDocument());
  });

  it('lets the user retry coverage progress after its first phase-log request fails', async () => {
    let logRequests = 0;
    const phase = 'VERIFYING_PRD_COVERAGE';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      const attemptPhase = phaseFromAttemptsUrl(url);
      if (attemptPhase) return createJsonResponse([createPhaseAttempt(attemptPhase, 1)]);
      if (url.includes('/logs?')) {
        logRequests += 1;
        return logRequests === 1
          ? createJsonResponse({ error: 'offline' }, 503)
          : createJsonResponse([{
              phase,
              status: phase,
              phaseAttempt: 1,
              source: 'system',
              kind: 'milestone',
              content: 'Coverage check 2 of 5: auditing PRD Candidate v4.',
              timestamp: '2026-01-01T00:00:04.000Z',
            }]);
      }
      if (url.split('?')[0]?.endsWith('/artifacts')) {
        return createJsonResponse([{
          id: 1,
          ticketId: TEST.ticketId,
          phase,
          phaseAttempt: 1,
          artifactType: 'prd_coverage_revision',
          filePath: null,
          content: JSON.stringify({ candidateVersion: 4, coverageRunNumber: 2, maxCoveragePasses: 5 }),
          createdAt: '2026-01-01T00:00:03.000Z',
          updatedAt: '2026-01-01T00:00:03.000Z',
        }]);
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ id: TEST.ticketId, status: phase });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(getTicketArtifactsQueryKey(ticket.id, { phase, phaseAttempt: 1 }), [{
      id: 1,
      ticketId: ticket.id,
      phase,
      phaseAttempt: 1,
      artifactType: 'prd_coverage_revision',
      filePath: null,
      content: JSON.stringify({ candidateVersion: 1 }),
      createdAt: '2026-01-01T00:00:03.000Z',
      updatedAt: '2026-01-01T00:00:03.000Z',
    }]);

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={phase}>
        <WorkspacePhaseSummary phase={phase} ticket={ticket} />
      </LogProvider>,
      { queryClient },
    );

    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (progress unavailable)',
    })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Retry progress' }));

    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (checking version 4, pass 2 of 5)',
    })).toBeInTheDocument());
    expect(logRequests).toBe(2);
  });

  it('shows unavailable coverage progress and retries a failed active-attempt lookup', async () => {
    let attemptRequests = 0;
    const phase = 'VERIFYING_PRD_COVERAGE';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      const attemptPhase = phaseFromAttemptsUrl(url);
      if (attemptPhase) {
        attemptRequests += 1;
        return attemptRequests === 1
          ? createJsonResponse({ error: 'offline' }, 503)
          : createJsonResponse([createPhaseAttempt(attemptPhase, 1)]);
      }
      if (url.includes('/logs?')) return createJsonResponse([{
        phase,
        status: phase,
        phaseAttempt: 1,
        source: 'system',
        kind: 'milestone',
        content: 'Auditing PRD Candidate v4.',
        timestamp: '2026-01-01T00:00:04.000Z',
      }]);
      if (url.split('?')[0]?.endsWith('/artifacts')) {
        return createJsonResponse([createCoverageRevisionArtifact(phase, 4)]);
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ id: TEST.ticketId, status: phase });

    renderWithProviders(
      <LogProvider ticketId={ticket.id} currentStatus={phase}>
        <WorkspacePhaseSummary phase={phase} ticket={ticket} />
      </LogProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (progress unavailable)',
    })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Retry progress' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry progress' }));

    await waitFor(() => expect(screen.getByRole('button', {
      name: 'Coverage Check (PRD) (checking version 4)',
    })).toBeInTheDocument());
    expect(attemptRequests).toBe(2);
  });

  it('keeps an unknown candidate version distinct from a failed artifact request', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      const attemptPhase = phaseFromAttemptsUrl(url);
      if (attemptPhase) return createJsonResponse([createPhaseAttempt(attemptPhase, 1)]);
      if (url.split('?')[0]?.endsWith('/artifacts')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'offline' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ id: TEST.ticketId, status: 'VERIFYING_PRD_COVERAGE' });

    renderWithLogContext(
      <WorkspacePhaseSummary phase="VERIFYING_PRD_COVERAGE" ticket={ticket} />,
      {
        VERIFYING_PRD_COVERAGE: [
          createLogEntry('Auditing PRD Candidate v1.', '2026-01-01T00:00:01.000Z'),
        ],
      },
    );

    await waitFor(() => {
      expect(screen.getByRole('button', {
        name: 'Coverage Check (PRD) (progress unavailable)',
      })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /checking version 1/i })).not.toBeInTheDocument();
  });

  it("shows the latest live beads coverage version and pass in the main title from coverage artifacts", async () => {
    mockWorkspacePhaseQueries([
      {
        id: 1,
        ticketId: TEST.ticketId,
        phase: "VERIFYING_BEADS_COVERAGE",
        artifactType: "beads_coverage_revision",
        filePath: null,
        content: JSON.stringify({
          winnerId: TEST.councilMembers[0],
          refinedContent: "beads: []",
          candidateVersion: 3,
          coverageRunNumber: 2,
          maxCoveragePasses: 5,
        }),
        createdAt: "2026-01-01T00:00:03.000Z",
      },
    ]);

    const ticket = makeTicket({
      id: TEST.ticketId,
      status: "VERIFYING_BEADS_COVERAGE",
    });

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="VERIFYING_BEADS_COVERAGE"
        ticket={ticket}
      />,
      { queryClient: createTestQueryClient() },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Coverage Check (Beads) (checking version 3, pass 2 of 5)",
        }),
      ).toBeInTheDocument();
    });
    // Coverage progress asks for its own phase only, not every artifact of the ticket.
    const artifactRequests = vi.mocked(globalThis.fetch).mock.calls
      .map(([input]) => String(input))
      .filter((url) => url.split("?")[0]?.endsWith("/artifacts"));
    expect(artifactRequests.length).toBeGreaterThan(0);
    expect(artifactRequests.every((url) => url.endsWith("/artifacts?phase=VERIFYING_BEADS_COVERAGE&phaseAttempt=1"))).toBe(true);
  });

  it.each([
    {
      phase: "VERIFYING_PRD_COVERAGE",
      line: "Revised PRD Candidate v1 into PRD Candidate v2 and saved it to /project/.ticket/prd.yaml.",
      otherPhaseLine: "Revised Implementation Plan v8 into Implementation Plan v9.",
      label: "Coverage Check (PRD) (checking version 2)",
    },
    {
      phase: "VERIFYING_BEADS_COVERAGE",
      line: "Revised Implementation Plan v1 into Implementation Plan v2.",
      otherPhaseLine: "Revised PRD Candidate v8 into PRD Candidate v9 and saved it to /project/.ticket/prd.yaml.",
      label: "Coverage Check (Beads) (checking version 2)",
    },
  ] as const)("shows the saved revision version for $phase and ignores other phase labels", async ({ phase, line, otherPhaseLine, label }) => {
    mockWorkspacePhaseQueries();
    const ticket = makeTicket({ id: TEST.ticketId, status: phase });

    renderWithLogContext(
      <WorkspacePhaseSummary phase={phase} ticket={ticket} />,
      {
        [phase]: [
          createLogEntry(line, "2026-01-01T00:00:00.000Z", phase),
          createLogEntry(otherPhaseLine, "2026-01-01T00:00:01.000Z", phase),
        ],
      },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    });
  });

  it("keeps manual revision logs on the current version and does not invent an automatic pass limit", async () => {
    mockWorkspacePhaseQueries();
    const ticket = makeTicket({ id: TEST.ticketId, status: "VERIFYING_PRD_COVERAGE" });
    renderWithLogContext(
      <WorkspacePhaseSummary phase="VERIFYING_PRD_COVERAGE" ticket={ticket} />,
      {
        VERIFYING_PRD_COVERAGE: [
          createLogEntry(
            "PRD manual coverage fix 1: coverage check 4: revising PRD Candidate v3 after 2 gap(s) were found; response attempt 1 of 3.",
            "2026-01-01T00:00:00.000Z",
          ),
        ],
      },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Coverage Check (PRD) (checking version 3)" })).toBeInTheDocument();
    });
  });

  it("reads the relevant candidate when a log line mentions both planning phases", async () => {
    mockWorkspacePhaseQueries();
    const ticket = makeTicket({ id: TEST.ticketId, status: "VERIFYING_BEADS_COVERAGE" });
    renderWithLogContext(
      <WorkspacePhaseSummary phase="VERIFYING_BEADS_COVERAGE" ticket={ticket} />,
      {
        VERIFYING_BEADS_COVERAGE: [
          createLogEntry(
            "Comparing PRD Candidate v8 with Implementation Plan v2.",
            "2026-01-01T00:00:00.000Z",
            "VERIFYING_BEADS_COVERAGE",
          ),
        ],
      },
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Coverage Check (Beads) (checking version 2)" })).toBeInTheDocument();
    });
  });

  it("shows the live interview coverage pass without a candidate version", async () => {
    mockWorkspacePhaseQueries([
      {
        id: 1,
        ticketId: TEST.ticketId,
        phase: "VERIFYING_INTERVIEW_COVERAGE",
        phaseAttempt: 1,
        artifactType: "interview_coverage",
        filePath: null,
        content: JSON.stringify({
          status: "gaps",
          summary: "Need more details.",
          coverageRunNumber: 2,
          maxCoveragePasses: 5,
        }),
        createdAt: "2026-01-01T00:00:03.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      },
    ]);

    const ticket = makeTicket({
      id: TEST.ticketId,
      status: "VERIFYING_INTERVIEW_COVERAGE",
    });

    renderWithProviders(
      <WorkspacePhaseSummary
        phase="VERIFYING_INTERVIEW_COVERAGE"
        ticket={ticket}
      />,
      { queryClient: createTestQueryClient() },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Coverage Check (Interview) (pass 2 of 5)",
        }),
      ).toBeInTheDocument();
    });
  });

  it("shows the live retry attempt for manually retried phases", async () => {
    mockWorkspacePhaseQueries([], "REFINING_PRD");

    const ticket = makeTicket({ id: TEST.ticketId, status: "REFINING_PRD" });

    renderWithProviders(
      <WorkspacePhaseSummary phase="REFINING_PRD" ticket={ticket} />,
      { queryClient: createTestQueryClient() },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Refining Specs (retry attempt 2)",
        }),
      ).toBeInTheDocument();
    });
  });

  it("shows the live execution setup attempt when status is PREPARING_EXECUTION_ENV", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:02:00.000Z"));
    const ticket = makeTicket({
      id: TEST.ticketId,
      status: "PREPARING_EXECUTION_ENV",
      runtime: {
        ...makeTicket().runtime,
        executionSetupTimeoutMs: 20 * 60 * 1000,
      },
    });
    const logsByPhase = {
      PREPARING_EXECUTION_ENV: [
        {
          id: "log-1",
          entryId: "log-1",
          line: "Starting execution setup attempt 2 of 5.",
          source: "system",
          status: "PREPARING_EXECUTION_ENV",
          timestamp: "2026-01-01T00:00:00.000Z",
          audience: "all",
          kind: "info",
          streaming: false,
          op: "append",
        } as LogEntry,
      ],
    };

    renderWithLogContext(
      <WorkspacePhaseSummary phase="PREPARING_EXECUTION_ENV" ticket={ticket} />,
      logsByPhase,
    );

    expect(
      screen.getByRole("button", {
        name: "Preparing Workspace Runtime (execution setup attempt 2 of 5)",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText("18:00")).toBeInTheDocument();
    expect(screen.getByText("20:00")).toBeInTheDocument();
  });

  it("shows the live execution setup attempt with phase attempt label when status is PREPARING_EXECUTION_ENV", async () => {
    mockWorkspacePhaseQueries([], "PREPARING_EXECUTION_ENV");

    const ticket = makeTicket({
      id: TEST.ticketId,
      status: "PREPARING_EXECUTION_ENV",
    });
    const logsByPhase = {
      PREPARING_EXECUTION_ENV: [
        {
          id: "log-1",
          entryId: "log-1",
          line: "Starting execution setup attempt 3 of 5.",
          source: "system",
          status: "PREPARING_EXECUTION_ENV",
          timestamp: "2026-01-01T00:00:00.000Z",
          audience: "all",
          kind: "info",
          streaming: false,
          op: "append",
          phaseAttempt: 2,
        } as LogEntry,
      ],
    };

    renderWithLogContext(
      <WorkspacePhaseSummary phase="PREPARING_EXECUTION_ENV" ticket={ticket} />,
      logsByPhase,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Preparing Workspace Runtime (retry attempt 2 - execution setup attempt 3 of 5)",
        }),
      ).toBeInTheDocument();
    });
  });

  it.each([
    {
      line: "Resuming execution setup session for user-requested attempt 3 (configured automatic budget 5).",
      timestamp: "2026-01-01T00:01:00.000Z",
      expected: "execution setup attempt 3 of 5",
    },
    {
      line: "Resuming execution setup session for user-requested attempt 2.",
      timestamp: undefined,
      expected: "execution setup attempt 2",
    },
    {
      line: "Starting execution setup tooling persistence attempt 4 for the workspace with base budget 6.",
      timestamp: "2026-01-01T00:01:00.000Z",
      expected: "execution setup attempt 4 of 6",
    },
    {
      line: "Execution setup attempt 4 session created.",
      timestamp: "2026-01-01T00:01:00.000Z",
      expected: "execution setup attempt 4",
    },
    {
      line: "Execution setup attempt 3 produced a runtime profile.",
      timestamp: "2026-01-01T00:01:00.000Z",
      expected: "execution setup attempt 3",
    },
    {
      line: "Execution setup attempt 5 failed while checking project tools.",
      timestamp: "2026-01-01T00:01:00.000Z",
      expected: "execution setup attempt 5",
    },
  ])(
    "shows live setup progress from log: $line",
    ({ line, timestamp, expected }) => {
      mockWorkspacePhaseQueries();
      const ticket = makeTicket({ status: "PREPARING_EXECUTION_ENV" });

      renderWithLogContext(
        <WorkspacePhaseSummary
          phase="PREPARING_EXECUTION_ENV"
          ticket={ticket}
        />,
        {
          PREPARING_EXECUTION_ENV: [
            createLogEntry(line, timestamp, "PREPARING_EXECUTION_ENV"),
          ],
        },
      );

      expect(
        screen.getByRole("button", {
          name: `Preparing Workspace Runtime (${expected})`,
        }),
      ).toBeInTheDocument();
    },
  );

  it("shows the base execution setup label when its live logs have no recognized attempt", () => {
    mockWorkspacePhaseQueries();
    const ticket = makeTicket({ status: "PREPARING_EXECUTION_ENV" });

    renderWithLogContext(
      <WorkspacePhaseSummary phase="PREPARING_EXECUTION_ENV" ticket={ticket} />,
      {
        PREPARING_EXECUTION_ENV: [
          createLogEntry(
            "Checking the project workspace.",
            TEST.timestamp,
            "PREPARING_EXECUTION_ENV",
          ),
        ],
      },
    );

    expect(
      screen.getByRole("button", { name: "Preparing Workspace Runtime" }),
    ).toBeInTheDocument();
  });

  it.each([
    {
      line: "Revised PRD Candidate v2 into PRD Candidate v4.",
      expected: "checking version 4",
    },
    {
      line: "The latest PRD Candidate v5 is ready for another review.",
      expected: "checking version 5",
    },
  ])(
    "shows the version from a $expected coverage log",
    async ({ line, expected }) => {
      mockWorkspacePhaseQueries();
      const ticket = makeTicket({ status: "VERIFYING_PRD_COVERAGE" });

      renderWithLogContext(
        <WorkspacePhaseSummary
          phase="VERIFYING_PRD_COVERAGE"
          ticket={ticket}
        />,
        {
          VERIFYING_PRD_COVERAGE: [
            createLogEntry(
              "Transition: REFINING_PRD -> VERIFYING_PRD_COVERAGE",
              "2026-01-01T00:00:00.000Z",
            ),
            createLogEntry(line, "2026-01-01T00:00:01.000Z"),
          ],
        },
      );

      await waitFor(() => {
        expect(
          screen.getByRole("button", {
            name: `Coverage Check (PRD) (${expected})`,
          }),
        ).toBeInTheDocument();
      });
    },
  );

  it("uses the active attempt and ignores a model's fake phase transition", async () => {
    const phase = "VERIFYING_PRD_COVERAGE";
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockImplementation((input) => {
      const url = String(input);
      const attemptPhase = phaseFromAttemptsUrl(url);
      if (attemptPhase) {
        return createJsonResponse([
          createPhaseAttempt(attemptPhase, 2),
          createPhaseAttempt(attemptPhase, 1, "archived", "manual_retry_after_blocked_error"),
        ]);
      }
      if (url.split("?")[0]?.endsWith("/artifacts")) {
        return createJsonResponse([
          createCoverageRevisionArtifact(phase, 9, 1, 9, 9),
          createCoverageRevisionArtifact(phase, 4, 2, 2, 5),
        ]);
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ status: phase });
    const queryClient = createTestQueryClient();

    renderWithLogContext(
      <WorkspacePhaseSummary phase={phase} ticket={ticket} />,
      {
        [phase]: [
          createLogEntry("Auditing PRD Candidate v4.", "2026-01-01T00:00:01.000Z", phase, "system", "milestone", 2),
          createLogEntry("Tool output mentions previous -> VERIFYING_PRD_COVERAGE.", "2026-01-01T00:00:02.000Z", phase, "model:test-model", "tool", 2),
        ],
      },
      queryClient,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", {
        name: "Coverage Check (PRD) (checking version 4, pass 2 of 5)",
      })).toBeInTheDocument();
    });
    expect(fetchMock.mock.calls.map(([input]) => String(input)).find((url) => url.includes("/artifacts?")))
      .toContain("phaseAttempt=2");
  });

  it("falls back to the generic error summary when no recovery action is available", () => {
    const ticket = makeTicket({ status: "BLOCKED_ERROR" });

    renderWithProviders(
      <WorkspacePhaseSummary phase="BLOCKED_ERROR" ticket={ticket} />,
    );

    expect(
      screen.getByRole("button", { name: "Error: Workflow phase" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/No error details were captured/),
    ).toHaveTextContent(
      /Open Details to review the failure and available recovery options/,
    );
  });

  it("does not show a countdown for a completed bead in a live coding phase", () => {
    const ticket = makeTicket({
      status: "CODING",
      runtime: {
        ...makeTicket().runtime,
        activeBeadId: "bead-1",
        perIterationTimeoutMs: 8 * 60 * 1000,
        beads: [
          {
            id: "bead-1",
            title: "Completed bead",
            status: "completed",
            iteration: 1,
            startedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });

    renderWithProviders(
      <WorkspacePhaseSummary phase="CODING" ticket={ticket} />,
    );

    expect(screen.queryByText("08:00")).not.toBeInTheDocument();
  });

  it("does not infer a candidate version from malformed coverage artifacts", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.split("?")[0]?.endsWith("/artifacts")) {
        return createJsonResponse([
          {
            id: 1,
            ticketId: TEST.ticketId,
            phase: "VERIFYING_PRD_COVERAGE",
            artifactType: "prd_coverage",
            filePath: null,
            content: "{ malformed coverage record",
            createdAt: TEST.timestamp,
            updatedAt: TEST.timestamp,
          },
          {
            id: 2,
            ticketId: TEST.ticketId,
            phase: "VERIFYING_PRD_COVERAGE",
            artifactType: "prd_coverage_revision",
            filePath: null,
            content: "{ malformed candidate record",
            createdAt: TEST.timestamp,
            updatedAt: TEST.timestamp,
          },
        ]);
      }
      const attemptPhase = phaseFromAttemptsUrl(url);
      if (attemptPhase) return createJsonResponse([createPhaseAttempt(attemptPhase, 1)]);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ status: "VERIFYING_PRD_COVERAGE" });
    const queryClient = createTestQueryClient();

    renderWithProviders(
      <WorkspacePhaseSummary phase="VERIFYING_PRD_COVERAGE" ticket={ticket} />,
      { queryClient },
    );

    await waitFor(() => {
      expect(
        queryClient.getQueryData(getTicketArtifactsQueryKey(ticket.id, { phase: "VERIFYING_PRD_COVERAGE", phaseAttempt: 1 })),
      ).toHaveLength(2);
      expect(
        screen.getByRole("button", {
          name: "Coverage Check (PRD)",
        }),
      ).toBeInTheDocument();
    });
  });
});
