import { act, fireEvent, screen, within } from "@testing-library/react";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { LogContextValue, LogEntry } from "@/context/logUtils";
import { renderWithProviders, withLogContext } from "@/test/renderHelpers";
import { makeTicket } from "@/test/factories";
import type { TicketErrorOccurrence } from "@/lib/errorOccurrences";
import { ErrorView } from "../ErrorView";
import {
  BEAD_AGENT_RESPONSE_INVALID,
  BEAD_FINALIZATION_FAILED,
  BEAD_ITERATION_TIMEOUT,
  BEAD_RETRY_BUDGET_EXHAUSTED,
  FINAL_TEST_FAILED,
  OPENCODE_PROVIDER_AUTH_FAILED,
  OPENCODE_PROVIDER_ERROR,
} from "@shared/errorCodes";

const logSectionMock = vi.hoisted(() =>
  vi.fn(() => <div data-testid="phase-log-section" />),
);
const mockUseTicketAction = vi.hoisted(() => vi.fn());
const mockUseCancelTicket = vi.hoisted(() => vi.fn());

vi.mock("../CollapsiblePhaseLogSection", () => ({
  CollapsiblePhaseLogSection: logSectionMock,
}));

vi.mock("@/hooks/useTickets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useTickets")>();
  return {
    ...actual,
    useTicketAction: () => mockUseTicketAction(),
    useCancelTicket: () => mockUseCancelTicket(),
  };
});

const usageLimitDiagnostics: TicketErrorOccurrence["diagnostics"] = {
  kind: "opencode_provider",
  source: "provider",
  summary: "usage limit reached",
  sessionId: "ses-continue",
  statusCode: 429,
  isRetryable: true,
};

function makeLiveErrorTicket(
  overrides: Partial<
    Pick<
      TicketErrorOccurrence,
      "id" | "blockedFromStatus" | "errorMessage" | "diagnostics"
    >
  > = {},
  availableActions: ReturnType<typeof makeTicket>["availableActions"] = [
    "retry",
    "cancel",
  ],
) {
  const occurrence: TicketErrorOccurrence = {
    id: "coding-error",
    occurrenceNumber: 1,
    blockedFromStatus: "CODING",
    errorMessage: "Implementation failed.",
    errorCodes: [],
    occurredAt: "2026-01-01T00:00:00.000Z",
    resolvedAt: null,
    resolutionStatus: null,
    resumedToStatus: null,
    ...overrides,
  };
  return makeTicket({
    status: "BLOCKED_ERROR",
    previousStatus: occurrence.blockedFromStatus,
    availableActions,
    activeErrorOccurrenceId: occurrence.id,
    errorOccurrences: [occurrence],
  });
}

describe("ErrorView", () => {
  beforeEach(() => {
    logSectionMock.mockClear();
    mockUseTicketAction.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseCancelTicket.mockReturnValue({
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
      isPending: false,
    });
  });

  it.each([
    [BEAD_AGENT_RESPONSE_INVALID, "CODING", "Agent response incomplete"],
    [BEAD_ITERATION_TIMEOUT, "CODING", "Implementation attempt timed out"],
    [OPENCODE_PROVIDER_ERROR, "CODING", "Provider or environment unavailable"],
    [
      OPENCODE_PROVIDER_AUTH_FAILED,
      "CODING",
      "Provider or environment unavailable",
    ],
    [BEAD_RETRY_BUDGET_EXHAUSTED, "CODING", "Implementation retries exhausted"],
    [BEAD_FINALIZATION_FAILED, "CODING", "Git finalization failed"],
    [FINAL_TEST_FAILED, "RUNNING_FINAL_TEST", "Final Testing failed"],
  ])(
    "explains %s using its stable workflow cause",
    (errorCode, blockedFromStatus, expectedTitle) => {
      const ticket = makeTicket({
        status: "BLOCKED_ERROR",
        previousStatus: blockedFromStatus,
        availableActions: ["retry", "cancel"],
        activeErrorOccurrenceId: `error-${errorCode}`,
        errorOccurrences: [
          {
            id: `error-${errorCode}`,
            occurrenceNumber: 1,
            blockedFromStatus,
            errorMessage: "Low-level failure detail",
            errorCodes: [errorCode],
            occurredAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: null,
            resolutionStatus: null,
            resumedToStatus: null,
          },
        ],
      });

      renderWithProviders(<ErrorView ticket={ticket} />);

      const errorMessage = screen.getByText("Low-level failure detail");
      const explanation = screen.getByRole("heading", { name: expectedTitle });
      expect(errorMessage).toBeVisible();
      expect(errorMessage.closest("details")).toBeNull();
      expect(
        errorMessage.compareDocumentPosition(explanation) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getByText("Technical details")).toBeInTheDocument();
    },
  );

  it.each([
    "SCANNING_RELEVANT_FILES",
    "DRAFTING_PRD",
    "INTEGRATING",
    "UNKNOWN_PHASE",
  ])(
    "leads with the actual %s error without generic boilerplate",
    (blockedFromStatus) => {
      const ticket = makeTicket({
        status: "BLOCKED_ERROR",
        previousStatus: blockedFromStatus,
        errorMessage: "The workflow request could not reach OpenCode.",
        availableActions: ["retry", "cancel"],
      });

      renderWithProviders(<ErrorView ticket={ticket} />);

      const errorMessage = screen.getByText(
        "The workflow request could not reach OpenCode.",
      );
      const details = screen.getByText("Technical details").closest("details");
      assert(details);
      expect(errorMessage).toBeVisible();
      expect(errorMessage.closest("details")).toBeNull();
      expect(details).not.toHaveAttribute("open");
      expect(
        errorMessage.compareDocumentPosition(details) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        screen.queryByText(
          /Blocked: Error|Active error|Blocked from|Workflow step failed|Recommended:/,
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(
          /use an available recovery action|current workflow step could not finish safely/i,
        ),
      ).not.toBeInTheDocument();
      const retry = screen.getByRole("button", { name: "Retry" });
      expect(retry).toBeVisible();
      expect(
        retry.compareDocumentPosition(details) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(screen.getByText("Technical details"));
      expect(details).toHaveAttribute("open");
      fireEvent.click(screen.getByText("Technical details"));
      expect(details).not.toHaveAttribute("open");
      expect(errorMessage).toBeVisible();
      expect(retry).toBeVisible();
    },
  );

  it("keeps a useful fallback visible when no error message was captured", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "SCANNING_RELEVANT_FILES",
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByText(
        "No error details were captured. Check the server logs.",
      ),
    ).toBeVisible();
  });

  it("uses a real heading when the failed phase is unavailable", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: null,
      errorMessage: "Request failed.",
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(screen.getByRole("heading", { name: "Error" })).toBeVisible();
    expect(screen.queryByText("Error (reason)")).not.toBeInTheDocument();
  });

  it("omits an empty technical-details disclosure", () => {
    const ticket = makeTicket({
      status: "CANCELED",
      previousStatus: "BLOCKED_ERROR",
      errorMessage: "Request failed.",
    });

    renderWithProviders(<ErrorView ticket={ticket} readOnly />);

    expect(screen.getByText("Request failed.")).toBeVisible();
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
  });

  it.each([
    [BEAD_FINALIZATION_FAILED, "CODING"],
    [FINAL_TEST_FAILED, "RUNNING_FINAL_TEST"],
    [OPENCODE_PROVIDER_ERROR, "SCANNING_RELEVANT_FILES"],
    ["", "GENERATING_EXECUTION_SETUP_PLAN"],
  ])(
    "does not recommend unavailable recovery for %s in %s",
    (errorCode, blockedFromStatus) => {
      const ticket = makeLiveErrorTicket();
      const occurrence = ticket.errorOccurrences?.[0];
      assert(occurrence);
      occurrence.blockedFromStatus = blockedFromStatus;
      occurrence.errorCodes = errorCode ? [errorCode] : [];
      ticket.availableActions = ["cancel"];

      renderWithProviders(<ErrorView ticket={ticket} />);

      expect(screen.getByRole("button", { name: "Cancel…" })).toBeVisible();
      expect(
        screen.queryByText(/^(Retry|Continue|Review the failed checks)/),
      ).not.toBeInTheDocument();
    },
  );

  it.each<{
    actions: ReturnType<typeof makeTicket>["availableActions"];
    recommendation: string | null;
  }>([
    { actions: [], recommendation: null },
    {
      actions: ["retry", "cancel"],
      recommendation: "Retry after the service or credentials recover.",
    },
    {
      actions: ["continue", "cancel"],
      recommendation:
        "Continue the preserved session after the service or credentials recover.",
    },
    {
      actions: ["continue", "retry", "cancel"],
      recommendation:
        "Continue the preserved session, or retry after the service or credentials recover.",
    },
  ])(
    "matches provider recovery guidance and keyboard order to $actions",
    ({ actions, recommendation }) => {
      const ticket = makeLiveErrorTicket();
      const occurrence = ticket.errorOccurrences?.[0];
      assert(occurrence);
      occurrence.errorCodes = [OPENCODE_PROVIDER_ERROR];
      ticket.availableActions = actions;

      renderWithProviders(<ErrorView ticket={ticket} />);

      if (!recommendation) {
        expect(screen.queryByRole("button")).not.toBeInTheDocument();
        expect(screen.queryByText(/^(Retry|Continue)/)).not.toBeInTheDocument();
        return;
      }
      expect(screen.getByText(recommendation)).toBeVisible();
      const firstButton = screen.getAllByRole("button")[0];
      expect(firstButton).toHaveTextContent(
        actions.includes("continue") ? "Continue" : "Retry",
      );
      expect(screen.getAllByRole("button").at(-1)).toHaveTextContent("Cancel…");
    },
  );

  it("recommends setup-plan editing alone when retry is unavailable", () => {
    const ticket = makeLiveErrorTicket();
    const occurrence = ticket.errorOccurrences?.[0];
    assert(occurrence);
    occurrence.blockedFromStatus = "PREPARING_EXECUTION_ENV";
    ticket.availableActions = ["edit_execution_setup_plan", "cancel"];

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByText(
        "Edit the setup plan to correct the reported environment problem.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/retry after fixing/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Edit setup plan..." }),
    ).toBeVisible();
  });

  it("shows the reported event-history failure before its expanded diagnostics and recovery controls", () => {
    const message =
      "Relevant files scan failed: Failed to prompt OpenCode session: OpenCode v2 event history has an unaccounted durable sequence gap; the response cannot be attributed safely.";
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "SCANNING_RELEVANT_FILES",
      availableActions: ["retry", "cancel"],
      activeErrorOccurrenceId: "scan-gap",
      errorOccurrences: [
        {
          id: "scan-gap",
          occurrenceNumber: 1,
          blockedFromStatus: "SCANNING_RELEVANT_FILES",
          errorMessage: message,
          errorCodes: ["RELEVANT_FILES_SCAN_FAILED"],
          diagnostics: {
            kind: "transport",
            source: "opencode",
            summary: message,
            modelId: "provider/model",
            sessionId: "ses-scan-gap",
          },
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByRole("heading", { name: "Scanning Relevant Files" }),
    ).toBeVisible();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByText(message)).toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Transport")).toBeVisible();
    expect(screen.getByText("Opencode")).toBeVisible();
    expect(screen.getByText("provider/model")).toBeVisible();
    expect(screen.getByText("ses-scan-gap")).toBeVisible();
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(
      screen.getByText(message).compareDocumentPosition(retry) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      retry.compareDocumentPosition(screen.getByText("Model:")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the selected historical failure visible with its resolution and no recovery controls", () => {
    const activeTicket = makeLiveErrorTicket();
    const activeOccurrence = activeTicket.errorOccurrences?.[0];
    assert(activeOccurrence);
    const occurrence = {
      ...activeOccurrence,
      id: "resolved-coding-error",
      errorMessage: "An earlier coding attempt timed out.",
      errorCodes: [BEAD_ITERATION_TIMEOUT],
      resolvedAt: "2026-01-01T00:01:00.000Z",
      resolutionStatus: "RETRIED" as const,
      resumedToStatus: "CODING",
    };
    const ticket = makeTicket({
      ...activeTicket,
      errorOccurrences: [occurrence, activeOccurrence],
      runtime: {
        ...activeTicket.runtime,
        currentBead: 4,
        totalBeads: 5,
        lastFailedBeadId: "current-bead",
        activeBeadIteration: 2,
        beads: [
          {
            id: "current-bead",
            title: "Current failed bead",
            status: "failed",
            iteration: 2,
            failedIterationNotes: [
              {
                timestamp: "2026-01-01T00:02:00.000Z",
                iteration: 2,
                content: "Current failed iteration",
              },
            ],
            userRetryNotes: [
              {
                timestamp: "2026-01-01T00:03:00.000Z",
                iteration: 2,
                content: "Current retry guidance",
              },
            ],
            finalizationFailureNotes: [
              {
                timestamp: "2026-01-01T00:04:00.000Z",
                iteration: 2,
                content: "Current finalization failure",
              },
            ],
          },
        ],
      },
    });

    renderWithProviders(
      <ErrorView ticket={ticket} occurrence={occurrence} readOnly />,
    );

    expect(
      screen.getByText("An earlier coding attempt timed out."),
    ).toBeVisible();
    expect(screen.getByText(/^Retried to Implementing/)).toBeVisible();
    expect(screen.getByRole("heading", { name: "Implementing" })).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Implementation attempt timed out" }),
    ).toBeVisible();
    expect(
      screen.getByText("Technical details").closest("details"),
    ).not.toHaveAttribute("open");
    expect(screen.getByText(/Resolved /)).not.toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText(/Resolved /)).toBeVisible();
    expect(
      screen.queryByText("Implementation failed."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Retry the bead with an extra note/),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Bead 4\/5|Bead \?\/\?|Failed bead|current-bead/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(
        /Current failed iteration|Current retry guidance|Current finalization failure/,
      ),
    ).not.toBeInTheDocument();
  });

  it("treats an older unresolved occurrence as history even without a readOnly prop", () => {
    const ticket = makeLiveErrorTicket();
    const activeOccurrence = ticket.errorOccurrences?.[0];
    assert(activeOccurrence);
    const occurrence = {
      ...activeOccurrence,
      id: "older-unresolved",
      errorMessage: "An older failure.",
    };
    ticket.errorOccurrences = [occurrence, activeOccurrence];

    renderWithProviders(<ErrorView ticket={ticket} occurrence={occurrence} />);

    expect(screen.getByText("An older failure.")).toBeVisible();
    expect(screen.getByText("Read-only")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("does not use the live ticket message for an empty historical error", () => {
    const ticket = makeLiveErrorTicket();
    const activeOccurrence = ticket.errorOccurrences?.[0];
    assert(activeOccurrence);
    const occurrence = {
      ...activeOccurrence,
      id: "older-empty",
      errorMessage: "",
      resolvedAt: "2026-01-01T00:01:00.000Z",
    };
    ticket.errorMessage = "The newest ticket error.";
    ticket.errorOccurrences = [occurrence, activeOccurrence];

    renderWithProviders(
      <ErrorView ticket={ticket} occurrence={occurrence} readOnly />,
    );

    expect(
      screen.getByText(
        "No error details were captured. Check the server logs.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("The newest ticket error."),
    ).not.toBeInTheDocument();
  });

  it("uses the failed workflow phase for workspace setup errors without guessing from logs", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "PREPARING_EXECUTION_ENV",
      activeErrorOccurrenceId: "setup-failure",
      errorOccurrences: [
        {
          id: "setup-failure",
          occurrenceNumber: 1,
          blockedFromStatus: "PREPARING_EXECUTION_ENV",
          errorMessage: "Opaque low-level detail",
          errorCodes: [],
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByRole("heading", { name: "Workspace setup failed" }),
    ).toBeInTheDocument();
  });

  it("identifies operational failures from workspace setup drafting", () => {
    const ticket = makeLiveErrorTicket({
      id: "setup-drafting-failure",
      blockedFromStatus: "GENERATING_EXECUTION_SETUP_PLAN",
      errorMessage: "Provider request failed.",
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByRole("heading", { name: "Workspace setup drafting failed" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/retry the drafting phase/i)).toBeInTheDocument();
  });

  it("requires confirmation before canceling a blocked ticket", async () => {
    const cancelMutate = vi.fn();
    mockUseCancelTicket.mockReturnValue({
      mutate: cancelMutate,
      mutateAsync: cancelMutate,
      isPending: false,
    });
    const ticket = makeLiveErrorTicket();

    renderWithProviders(<ErrorView ticket={ticket} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel…/i }));
    expect(cancelMutate).not.toHaveBeenCalled();
    expect(screen.getByText("Cancel Ticket")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Yes, Cancel Ticket" }),
      );
    });
    expect(cancelMutate).toHaveBeenCalledWith({
      id: ticket.id,
      options: {
        deleteContent: false,
        deleteLog: false,
        deleteTicket: false,
        reason: "",
      },
    });
  });

  it("allows long error details to scroll within the summary area", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
      errorMessage: "A".repeat(4000),
      availableActions: ["retry", "cancel"],
    });

    const { container } = renderWithProviders(<ErrorView ticket={ticket} />);
    const root = container.firstElementChild as HTMLElement;
    const summary = root.firstElementChild as HTMLElement;

    expect(root).toHaveClass("min-h-0");
    expect(summary).toHaveClass("min-h-0", "shrink", "overflow-y-auto");
    expect(screen.getByTestId("phase-log-section")).toBeInTheDocument();
  });

  it("starts the error log drawer collapsed at the bottom", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    const firstLogSectionProps = (
      logSectionMock.mock.calls[0] as [unknown] | undefined
    )?.[0];
    expect(firstLogSectionProps).toMatchObject({
      phase: "CODING",
      defaultExpanded: false,
    });
  });

  it("shows each append-only bead note history under its own heading", () => {
    const base = makeLiveErrorTicket();
    const ticket = makeTicket({
      ...base,
      runtime: {
        ...base.runtime,
        lastFailedBeadId: "bead-1",
        beads: [
          {
            id: "bead-1",
            title: "Failed bead",
            status: "failed",
            iteration: 2,
            failedIterationNotes: [
              {
                timestamp: "2026-01-01T00:00:00.000Z",
                iteration: 1,
                content: "iteration failed",
              },
            ],
            userRetryNotes: [
              {
                timestamp: "2026-01-01T00:01:00.000Z",
                iteration: 2,
                content: "try the alternate path",
              },
            ],
            finalizationFailureNotes: [
              {
                timestamp: "2026-01-01T00:02:00.000Z",
                iteration: 2,
                content: "commit failed",
                errorCode: "COMMIT_FAILED",
              },
            ],
          },
        ],
      },
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(screen.getByText("Failed Iteration Notes")).toBeInTheDocument();
    expect(screen.getByText("User Retry Notes")).toBeInTheDocument();
    expect(screen.getByText("Finalization Failure Notes")).toBeInTheDocument();
    expect(screen.getByText("iteration failed")).toBeInTheDocument();
    expect(screen.getByText("try the alternate path")).toBeInTheDocument();
    expect(screen.getByText("commit failed")).toBeInTheDocument();
  });

  it("preserves duplicate codes and distinct note records across insertion and reordering", () => {
    const multilineCode = "TRANSPORT_FAILED\nThe OpenCode connection closed.";
    const note = {
      timestamp: "2026-01-01T00:00:00.000Z",
      iteration: 1,
      content: "iteration failed",
      errorCode: "CHECK_FAILED",
    };
    const otherCodeNote = { ...note, errorCode: "CHECK_TIMEOUT" };
    const otherContentNote = { ...note, content: "provider interrupted" };
    const ticket = makeTicket({
      ...makeLiveErrorTicket(),
      runtime: {
        lastFailedBeadId: "bead-1",
        beads: [
          {
            id: "bead-1",
            title: "Failed bead",
            status: "error",
            iteration: 1,
            failedIterationNotes: [
              note,
              { ...note },
              otherCodeNote,
              otherContentNote,
            ],
          },
        ],
      },
    });
    const occurrence = ticket.errorOccurrences?.[0];
    const failedBead = ticket.runtime.beads?.[0];
    assert(occurrence && failedBead);
    occurrence.errorCodes = [
      "CHECK_FAILED",
      "CHECK_FAILED",
      multilineCode,
      multilineCode,
    ];
    const consoleError = vi.spyOn(console, "error");

    try {
      const { rerender } = renderWithProviders(<ErrorView ticket={ticket} />);
      const details = screen.getByText("Technical details").closest("details");
      assert(details);
      const codes = within(details).getAllByText("CHECK_FAILED");
      const multilineCodes = within(details).getAllByText(multilineCode, {
        exact: true,
        normalizer: (value) => value,
      });
      const notes = screen.getAllByText("iteration failed");
      const otherContent = screen.getByText("provider interrupted");
      expect(codes).toHaveLength(2);
      expect(multilineCodes).toHaveLength(2);
      expect(notes).toHaveLength(3);
      expect(screen.getAllByText("CHECK_TIMEOUT")).toHaveLength(1);

      occurrence.errorCodes = [
        "UNRELATED_FAILURE",
        multilineCode,
        multilineCode,
        "CHECK_FAILED",
        "CHECK_FAILED",
      ];
      failedBead.failedIterationNotes = [
        { ...note, content: "unrelated note" },
        otherContentNote,
        otherCodeNote,
        note,
        { ...note },
      ];
      rerender(<ErrorView ticket={{ ...ticket }} />);

      const reorderedCodes = within(details).getAllByText("CHECK_FAILED");
      const reorderedMultilineCodes = within(details).getAllByText(
        multilineCode,
        { exact: true, normalizer: (value) => value },
      );
      const reorderedNotes = screen.getAllByText("iteration failed");
      expect(reorderedCodes[0]).toBe(codes[0]);
      expect(reorderedCodes[1]).toBe(codes[1]);
      expect(reorderedMultilineCodes[0]).toBe(multilineCodes[0]);
      expect(reorderedMultilineCodes[1]).toBe(multilineCodes[1]);
      expect(reorderedNotes[0]).toBe(notes[2]);
      expect(reorderedNotes[1]).toBe(notes[0]);
      expect(reorderedNotes[2]).toBe(notes[1]);
      expect(screen.getByText("provider interrupted")).toBe(otherContent);
      expect(screen.getByText("unrelated note")).toBeVisible();
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shows a coding-specific retry label when the active error exhausted the bead retry budget", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
      availableActions: ["retry", "cancel"],
      activeErrorOccurrenceId: "1",
      errorOccurrences: [
        {
          id: "1",
          occurrenceNumber: 1,
          blockedFromStatus: "CODING",
          errorMessage: "Bead used its retry budget.",
          errorCodes: [BEAD_RETRY_BUDGET_EXHAUSTED],
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
      runtime: {
        ...makeTicket().runtime,
        maxIterationsPerBead: 5,
      },
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByRole("button", { name: "Try again 5 retries" }),
    ).toBeInTheDocument();
  });

  it("keeps the generic retry label for non-budget blocked errors", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
      availableActions: ["retry", "cancel"],
      activeErrorOccurrenceId: "2",
      errorOccurrences: [
        {
          id: "2",
          occurrenceNumber: 1,
          blockedFromStatus: "CODING",
          errorMessage: "Lint failed.",
          errorCodes: ["LINT_FAILED"],
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
      runtime: {
        ...makeTicket().runtime,
        maxIterationsPerBead: 5,
      },
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("offers an extra-note retry only for a live retryable implementation error", () => {
    const liveView = renderWithProviders(
      <ErrorView ticket={makeLiveErrorTicket()} />,
    );

    expect(
      screen.getByRole("button", { name: "Retry with extra note..." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    liveView.unmount();

    const baseTicket = makeLiveErrorTicket();
    const baseOccurrence = baseTicket.errorOccurrences?.[0];
    assert(baseOccurrence);
    const nonCodingTicket = makeTicket({
      ...baseTicket,
      previousStatus: "GENERATING_PRD",
      errorOccurrences: [
        {
          ...baseOccurrence,
          blockedFromStatus: "GENERATING_PRD",
        },
      ],
    });
    const nonCodingView = renderWithProviders(
      <ErrorView ticket={nonCodingTicket} />,
    );
    expect(
      screen.queryByRole("button", { name: "Retry with extra note..." }),
    ).not.toBeInTheDocument();
    nonCodingView.unmount();

    const historyView = renderWithProviders(
      <ErrorView ticket={makeLiveErrorTicket()} readOnly />,
    );
    expect(
      screen.queryByRole("button", { name: "Retry with extra note..." }),
    ).not.toBeInTheDocument();
    historyView.unmount();

    const noRetryTicket = makeLiveErrorTicket();
    noRetryTicket.availableActions = ["cancel"];
    renderWithProviders(<ErrorView ticket={noRetryTicket} />);
    expect(
      screen.queryByRole("button", { name: "Retry with extra note..." }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
  });

  it("does not invent recovery controls for setup approval errors", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "WAITING_EXECUTION_SETUP_APPROVAL",
      availableActions: ["cancel"],
      activeErrorOccurrenceId: "setup-approval-error",
      errorOccurrences: [
        {
          id: "setup-approval-error",
          occurrenceNumber: 1,
          blockedFromStatus: "WAITING_EXECUTION_SETUP_APPROVAL",
          errorMessage: "Setup approval could not continue.",
          errorCodes: ["EXECUTION_SETUP_FAILED"],
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.queryByRole("button", { name: "Retry" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit setup plan..." }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Retry with extra note..." }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/use an available recovery action/i),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Setup approval could not continue."),
    ).toBeVisible();
  });

  it.each([true, false])(
    "offers setup-plan editing only when advertised (%s)",
    (canEditPlan) => {
      const mutate = vi.fn();
      mockUseTicketAction.mockReturnValue({ mutate, isPending: false });
      const ticket = makeTicket({
        status: "BLOCKED_ERROR",
        previousStatus: "PREPARING_EXECUTION_ENV",
        availableActions: canEditPlan
          ? ["retry", "cancel", "edit_execution_setup_plan"]
          : ["retry", "cancel"],
        activeErrorOccurrenceId: "setup-error",
        errorOccurrences: [
          {
            id: "setup-error",
            occurrenceNumber: 1,
            blockedFromStatus: "PREPARING_EXECUTION_ENV",
            errorMessage: "Workspace probe failed.",
            errorCodes: ["EXECUTION_SETUP_FAILED"],
            occurredAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: null,
            resolutionStatus: null,
            resumedToStatus: null,
          },
        ],
      });

      renderWithProviders(<ErrorView ticket={ticket} />);

      const retryButton = screen.getByRole("button", { name: "Retry" });
      fireEvent.click(
        screen.getByRole("button", { name: "Retry with extra note..." }),
      );
      expect(
        screen.getByRole("dialog", {
          name: "Retry workspace setup with an extra note",
        }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      if (!canEditPlan) {
        expect(
          screen.queryByRole("button", { name: "Edit setup plan..." }),
        ).not.toBeInTheDocument();
        return;
      }
      const editSetupPlanButton = screen.getByRole("button", {
        name: "Edit setup plan...",
      });
      expect(
        retryButton.compareDocumentPosition(editSetupPlanButton) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(editSetupPlanButton);
      expect(
        screen.getByRole("dialog", { name: "Edit workspace setup plan?" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          /failed setup attempt will remain in the ticket history/i,
        ),
      ).toBeInTheDocument();
      expect(mutate).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Edit setup plan" }));
      expect(mutate).toHaveBeenCalledWith(
        { id: ticket.id, action: "edit_execution_setup_plan" },
        expect.objectContaining({
          onSuccess: expect.any(Function),
          onError: expect.any(Function),
        }),
      );
    },
  );

  it("removes terminal formatting from setup failure details", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "PREPARING_EXECUTION_ENV",
      activeErrorOccurrenceId: "setup-error",
      errorOccurrences: [
        {
          id: "setup-error",
          occurrenceNumber: 1,
          blockedFromStatus: "PREPARING_EXECUTION_ENV",
          errorMessage: "Execution setup failed",
          errorCodes: [
            "\u001b[31mFAIL\u001b[39m src/example.test.ts\nError: Cannot resolve package\n  at src/example.test.ts:2:1",
          ],
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    const detail = screen.getByText(
      (_, element) =>
        element?.classList.contains("whitespace-pre-wrap") === true &&
        element.textContent ===
          [
            "FAIL src/example.test.ts",
            "Error: Cannot resolve package",
            "  at src/example.test.ts:2:1",
          ].join("\n"),
    );
    expect(detail).toHaveClass("whitespace-pre-wrap");
    expect(detail.textContent).toContain("\nError: Cannot resolve package\n");
    expect(document.body.textContent).not.toContain("\u001b");
  });

  it("cleans terminal formatting and duplicate warnings from the displayed error", () => {
    const ticket = makeLiveErrorTicket();
    const occurrence = ticket.errorOccurrences?.[0];
    assert(occurrence);
    occurrence.errorMessage = [
      "\u001b[33mExperimental warning\u001b[39m",
      "\u001b[33mExperimental warning\u001b[39m",
      "\u001b[31m──────\u001b[39m",
      "\u001b[41m FAIL \u001b[49m src/example.test.ts",
    ].join("\r\n");

    renderWithProviders(<ErrorView ticket={ticket} />);

    const displayedError = screen.getByText(/Experimental warning/);
    expect(displayedError).toHaveTextContent(
      "Experimental warning FAIL src/example.test.ts",
    );
    expect(
      displayedError.textContent?.match(/Experimental warning/g),
    ).toHaveLength(1);
    expect(screen.queryByText(/───/)).not.toBeInTheDocument();
  });

  it("opens an accessible extra-note dialog and requires non-whitespace text", () => {
    renderWithProviders(<ErrorView ticket={makeLiveErrorTicket()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Retry with extra note..." }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Retry implementation with an extra note",
    });
    const note = within(dialog).getByRole("textbox", { name: /Extra note/ });
    const submit = within(dialog).getByRole("button", {
      name: "Add note and retry",
    });

    expect(note).toHaveAttribute("required");
    expect(note).toHaveAttribute("maxLength", "20000");
    expect(submit).toBeDisabled();

    fireEvent.change(note, { target: { value: "   \n  " } });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Enter an extra note before retrying.",
    );
    expect(submit).toBeDisabled();

    fireEvent.change(note, { target: { value: "A".repeat(20_001) } });
    expect(note).toHaveValue("A".repeat(20_000));
    expect(
      within(dialog).getByText("20,000 / 20,000 characters"),
    ).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  it("submits the exact extra note and clears it only after retry succeeds", () => {
    const mutate = vi.fn((_: unknown, options?: { onSuccess?: () => void }) => {
      options?.onSuccess?.();
    });
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false });
    const ticket = makeLiveErrorTicket();
    renderWithProviders(<ErrorView ticket={ticket} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Retry with extra note..." }),
    );
    const note = screen.getByRole("textbox", { name: /Extra note/ });
    const exactNote =
      "  Keep the existing parser.\nTry the smaller repair first.  ";
    fireEvent.change(note, { target: { value: exactNote } });
    fireEvent.click(screen.getByRole("button", { name: "Add note and retry" }));

    expect(mutate).toHaveBeenCalledWith(
      {
        id: ticket.id,
        action: "retry",
        payload: { kind: "retry_note", note: exactNote },
      },
      expect.objectContaining({
        onSuccess: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Retry with extra note..." }),
    );
    expect(screen.getByRole("textbox", { name: /Extra note/ })).toHaveValue("");
  });

  it("keeps the extra-note dialog and text when retry fails", () => {
    const mutate = vi.fn(
      (_: unknown, options?: { onError?: (error: Error) => void }) => {
        options?.onError?.(
          new Error("The implementation bead could not be reset"),
        );
      },
    );
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false });
    renderWithProviders(<ErrorView ticket={makeLiveErrorTicket()} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Retry with extra note..." }),
    );
    const note = screen.getByRole("textbox", { name: /Extra note/ });
    fireEvent.change(note, {
      target: { value: "Preserve this note after failure." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note and retry" }));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(note).toHaveValue("Preserve this note after failure.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The implementation bead could not be reset",
    );
  });

  it("disables the extra-note form while the retry request is pending", () => {
    const mutate = vi.fn();
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false });
    const ticket = makeLiveErrorTicket();
    renderWithProviders(<ErrorView ticket={ticket} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Retry with extra note..." }),
    );
    const note = screen.getByRole("textbox", { name: /Extra note/ });
    fireEvent.change(note, {
      target: { value: "Wait for this request." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add note and retry" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("textbox", { name: /Extra note/ }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Add note and retry" }),
    ).toBeDisabled();
  });

  it("shows the failed phase and real bead counters once", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
      availableActions: ["retry", "cancel"],
      activeErrorOccurrenceId: "bead-counts",
      errorOccurrences: [
        {
          id: "bead-counts",
          occurrenceNumber: 1,
          blockedFromStatus: "CODING",
          errorMessage: "Bead execution failed.",
          errorCodes: [],
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
      runtime: {
        ...makeTicket().runtime,
        currentBead: 2,
        totalBeads: 5,
      },
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(screen.getAllByText("Implementing (Bead 2/5)")).toHaveLength(1);
    expect(screen.getByText("Implementing (Bead 2/5)")).toBeVisible();
    expect(screen.queryByText(/Error 1:|Blocked from/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Bead \?\/\?/)).not.toBeInTheDocument();
  });

  it("shows Continue only when the live blocked ticket exposes the continue action", () => {
    const mutate = vi.fn();
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false });
    const ticket = makeLiveErrorTicket(
      {
        id: "continue-1",
        blockedFromStatus: "PREPARING_EXECUTION_ENV",
        errorMessage: "Usage limit reached.",
        diagnostics: usageLimitDiagnostics,
      },
      ["retry", "continue", "cancel"],
    );

    renderWithProviders(<ErrorView ticket={ticket} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      screen.getByText(/sends only "continue please"/i),
    ).toBeInTheDocument();
    expect(mutate).toHaveBeenCalledWith(
      { id: ticket.id, action: "continue" },
      expect.objectContaining({ onError: expect.any(Function) }),
    );
  });

  it.each([false, true])(
    "shows the current paused coding bead cue even with an older failure: %s",
    (hasOlderFailure) => {
      const ticket = makeTicket({
        status: "BLOCKED_ERROR",
        previousStatus: "CODING",
        availableActions: ["retry", "continue", "cancel"],
        activeErrorOccurrenceId: "coding-paused",
        errorOccurrences: [
          {
            id: "coding-paused",
            occurrenceNumber: 1,
            blockedFromStatus: "CODING",
            errorMessage: "OpenCode retry grace window expired.",
            errorCodes: ["OPENCODE_PROVIDER_ERROR"],
            diagnostics: {
              kind: "opencode_provider",
              source: "provider",
              summary: "usage limit reached",
              sessionId: "ses-coding",
              statusCode: 429,
              isRetryable: true,
            },
            occurredAt: "2026-01-01T00:00:00.000Z",
            resolvedAt: null,
            resolutionStatus: null,
            resumedToStatus: null,
          },
        ],
        runtime: {
          ...makeTicket().runtime,
          activeBeadId: "bead-9",
          activeBeadIteration: 6,
          lastFailedBeadId: hasOlderFailure ? "bead-old" : null,
          beads: [
            ...(hasOlderFailure
              ? [
                  {
                    id: "bead-old",
                    title: "Previously failed bead",
                    status: "error",
                    iteration: 2,
                    failedIterationNotes: [
                      {
                        timestamp: "2025-12-31T00:00:00.000Z",
                        iteration: 2,
                        content: "Earlier bead timed out.",
                      },
                    ],
                    userRetryNotes: [
                      {
                        timestamp: "2025-12-31T00:01:00.000Z",
                        iteration: 2,
                        content: "Earlier retry instructions.",
                      },
                    ],
                    finalizationFailureNotes: [
                      {
                        timestamp: "2025-12-31T00:02:00.000Z",
                        iteration: 2,
                        content: "Earlier commit failure.",
                      },
                    ],
                  },
                ]
              : []),
            {
              id: "bead-9",
              title: "Provider-limited bead",
              status: "in_progress",
              iteration: 6,
              startedAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:01:00.000Z",
            },
          ],
        },
      });

      renderWithProviders(<ErrorView ticket={ticket} />);

      expect(screen.getByText("Paused")).toBeInTheDocument();
      expect(screen.getByText("bead-9")).toBeInTheDocument();
      expect(
        screen.getByText(/Timer paused while the ticket is blocked/),
      ).toHaveTextContent(
        "Continue resumes the preserved OpenCode session with a fresh bead timer.",
      );
      expect(
        screen
          .getByText(/Timer paused while the ticket is blocked/)
          .compareDocumentPosition(screen.getByText("Technical details")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(screen.getAllByRole("button")[0]).toHaveTextContent("Continue");
      expect(
        screen.getByRole("button", { name: "Continue" }).querySelector("svg"),
      ).toHaveAttribute("aria-hidden", "true");
      expect(
        screen.getByRole("button", { name: "Retry with extra note..." }),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Failed bead/)).not.toBeInTheDocument();
      expect(screen.queryByText("bead-old")).not.toBeInTheDocument();
      expect(
        screen.queryByText("Earlier bead timed out."),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Earlier retry instructions."),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Earlier commit failure."),
      ).not.toBeInTheDocument();
    },
  );

  it("shows action errors inline when Continue is rejected", async () => {
    const mutate = vi.fn(
      (_: unknown, options?: { onError?: (error: Error) => void }) => {
        options?.onError?.(
          new Error(
            "Continue is not available because the preserved OpenCode session is no longer active",
          ),
        );
      },
    );
    mockUseTicketAction.mockReturnValue({ mutate, isPending: false });
    const ticket = makeLiveErrorTicket(
      {
        id: "continue-rejected",
        blockedFromStatus: "PREPARING_EXECUTION_ENV",
        errorMessage: "Usage limit reached.",
        diagnostics: usageLimitDiagnostics,
      },
      ["retry", "continue", "cancel"],
    );

    renderWithProviders(<ErrorView ticket={ticket} />);
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Continue is not available because the preserved OpenCode session is no longer active",
    );
  });

  it("hides Continue when the live blocked ticket does not expose the continue action", () => {
    const ticket = makeLiveErrorTicket({
      id: "retry-only",
      blockedFromStatus: "PREPARING_EXECUTION_ENV",
      errorMessage: "Invalid request.",
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.queryByRole("button", { name: "Continue" }),
    ).not.toBeInTheDocument();
  });

  it("renders structured blocked-error diagnostics when present", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "SCANNING_RELEVANT_FILES",
      activeErrorOccurrenceId: "diag-1",
      errorOccurrences: [
        {
          id: "diag-1",
          occurrenceNumber: 1,
          blockedFromStatus: "SCANNING_RELEVANT_FILES",
          errorMessage:
            "Relevant files scan failed validation after 1 structured retry attempt(s).",
          errorCodes: [
            "RELEVANT_FILES_SCAN_FAILED",
            "OPENCODE_PROVIDER_AUTH_FAILED",
          ],
          diagnostics: {
            kind: "opencode_provider",
            source: "provider",
            summary:
              "invalid_request_error: Your authentication token has been invalidated. Please try signing in again. (HTTP 401)",
            modelId: "openai/gpt-5.3-codex",
            sessionId: "ses-auth",
            providerId: "openai",
            providerModelId: "gpt-5.3-codex",
            statusCode: 401,
            providerErrorType: "invalid_request_error",
            providerErrorMessage:
              "Your authentication token has been invalidated. Please try signing in again.",
            isRetryable: false,
          },
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    const primaryError = screen.getByText(
      "Relevant files scan failed validation after 1 structured retry attempt(s).",
    );
    const providerCause = screen.getByText(
      /invalid_request_error: Your authentication token has been invalidated/,
    );
    expect(primaryError).toBeVisible();
    expect(providerCause).toBeVisible();
    expect(providerCause.closest("details")).toBeNull();
    expect(
      primaryError.compareDocumentPosition(providerCause) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText("Technical details").closest("details"),
    ).not.toHaveAttribute("open");
    expect(screen.getByText("HTTP:")).not.toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("HTTP:")).toBeVisible();
    expect(screen.getByText("401")).toBeVisible();
    expect(screen.getByText("Provider:")).toBeVisible();
    expect(screen.getByText("openai")).toBeVisible();
    expect(screen.getByText("Provider model:")).toBeVisible();
    expect(screen.getByText("Provider type:")).toBeVisible();
    expect(screen.getByText("invalid_request_error")).toBeVisible();
    expect(screen.getByText("Retryable:")).toBeVisible();
    expect(screen.getByText("no")).toBeVisible();
    expect(screen.queryByText("Provider message:")).not.toBeInTheDocument();
    expect(
      screen.getAllByText(/Your authentication token has been invalidated/),
    ).toHaveLength(1);
  });

  it("keeps additional provider context visible when its summary contains the primary error", () => {
    const ticket = makeLiveErrorTicket();
    const occurrence = ticket.errorOccurrences?.[0];
    assert(occurrence);
    occurrence.errorMessage = "Request failed";
    occurrence.diagnostics = {
      kind: "opencode_provider",
      source: "provider",
      summary: "Request failed: 429 Too Many Requests",
    };

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(screen.getByText("Request failed")).toBeVisible();
    expect(screen.getByText("Cause:")).toBeVisible();
    expect(
      screen.getByText(/Request failed: 429 Too Many Requests/),
    ).toBeVisible();
    expect(
      screen
        .getByText(/Request failed: 429 Too Many Requests/)
        .closest("details"),
    ).toBeNull();
  });

  it("uses the diagnostic cause as the main error when no message was captured", () => {
    const ticket = makeLiveErrorTicket();
    const occurrence = ticket.errorOccurrences?.[0];
    assert(occurrence);
    occurrence.errorMessage = "";
    occurrence.diagnostics = {
      kind: "transport",
      source: "opencode",
      summary: "The OpenCode connection closed before the scan finished.",
    };

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getAllByText(
        "The OpenCode connection closed before the scan finished.",
      ),
    ).toHaveLength(1);
    expect(
      screen.getByText(
        "The OpenCode connection closed before the scan finished.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(/No error details were captured/),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Cause:")).not.toBeInTheDocument();
  });

  it("retains a provider message row when it adds details absent from the main error and summary", () => {
    const ticket = makeLiveErrorTicket();
    const occurrence = ticket.errorOccurrences?.[0];
    assert(occurrence);
    occurrence.errorMessage = "Request failed.";
    occurrence.diagnostics = {
      kind: "opencode_provider",
      source: "provider",
      summary: "HTTP 401",
      providerErrorMessage:
        "Sign in again to refresh the authentication token.",
    };

    renderWithProviders(<ErrorView ticket={ticket} />);

    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Provider message:")).toBeVisible();
    expect(
      screen.getByText("Sign in again to refresh the authentication token."),
    ).toBeVisible();
  });

  it.each([false, true])(
    "keeps model, session, and provider data collapsed until requested (historical: %s)",
    (historical) => {
      const ticket = makeLiveErrorTicket({
        diagnostics: {
          kind: "opencode_provider",
          source: "provider",
          summary: "Provider rejected the request.",
          modelId: "example/model",
          sessionId: "ses-failed-request",
          cacheReadTokens: 1234,
          cacheWriteTokens: 0,
          responseBodyPreview: '{"error":"rate_limit"}',
        },
      });
      const occurrence = ticket.errorOccurrences?.[0];
      assert(occurrence);
      if (historical) occurrence.resolvedAt = "2026-01-01T00:01:00.000Z";

      renderWithProviders(
        <ErrorView ticket={ticket} occurrence={occurrence} readOnly={historical} />,
      );

      const details = screen.getByText("Technical details").closest("details");
      assert(details);
      expect(details).not.toHaveAttribute("open");
      expect(screen.getByText("Implementation failed.")).toBeVisible();
      expect(screen.getByText("example/model")).not.toBeVisible();
      expect(screen.getByText("ses-failed-request")).not.toBeVisible();
      expect(screen.getByText('{"error":"rate_limit"}')).not.toBeVisible();

      fireEvent.click(screen.getByText("Technical details"));

      expect(details).toHaveAttribute("open");
      expect(within(details).getByText("example/model")).toBeVisible();
      expect(within(details).getByText("ses-failed-request")).toBeVisible();
      expect(within(details).getByText("Cache read tokens:")).toBeVisible();
      expect(within(details).getByText("1,234")).toBeVisible();
      expect(within(details).getByText("Cache write tokens:")).toBeVisible();
      expect(within(details).getByText("0")).toBeVisible();
      expect(within(details).getByText('{"error":"rate_limit"}')).toBeVisible();
    },
  );

  it.each([false, true])(
    "keeps open technical details and focus across same-failure polling updates (stored occurrence: %s)",
    (storedOccurrence) => {
      const ticket = storedOccurrence
        ? makeLiveErrorTicket()
        : makeTicket({
            status: "BLOCKED_ERROR",
            previousStatus: "CODING",
            errorMessage: "Implementation failed.",
          });
      ticket.updatedAt = "2026-01-01T00:00:00.000Z";
      const { rerender } = renderWithProviders(<ErrorView ticket={ticket} />);
      const summary = screen.getByText("Technical details");
      const details = summary.closest("details");
      assert(details);
      fireEvent.click(summary);
      summary.focus();

      rerender(
        <ErrorView
          ticket={{
            ...ticket,
            updatedAt: "2026-01-01T00:00:05.000Z",
            errorOccurrences: ticket.errorOccurrences?.map((value) => ({
              ...value,
            })),
          }}
        />,
      );

      expect(screen.getByText("Technical details").closest("details")).toBe(
        details,
      );
      expect(details).toHaveAttribute("open");
      expect(summary).toHaveFocus();
    },
  );

  it("closes technical details when switching failures or tickets without mixing their diagnostics", () => {
    const ticket = makeLiveErrorTicket({
      diagnostics: {
        kind: "runtime",
        source: "opencode",
        summary: "Invalid model response.",
        modelId: "example/current-model",
        sessionId: "ses-current",
      },
    });
    const activeOccurrence = ticket.errorOccurrences?.[0];
    assert(activeOccurrence);
    const historicalOccurrence = {
      ...activeOccurrence,
      id: "historical-error",
      diagnostics: null,
      resolvedAt: "2025-12-31T23:59:00.000Z",
    };
    ticket.errorOccurrences = [historicalOccurrence, activeOccurrence];
    const { rerender } = renderWithProviders(<ErrorView ticket={ticket} />);
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("ses-current")).toBeVisible();

    rerender(
      <ErrorView ticket={ticket} occurrence={historicalOccurrence} readOnly />,
    );

    expect(
      screen.getByText("Technical details").closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.queryByText("ses-current")).not.toBeInTheDocument();
    expect(screen.queryByText("example/current-model")).not.toBeInTheDocument();

    rerender(<ErrorView ticket={ticket} />);
    expect(
      screen.getByText("Technical details").closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("ses-current")).toBeVisible();

    rerender(<ErrorView ticket={{ ...ticket, id: "different-ticket" }} />);
    expect(
      screen.getByText("Technical details").closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("redacts and bounds provider previews and cleans terminal formatting in historical diagnostics", () => {
    const ticket = makeLiveErrorTicket();
    const occurrence = ticket.errorOccurrences?.[0];
    assert(occurrence);
    occurrence.diagnostics = {
      kind: "opencode_provider",
      source: "provider",
      summary: "Request failed.",
      modelId: "\u001b[31mexample/model\u001b[39m\u0000",
      sessionId: "\u001b[31mses-provider\u001b[39m\u0000",
      responseBodyPreview:
        '\u001b[31m{"api_key":"sk-privatevalue123","message":"Quota exceeded","detail":"' +
        "x".repeat(1200) +
        '"}\u001b[39m\u0000',
    };

    renderWithProviders(
      <ErrorView ticket={ticket} occurrence={occurrence} readOnly />,
    );
    fireEvent.click(screen.getByText("Technical details"));

    expect(screen.getByText("example/model")).toBeVisible();
    expect(screen.getByText("ses-provider")).toBeVisible();
    const preview = screen.getByText(/Quota exceeded/);
    expect(preview.tagName).toBe("PRE");
    expect(preview.textContent).toContain('[redacted]');
    expect(preview.textContent?.length).toBeLessThanOrEqual(1000);
    expect(document.body.textContent).not.toContain("sk-privatevalue123");
    expect(document.body.textContent).not.toContain("\u001b");
    expect(document.body.textContent).not.toContain("\u0000");
  });

  it("preserves provider JSON structure in a labelled keyboard-focusable preview", () => {
    const responseBodyPreview = [
      "{",
      '  "errors": [',
      "    {",
      '      "message": "rate_limit"',
      "    },",
      "    {",
      '      "message": "rate_limit"',
      "    }",
      "  ]",
      "}",
    ].join("\n");
    const ticket = makeLiveErrorTicket({
      diagnostics: {
        kind: "opencode_provider",
        source: "provider",
        summary: "Provider rejected the request.",
        responseBodyPreview,
      },
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByRole("region", { name: "Provider response preview" }),
    ).not.toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    const preview = screen.getByRole("region", {
      name: "Provider response preview",
    });
    expect(preview).toBeVisible();
    expect(preview.textContent).toBe(responseBodyPreview);
    expect(preview).toHaveAttribute("tabindex", "0");
    preview.focus();
    expect(preview).toHaveFocus();
  });

  it("renders model output truncation diagnostics with finish reason and token counts", () => {
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "VERIFYING_PRD_COVERAGE",
      activeErrorOccurrenceId: "diag-length",
      errorOccurrences: [
        {
          id: "diag-length",
          occurrenceNumber: 1,
          blockedFromStatus: "VERIFYING_PRD_COVERAGE",
          errorMessage:
            "PRD coverage resolution output failed validation after 1 structured retry attempt(s): PRD is missing epics",
          errorCodes: ["COVERAGE_FAILED", "OPENCODE_OUTPUT_TRUNCATED"],
          diagnostics: {
            kind: "model_output_truncated",
            source: "opencode",
            summary:
              'The model stopped because OpenCode reported finish reason "length", which usually means the response reached the model or provider output length limit.',
            modelId: "opencode-go/deepseek-v4-flash",
            sessionId: "ses-length",
            finishReason: "length",
            outputTokens: 2923,
            reasoningTokens: 29077,
            inputTokens: 13252,
          },
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(
      screen.getByText(
        /The model stopped because OpenCode reported finish reason/,
      ),
    ).toBeVisible();
    expect(screen.getByText("Model Output Truncated")).not.toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Model Output Truncated")).toBeVisible();
    expect(screen.getByText("Finish reason:")).toBeVisible();
    expect(screen.getByText("length")).toBeVisible();
    expect(screen.getByText("Output tokens:")).toBeVisible();
    expect(screen.getByText("2,923")).toBeVisible();
    expect(screen.getByText("Reasoning tokens:")).toBeVisible();
    expect(screen.getByText("29,077")).toBeVisible();
  });

  it("does not repeat the diagnostic summary when it already appears in the primary error", () => {
    const duplicateMessage =
      "Coverage output failed validation after 1 structured retry attempt(s): No coverage result content found";
    const ticket = makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "VERIFYING_PRD_COVERAGE",
      activeErrorOccurrenceId: "diag-duplicate",
      errorOccurrences: [
        {
          id: "diag-duplicate",
          occurrenceNumber: 1,
          blockedFromStatus: "VERIFYING_PRD_COVERAGE",
          errorMessage: duplicateMessage,
          errorCodes: ["COVERAGE_FAILED"],
          diagnostics: {
            kind: "runtime",
            source: "opencode",
            summary: duplicateMessage,
          },
          occurredAt: "2026-01-01T00:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });

    renderWithProviders(<ErrorView ticket={ticket} />);

    expect(screen.getAllByText(duplicateMessage)).toHaveLength(1);
    expect(screen.getByText(duplicateMessage)).toBeVisible();
    expect(screen.getByText("Kind:")).not.toBeVisible();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("Kind:")).toBeVisible();
    expect(screen.getByText("Runtime")).toBeVisible();
  });

  it("omits milliseconds from occurrence timestamps", () => {
    const occurrence = {
      id: "3",
      occurrenceNumber: 1,
      blockedFromStatus: "CODING",
      errorMessage: "Workspace setup timed out.",
      errorCodes: [],
      occurredAt: "2026-01-01T00:00:00.123Z",
      resolvedAt: "2026-01-01T00:01:00.456Z",
      resolutionStatus: "RETRIED" as const,
      resumedToStatus: "WAITING_EXECUTION_SETUP_APPROVAL",
    };
    const ticket = makeTicket({
      status: "CANCELED",
      previousStatus: "BLOCKED_ERROR",
      errorOccurrences: [occurrence],
      activeErrorOccurrenceId: null,
    });

    renderWithProviders(
      <ErrorView ticket={ticket} occurrence={occurrence} readOnly />,
    );

    const context = screen.getByText("Error 1").parentElement;
    assert(context);
    const occurredAt = context.querySelector("[title]");
    assert(occurredAt);
    expect(occurredAt).toHaveAttribute("title");
    expect(occurredAt.getAttribute("title")).not.toContain(".123");

    const resolvedLabel = screen.getByText(/Resolved /);
    expect(resolvedLabel).not.toHaveTextContent(".456");
  });
});

describe("ErrorView log window for a historical occurrence", () => {
  function logEntry(line: string, timestamp: string | null): LogEntry {
    return {
      id: `${timestamp ?? "undated"}:${line}`,
      entryId: `${timestamp ?? "undated"}:${line}`,
      line,
      source: "system",
      status: "CODING",
      timestamp,
      audience: "all",
      kind: "milestone",
      streaming: false,
      op: "append",
    } as unknown as LogEntry;
  }

  function renderWithLogs(
    ui: ReactElement,
    logsByPhase: Record<string, LogEntry[]>,
  ) {
    const value = {
      logsByPhase,
      activePhase: null,
      isLoadingLogs: false,
      addLog: vi.fn(),
      addLogRecord: vi.fn(),
      getLogsForPhase: (phase: string) => logsByPhase[phase] ?? [],
      getAllLogs: () => Object.values(logsByPhase).flat(),
      setActivePhase: vi.fn(),
      clearLogs: vi.fn(),
    } as unknown as LogContextValue;
    return renderWithProviders(withLogContext(value, ui));
  }

  function twoOccurrenceTicket() {
    return makeTicket({
      status: "BLOCKED_ERROR",
      previousStatus: "CODING",
      availableActions: ["retry", "cancel"],
      activeErrorOccurrenceId: "second",
      errorOccurrences: [
        {
          id: "first",
          occurrenceNumber: 1,
          blockedFromStatus: "CODING",
          errorMessage: "First failure.",
          errorCodes: [],
          occurredAt: "2026-01-01T10:00:00.000Z",
          resolvedAt: "2026-01-01T10:30:00.000Z",
          resolutionStatus: "RETRIED",
          resumedToStatus: "CODING",
        },
        {
          id: "second",
          occurrenceNumber: 2,
          blockedFromStatus: "CODING",
          errorMessage: "Second failure.",
          errorCodes: [],
          occurredAt: "2026-01-01T12:00:00.000Z",
          resolvedAt: null,
          resolutionStatus: null,
          resumedToStatus: null,
        },
      ],
    });
  }

  it("shows the older error's own phase logs", () => {
    // The occurrence list is newest-first, so reading "previous" as `index - 1`
    // took the *newer* one — making the window start later than it ended, and
    // nothing could fall inside it. Undated rows used to leak through and mask
    // that; excluding them turned it into an empty log panel.
    const ticket = twoOccurrenceTicket();
    const occurrence = ticket.errorOccurrences?.[0];
    assert(occurrence);
    renderWithLogs(<ErrorView ticket={ticket} occurrence={occurrence} />, {
      CODING: [
        logEntry("work before the first failure", "2026-01-01T09:30:00.000Z"),
      ],
    });

    const calls = logSectionMock.mock.calls as unknown as Array<
      [{ logs?: LogEntry[] }]
    >;
    const logs = calls.at(-1)?.[0];
    expect(logs?.logs?.map((entry) => entry.line)).toEqual([
      "work before the first failure",
    ]);
  });

  it("keeps undated lines out of a bounded window", () => {
    const ticket = twoOccurrenceTicket();
    const occurrence = ticket.errorOccurrences?.[1];
    assert(occurrence);
    renderWithLogs(<ErrorView ticket={ticket} occurrence={occurrence} />, {
      CODING: [
        logEntry("between the two failures", "2026-01-01T11:00:00.000Z"),
        logEntry("from some other attempt", null),
      ],
    });

    const calls = logSectionMock.mock.calls as unknown as Array<
      [{ logs?: LogEntry[] }]
    >;
    const logs = calls.at(-1)?.[0];
    expect(logs?.logs?.map((entry) => entry.line)).toEqual([
      "between the two failures",
    ]);
  });
});
