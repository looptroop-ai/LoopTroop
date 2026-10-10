import type { ReactElement } from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActor } from "xstate";
import { ticketMachine } from "@server/machines/ticketMachine";
import type { LogContextValue, LogEntry } from "@/context/logUtils";
import { TEST, makeTicket } from "@/test/factories";
import { getTicketArtifactsQueryKey } from "@/hooks/useTicketArtifacts";
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
): LogEntry {
  return {
    id: `${timestamp}:${line}`,
    entryId: `${timestamp}:${line}`,
    line,
    source: "system",
    status,
    timestamp,
    audience: "all",
    kind: "milestone",
    streaming: false,
    op: "append",
  };
}

function mockWorkspacePhaseQueries(
  artifacts: unknown[] = [],
  retriedPhase?: string,
) {
  vi.mocked(globalThis.fetch).mockImplementation((input) => {
    const url = String(input);
    if (
      url.endsWith(
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`,
      )
    )
      return createJsonResponse(artifacts);
    if (
      retriedPhase
        ? url.endsWith(
            `/api/tickets/${encodeURIComponent(TEST.ticketId)}/phases/${retriedPhase}/attempts`,
          )
        : url.includes("/attempts")
    ) {
      return createJsonResponse(
        retriedPhase
          ? [
              {
                ticketId: TEST.ticketId,
                phase: retriedPhase,
                attemptNumber: 2,
                state: "active",
                archivedReason: null,
                createdAt: "2026-01-01T00:01:00.000Z",
                archivedAt: null,
              },
              {
                ticketId: TEST.ticketId,
                phase: retriedPhase,
                attemptNumber: 1,
                state: "archived",
                archivedReason: "manual_retry_after_blocked_error",
                createdAt: "2026-01-01T00:00:00.000Z",
                archivedAt: "2026-01-01T00:01:00.000Z",
              },
            ]
          : [],
      );
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
    if (url.includes("/attempts")) {
      return createJsonResponse([
        {
          ticketId: TEST.ticketId,
          phase: "DRAFTING_PRD",
          attemptNumber: 1,
          state: "active",
          archivedReason: null,
          createdAt: TEST.timestamp,
          archivedAt: null,
        },
      ]);
    }
    if (
      url.endsWith(
        `/api/tickets/${encodeURIComponent(TEST.ticketId)}/artifacts`,
      )
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

    expect(screen.getByRole("dialog")).toBeInTheDocument();
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

  it("ignores stale coverage artifacts from before the current coverage activation", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/artifacts")) {
        return createJsonResponse([
          {
            id: 1,
            ticketId: TEST.ticketId,
            phase: "VERIFYING_PRD_COVERAGE",
            artifactType: "prd_coverage_revision",
            filePath: null,
            content: JSON.stringify({
              candidateVersion: 9,
              coverageRunNumber: 9,
              maxCoveragePasses: 9,
            }),
            createdAt: "2026-01-01T00:00:30.000Z",
            updatedAt: "2026-01-01T00:00:30.000Z",
          },
        ]);
      }
      if (url.includes("/attempts")) return createJsonResponse([]);
      throw new Error(`Unhandled fetch: ${url}`);
    });
    const ticket = makeTicket({ status: "VERIFYING_PRD_COVERAGE" });
    const queryClient = createTestQueryClient();

    renderWithLogContext(
      <WorkspacePhaseSummary phase="VERIFYING_PRD_COVERAGE" ticket={ticket} />,
      {
        VERIFYING_PRD_COVERAGE: [
          createLogEntry(
            "Transition: REFINING_PRD -> VERIFYING_PRD_COVERAGE",
            "2026-01-01T00:01:00.000Z",
          ),
          createLogEntry(
            "PRD coverage check 3 of 5: auditing PRD Candidate v2; response attempt 2 of 3.",
            "2026-01-01T00:02:00.000Z",
          ),
          createLogEntry(
            "Preparing the request for PRD Candidate v2; response attempt 3 of 3.",
            "2026-01-01T00:03:00.000Z",
          ),
        ],
      },
      queryClient,
    );

    await waitFor(() => {
      expect(
        queryClient.getQueryData(getTicketArtifactsQueryKey(ticket.id)),
      ).toHaveLength(1);
      expect(
        screen.getByRole("button", {
          name: "Coverage Check (PRD) (checking version 2, pass 3 of 5)",
        }),
      ).toBeInTheDocument();
    });
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

  it("falls back safely when stored coverage artifacts contain malformed JSON", async () => {
    vi.mocked(globalThis.fetch).mockImplementation((input) => {
      const url = String(input);
      if (url.endsWith("/artifacts")) {
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
      if (url.includes("/attempts")) return createJsonResponse([]);
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
        queryClient.getQueryData(getTicketArtifactsQueryKey(ticket.id)),
      ).toHaveLength(2);
      expect(
        screen.getByRole("button", {
          name: "Coverage Check (PRD) (checking version 1)",
        }),
      ).toBeInTheDocument();
    });
  });
});
