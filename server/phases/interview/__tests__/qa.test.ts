import { describe, expect, it } from "vitest";
import { MockOpenCodeAdapter } from "../../../opencode/adapter";
import { SILENT_READ_ONLY_PERMISSIONS } from "../../../opencode/toolPolicy";
import { startInterviewSession, submitBatchToSession } from "../qa";
import {
  buildPersistedBatch,
  createInterviewSessionSnapshot,
  recordBatchAnswers,
  recordPreparedBatch,
} from "../sessionState";
import { TEST } from "../../../test/factories";

class SequencedMockOpenCodeAdapter extends MockOpenCodeAdapter {
  private promptCounts = new Map<string, number>();

  override async promptSession(
    ...args: Parameters<MockOpenCodeAdapter["promptSession"]>
  ) {
    const sessionId = args[0];
    const nextCount = (this.promptCounts.get(sessionId) ?? 0) + 1;
    this.promptCounts.set(sessionId, nextCount);

    const queuedResponse = this.mockResponses.get(`${sessionId}#${nextCount}`);
    if (queuedResponse !== undefined) {
      this.mockResponses.set(sessionId, queuedResponse);
    }

    return await super.promptSession(...args);
  }
}

describe.concurrent("PROM4 interview session parsing", () => {
  it("frames compiled questions as the working checklist in the initial PROM4 prompt", async () => {
    const adapter = new SequencedMockOpenCodeAdapter();
    const streamedEvents: unknown[] = [];
    const dispatchedPrompts: unknown[] = [];
    adapter.mockResponses.set(
      "mock-session-1",
      [
        "<INTERVIEW_BATCH>",
        "batch_number: 1",
        "progress:",
        "  current: 1",
        "  total: 4",
        "is_final_free_form: false",
        "ai_commentary: Start with the compiled foundation checklist.",
        "questions:",
        "  - id: Q01",
        "    question: What problem are we solving?",
        "    phase: Foundation",
        "    priority: critical",
        "    rationale: Establish the core goal.",
        "    answer_type: free_text",
        "</INTERVIEW_BATCH>",
      ].join("\n"),
    );

    await startInterviewSession(
      adapter,
      "/tmp/test",
      "model-a",
      [
        "questions:",
        "  - id: Q01",
        "    phase: foundation",
        "    question: What problem are we solving?",
      ].join("\n"),
      {
        ticketId: TEST.externalId,
        title: "Checklist framing",
        description: "Ensure the compiled interview set stays foregrounded.",
        relevantFiles: "",
      },
      5,
      20,
      undefined,
      (entry) => streamedEvents.push(entry),
      (entry) => dispatchedPrompts.push(entry),
    );

    const messages = adapter.messages.get("mock-session-1") ?? [];
    const firstPrompt =
      messages.find((message) => message.role === "user")?.content ?? "";

    expect(firstPrompt).toContain("## Compiled Questions (from council)");
    expect(firstPrompt).toContain(
      "Treat the compiled questions above as your working interview checklist",
    );
    expect(
      firstPrompt.match(/## Compiled Questions \(from council\)/g) ?? [],
    ).toHaveLength(1);
    expect(firstPrompt).not.toContain("### interview");
    expect(streamedEvents).toContainEqual(
      expect.objectContaining({
        sessionId: "mock-session-1",
        event: expect.objectContaining({ type: "text" }),
      }),
    );
    expect(dispatchedPrompts).toContainEqual(
      expect.objectContaining({ sessionId: "mock-session-1" }),
    );
  });

  it("retries invalid structured output in the same session and returns the corrected batch", async () => {
    const adapter = new SequencedMockOpenCodeAdapter();
    adapter.mockResponses.set(
      "mock-session-1#1",
      "I will ask three useful questions next.",
    );
    adapter.mockResponses.set(
      "mock-session-1#2",
      [
        "<INTERVIEW_BATCH>",
        "batch_number: 1",
        "progress:",
        "  current: 2",
        "  total: 5",
        "is_final_free_form: false",
        "ai_commentary: Asking the foundation questions first.",
        "questions:",
        "  - id: Q01",
        "    question: What problem are we solving?",
        "    phase: Foundation",
        "    priority: critical",
        "    rationale: Establish the core goal.",
        "    answer_type: single_choice",
        "    options:",
        "      - id: reliability",
        "        label: Reliability",
        "      - id: speed",
        "        label: Speed",
        "</INTERVIEW_BATCH>",
      ].join("\n"),
    );

    const result = await startInterviewSession(
      adapter,
      "/tmp/test",
      "model-a",
      [
        "questions:",
        "  - id: Q01",
        "    phase: foundation",
        "    question: What problem are we solving?",
      ].join("\n"),
      {
        ticketId: TEST.externalId,
        title: "Retry PROM4 parsing",
        description:
          "Ensure malformed batch output is corrected before blocking.",
        relevantFiles: "",
      },
      5,
      20,
    );

    expect(result.sessionId).toBe("mock-session-1");
    expect(result.firstBatch).toMatchObject({
      batchNumber: 1,
      isComplete: false,
      progress: { current: 2, total: 5 },
      questions: [
        {
          id: "Q01",
          question: "What problem are we solving?",
          phase: "Foundation",
          priority: "critical",
          answerType: "single_choice",
          options: [
            { id: "reliability", label: "Reliability" },
            { id: "speed", label: "Speed" },
          ],
        },
      ],
      structuredOutput: {
        autoRetryCount: 1,
        validationError: expect.any(String),
      },
    });

    const messages = adapter.messages.get("mock-session-1") ?? [];
    expect(
      messages.some(
        (message) =>
          typeof message.content === "string" &&
          message.content.includes("Structured Output Retry"),
      ),
    ).toBe(true);
    expect(adapter.promptCalls[0]?.options?.permission).toEqual(
      SILENT_READ_ONLY_PERMISSIONS,
    );
    expect(adapter.promptCalls[1]?.options?.permission).toEqual(
      SILENT_READ_ONLY_PERMISSIONS,
    );
  });

  it("returns accepted field-tag repair details without another model request", async () => {
    const adapter = new MockOpenCodeAdapter();
    adapter.mockResponses.set(
      "existing-session",
      [
        "<INTERVIEW_BATCH>",
        "<batch_number>1</batch_number>",
        "<progress>",
        "  <current>1</current>",
        "  <total>9</total>",
        "</progress>",
        "<is_final_free_form>false</is_final_free_form>",
        "<ai_commentary>",
        "Start with the intended outcome.",
        "</ai_commentary>",
        "<questions>",
        "  - id: Q01",
        "    question: What outcome matters most?",
        "    phase: Foundation",
        "    priority: high",
        "    rationale: Establish the intended outcome.",
        "    answer_type: free_text",
        "</parameter>",
        "</INTERVIEW_BATCH>",
      ].join("\n"),
    );

    const result = await submitBatchToSession(
      adapter,
      "existing-session",
      {},
      undefined,
      "provider/model-a",
    );

    expect(adapter.promptCalls).toHaveLength(1);
    expect(result.structuredOutput).toMatchObject({
      repairApplied: true,
      autoRetryCount: 0,
      repairWarnings: expect.arrayContaining([
        expect.stringContaining("batch_number"),
      ]),
      interventions: expect.arrayContaining([
        expect.objectContaining({ code: "parser_interview_batch_field_tags" }),
      ]),
    });
    expect(result.questions[0]?.question).toBe("What outcome matters most?");
  });

  it("returns a complete PROM4 artifact as a completed batch", async () => {
    const adapter = new MockOpenCodeAdapter();
    adapter.mockResponses.set(
      "existing-session",
      [
        "<INTERVIEW_COMPLETE>",
        "```yaml",
        "interview:",
        "  schema_version: 1",
        "  artifact: interview",
        "  questions:",
        "    - id: Q01",
        "      prompt: What problem are we solving?",
        "  approval:",
        '    approved_by: ""',
        '    approved_at: ""',
        "```",
        "</INTERVIEW_COMPLETE>",
      ].join("\n"),
    );

    const result = await submitBatchToSession(adapter, "existing-session", {
      Q01: "Reliable output",
    });

    expect(result).toMatchObject({
      questions: [],
      progress: { current: 0, total: 0 },
      isComplete: true,
      isFinalFreeForm: false,
      aiCommentary: "Interview complete.",
      batchNumber: -1,
    });
    expect(result.finalYaml).toContain("schema_version: 1");
    expect(result.finalYaml).toContain("artifact: interview");
  });

  it("resumes from skipped, current, and pending interview questions", async () => {
    const adapter = new MockOpenCodeAdapter();
    const nextBatchResponse = [
      "<INTERVIEW_BATCH>",
      "batch_number: 3",
      "progress:",
      "  current: 2",
      "  total: 3",
      "is_final_free_form: false",
      "ai_commentary: Continue with the remaining implementation question.",
      "questions:",
      "  - id: Q03",
      "    question: How should success be measured?",
      "    phase: Assembly",
      "    priority: high",
      "    rationale: Define an observable outcome.",
      "</INTERVIEW_BATCH>",
    ].join("\n");
    adapter.mockResponses.set("mock-session-1", nextBatchResponse);

    const baseSnapshot = createInterviewSessionSnapshot({
      winnerId: "model-a",
      compiledQuestions: [
        {
          id: "Q01",
          phase: "Foundation",
          question: "What outcome matters most?",
        },
        {
          id: "Q02",
          phase: "Structure",
          question: "Which users need support first?",
        },
        {
          id: "Q03",
          phase: "Assembly",
          question: "How should success be measured?",
        },
      ],
      maxInitialQuestions: 3,
      followUpBudgetPercent: 20,
    });
    const firstBatch = buildPersistedBatch(
      {
        questions: [
          {
            id: "Q01",
            question: "What outcome matters most?",
            phase: "Foundation",
          },
        ],
        progress: { current: 1, total: 3 },
        isComplete: false,
        isFinalFreeForm: false,
        aiCommentary: "Start with the core outcome.",
        batchNumber: 1,
      },
      "prom4",
      baseSnapshot,
    );
    const afterSkip = recordBatchAnswers(
      recordPreparedBatch(baseSnapshot, firstBatch),
      { Q01: "" },
    );
    const currentBatch = buildPersistedBatch(
      {
        questions: [
          {
            id: "Q02",
            question: "Which users need support first?",
            phase: "Structure",
          },
        ],
        progress: { current: 2, total: 3 },
        isComplete: false,
        isFinalFreeForm: false,
        aiCommentary: "Continue with user scope.",
        batchNumber: 2,
      },
      "prom4",
      afterSkip,
    );
    const resumeSnapshot = recordPreparedBatch(afterSkip, currentBatch);

    await startInterviewSession(
      adapter,
      "/tmp/test",
      "model-a",
      "",
      {
        ticketId: TEST.externalId,
        title: "Resume mixed question states",
        description:
          "Keep skipped and unanswered questions visible after a restart.",
        relevantFiles: "",
      },
      3,
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      resumeSnapshot,
    );

    const resumePrompt =
      adapter.messages
        .get("mock-session-1")
        ?.find((message) => message.role === "user")?.content ?? "";
    expect(resumePrompt).toContain(
      "Answered or skipped questions:\n- Q01 (skipped) [Foundation]: [SKIPPED]",
    );
    expect(resumePrompt).toContain(
      "Pending questions:\n- Q02 (pending) [Structure]: Which users need support first?",
    );
    expect(resumePrompt).toContain(
      "- Q03 (pending) [Assembly]: How should success be measured?",
    );

    adapter.mockResponses.set("mock-session-2", nextBatchResponse);
    await startInterviewSession(
      adapter,
      "/tmp/test",
      "model-a",
      "",
      {
        ticketId: TEST.externalId,
        title: "Resume interview with no submitted answers",
        description: "Keep the unanswered checklist visible after a restart.",
        relevantFiles: "",
      },
      3,
      20,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      baseSnapshot,
    );
    const emptyHistoryPrompt =
      adapter.messages
        .get("mock-session-2")
        ?.find((message) => message.role === "user")?.content ?? "";
    expect(emptyHistoryPrompt).toContain(
      "Answered or skipped questions:\n[none]",
    );
  });

  it("fails an empty response when no restart snapshot is available", async () => {
    const adapter = new MockOpenCodeAdapter();
    adapter.mockResponses.set("existing-session", "");

    await expect(
      submitBatchToSession(adapter, "existing-session", { Q01: "  " }),
    ).rejects.toThrow(
      "PROM4 output failed validation without a recoverable session",
    );
    expect(adapter.promptCalls).toHaveLength(1);
    expect(
      adapter.messages
        .get("existing-session")
        ?.find((message) => message.role === "user")?.content,
    ).toContain("Q01: [SKIPPED]");
  });

  it("aborts the active session when submitting answers fails", async () => {
    class FailingPromptAdapter extends MockOpenCodeAdapter {
      readonly abortedSessions: string[] = [];

      override async promptSession(
        ..._args: Parameters<MockOpenCodeAdapter["promptSession"]>
      ): Promise<string> {
        throw new Error("Follow-up prompt failed");
      }

      override async abortSession(sessionId: string): Promise<boolean> {
        this.abortedSessions.push(sessionId);
        return true;
      }
    }

    const adapter = new FailingPromptAdapter();

    await expect(
      submitBatchToSession(adapter, "existing-session", {
        Q01: "Reliable output",
      }),
    ).rejects.toThrow("Follow-up prompt failed");
    expect(adapter.abortedSessions).toEqual(["existing-session"]);
  });

  it("surfaces transport errors while retrying structured interview output", async () => {
    class FailingRetryAdapter extends SequencedMockOpenCodeAdapter {
      override async promptSession(
        ...args: Parameters<MockOpenCodeAdapter["promptSession"]>
      ): Promise<string> {
        if (this.promptCalls.length > 0)
          throw new Error("Structured retry prompt failed");
        return await super.promptSession(...args);
      }
    }

    const adapter = new FailingRetryAdapter();
    adapter.mockResponses.set(
      "existing-session",
      "I will ask some useful questions.",
    );

    await expect(
      submitBatchToSession(adapter, "existing-session", {
        Q01: "Reliable output",
      }),
    ).rejects.toThrow("Structured retry prompt failed");
    expect(adapter.promptCalls).toHaveLength(1);
  });

  it("reports structured validation exhaustion after the configured retries", async () => {
    const adapter = new SequencedMockOpenCodeAdapter();
    adapter.mockResponses.set(
      "existing-session#1",
      "I will ask some questions now.",
    );
    adapter.mockResponses.set(
      "existing-session#2",
      "Here are some unstructured questions.",
    );

    await expect(
      submitBatchToSession(
        adapter,
        "existing-session",
        { Q01: "Reliable output" },
        undefined,
        "provider/model-a",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        1,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "PROM4 output failed validation after 1 structured retry attempt(s)",
      ),
      blockedErrorDiagnostics: {
        modelId: "provider/model-a",
        sessionId: "existing-session",
      },
    });
    expect(adapter.promptCalls).toHaveLength(2);
  });

  it("keeps a session error visible when abort cannot be confirmed", async () => {
    class UnconfirmedAbortAdapter extends MockOpenCodeAdapter {
      override async abortSession(_sessionId: string): Promise<boolean> {
        return false;
      }
    }

    const adapter = new UnconfirmedAbortAdapter();
    adapter.mockResponses.set(
      "mock-session-1",
      "This is not a structured interview response.",
    );

    await expect(
      startInterviewSession(
        adapter,
        "/tmp/test",
        "model-a",
        "questions: []",
        {
          ticketId: TEST.externalId,
          title: "Unconfirmed session cleanup",
          description:
            "Do not hide validation failure if the session remains active.",
          relevantFiles: "",
        },
        3,
        20,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        0,
      ),
    ).rejects.toThrow(
      "Could not confirm abort of OpenCode session mock-session-1",
    );
  });

  it("stops an initial session when prompt dispatch fails", async () => {
    class FailingPromptAdapter extends MockOpenCodeAdapter {
      readonly abortedSessions: string[] = [];

      override async promptSession(
        ..._args: Parameters<MockOpenCodeAdapter["promptSession"]>
      ): Promise<string> {
        throw new Error("Initial interview prompt failed");
      }

      override async abortSession(sessionId: string): Promise<boolean> {
        this.abortedSessions.push(sessionId);
        return true;
      }
    }

    const adapter = new FailingPromptAdapter();

    await expect(
      startInterviewSession(
        adapter,
        "/tmp/test",
        "model-a",
        "questions: []",
        {
          ticketId: TEST.externalId,
          title: "Clean up failed initial prompt",
          description:
            "Stop a created session when its first prompt cannot complete.",
          relevantFiles: "",
        },
        3,
        20,
      ),
    ).rejects.toThrow("Initial interview prompt failed");
    expect(adapter.abortedSessions).toContain("mock-session-1");
  });

  it("propagates invalid initial output after successful session cleanup", async () => {
    const adapter = new MockOpenCodeAdapter();
    adapter.mockResponses.set(
      "mock-session-1",
      "No structured interview artifact was returned.",
    );

    await expect(
      startInterviewSession(
        adapter,
        "/tmp/test",
        "model-a",
        "questions: []",
        {
          ticketId: TEST.externalId,
          title: "Clean up invalid initial output",
          description:
            "Stop the session before reporting exhausted validation retries.",
          relevantFiles: "",
        },
        3,
        20,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        0,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining(
        "PROM4 output failed validation after 0 structured retry attempt(s)",
      ),
      blockedErrorDiagnostics: {
        kind: "runtime",
        modelId: "model-a",
        sessionId: "mock-session-1",
      },
    });
  });

  it("keeps the replacement session identity when restarted output still fails validation", async () => {
    const adapter = new SequencedMockOpenCodeAdapter();
    adapter.mockResponses.set("mock-session-1#1", "");
    adapter.mockResponses.set(
      "mock-session-2#1",
      "The replacement also omitted the artifact.",
    );

    await expect(
      startInterviewSession(
        adapter,
        "/tmp/test",
        "provider/model-a",
        "questions: []",
        {
          ticketId: TEST.externalId,
          title: "Failed replacement",
          description: "",
        },
        3,
        20,
      ),
    ).rejects.toMatchObject({
      blockedErrorDiagnostics: {
        modelId: "provider/model-a",
        sessionId: "mock-session-2",
      },
    });
  });

  it("preserves output-length diagnostics when an incomplete interview batch fails validation", async () => {
    class TruncatedResponseAdapter extends MockOpenCodeAdapter {
      override async getSessionMessages(sessionId: string) {
        const messages = await super.getSessionMessages(sessionId);
        return messages.map((message) =>
          message.role === "assistant"
            ? {
                ...message,
                parts: [
                  {
                    id: "finish-part",
                    sessionID: sessionId,
                    messageID: message.id,
                    type: "step-finish" as const,
                    reason: "length",
                    tokens: {
                      input: 100,
                      output: 200,
                      reasoning: 50,
                      cache: { read: 20, write: 0 },
                    },
                  },
                ],
              }
            : message,
        );
      }
    }
    const adapter = new TruncatedResponseAdapter();
    adapter.mockResponses.set(
      "existing-session",
      "<INTERVIEW_BATCH>\nquestions:",
    );

    await expect(
      submitBatchToSession(
        adapter,
        "existing-session",
        {},
        undefined,
        "provider/model-a",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        0,
      ),
    ).rejects.toMatchObject({
      blockedErrorCodes: ["OPENCODE_OUTPUT_TRUNCATED"],
      blockedErrorDiagnostics: {
        kind: "model_output_truncated",
        modelId: "provider/model-a",
        sessionId: "existing-session",
        finishReason: "length",
        outputTokens: 200,
        cacheReadTokens: 20,
        cacheWriteTokens: 0,
      },
    });
  });

  it("fails closed when aborting an invalid initial session throws", async () => {
    class FailingAbortAdapter extends MockOpenCodeAdapter {
      override async abortSession(_sessionId: string): Promise<boolean> {
        throw new Error("Remote abort unavailable");
      }
    }

    const adapter = new FailingAbortAdapter();
    adapter.mockResponses.set(
      "mock-session-1",
      "No structured interview artifact was returned.",
    );

    await expect(
      startInterviewSession(
        adapter,
        "/tmp/test",
        "model-a",
        "questions: []",
        {
          ticketId: TEST.externalId,
          title: "Fail closed on abort error",
          description:
            "Do not report a recoverable parse error with a live remote session.",
          relevantFiles: "",
        },
        3,
        20,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        0,
      ),
    ).rejects.toThrow(
      "Could not confirm abort of OpenCode session mock-session-1",
    );
  });

  it("restarts the initial PROM4 session after an empty response", async () => {
    const adapter = new SequencedMockOpenCodeAdapter();
    adapter.mockResponses.set("mock-session-1#1", "");
    adapter.mockResponses.set(
      "mock-session-2#1",
      [
        "<INTERVIEW_BATCH>",
        "batch_number: 1",
        "progress:",
        "  current: 1",
        "  total: 4",
        "is_final_free_form: false",
        "ai_commentary: Start with the compiled foundation checklist.",
        "questions:",
        "  - id: Q01",
        "    question: What problem are we solving?",
        "    phase: Foundation",
        "    priority: critical",
        "    rationale: Establish the core goal.",
        "    answer_type: free_text",
        "</INTERVIEW_BATCH>",
      ].join("\n"),
    );

    const result = await startInterviewSession(
      adapter,
      "/tmp/test",
      "model-a",
      [
        "questions:",
        "  - id: Q01",
        "    phase: foundation",
        "    question: What problem are we solving?",
      ].join("\n"),
      {
        ticketId: TEST.externalId,
        title: "Restart PROM4 session",
        description: "Blank output should restart the session.",
        relevantFiles: "",
      },
      5,
      20,
    );

    expect(result.sessionId).toBe("mock-session-2");
    expect(result.firstBatch.batchNumber).toBe(1);
    expect(adapter.sessions.map((session) => session.id)).toEqual([
      "mock-session-1",
      "mock-session-2",
    ]);
    expect(
      adapter.messages
        .get("mock-session-1")
        ?.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("Structured Output Retry"),
        ),
    ).toBe(false);
  });

  it("restarts a follow-up PROM4 batch from normalized interview state after an empty response", async () => {
    const adapter = new SequencedMockOpenCodeAdapter();
    adapter.mockResponses.set("existing-session#1", "");
    adapter.mockResponses.set(
      "mock-session-1#1",
      [
        "<INTERVIEW_BATCH>",
        "batch_number: 2",
        "progress:",
        "  current: 2",
        "  total: 4",
        "is_final_free_form: false",
        "ai_commentary: Continuing from the normalized state.",
        "questions:",
        "  - id: Q02",
        "    question: Which platforms should we support first?",
        "    phase: Scope",
        "    priority: high",
        "    rationale: Confirm delivery targets.",
        "    answer_type: single_choice",
        "    options:",
        "      - id: web",
        "        label: Web",
        "      - id: mobile",
        "        label: Mobile",
        "</INTERVIEW_BATCH>",
      ].join("\n"),
    );

    const baseSnapshot = createInterviewSessionSnapshot({
      winnerId: "model-a",
      compiledQuestions: [
        {
          id: "Q01",
          phase: "Foundation",
          question: "What problem are we solving?",
        },
      ],
      maxInitialQuestions: 5,
      followUpBudgetPercent: 20,
    });
    const preparedSnapshot = recordPreparedBatch(
      baseSnapshot,
      buildPersistedBatch(
        {
          questions: [
            {
              id: "Q01",
              question: "What problem are we solving?",
              phase: "Foundation",
              priority: "critical",
              rationale: "Establish the core goal.",
              answerType: "free_text",
            },
          ],
          progress: { current: 1, total: 4 },
          isComplete: false,
          isFinalFreeForm: false,
          aiCommentary: "Start with the compiled foundation checklist.",
          batchNumber: 1,
        },
        "prom4",
        baseSnapshot,
      ),
    );
    const answeredSnapshot = recordBatchAnswers(preparedSnapshot, {
      Q01: "Reliable structured output handling.",
    });

    const result = await submitBatchToSession(
      adapter,
      "existing-session",
      { Q01: "Reliable structured output handling." },
      undefined,
      "model-a",
      undefined,
      undefined,
      undefined,
      undefined,
      {
        projectPath: "/tmp/test",
        ticketState: {
          ticketId: TEST.externalId,
          title: "Resume PROM4 session",
          description: "Restart from normalized interview state.",
          interview:
            "questions:\n  - id: Q01\n    phase: Foundation\n    question: What problem are we solving?\n",
        },
        snapshot: answeredSnapshot,
      },
    );

    expect(result).toMatchObject({
      batchNumber: 2,
      sessionId: "mock-session-1",
      questions: [
        {
          id: "Q02",
          phase: "Scope",
        },
      ],
    });
    expect(
      adapter.messages
        .get("existing-session")
        ?.some(
          (message) =>
            typeof message.content === "string" &&
            message.content.includes("Structured Output Retry"),
        ),
    ).toBe(false);
    const restartedPrompt =
      adapter.messages
        .get("mock-session-1")
        ?.find((message) => message.role === "user")?.content ?? "";
    expect(restartedPrompt).toContain("## Resume Existing Interview Session");
    expect(restartedPrompt).toContain("max_initial_questions: 5");
    expect(restartedPrompt).toContain("max_follow_ups: 1");
    expect(restartedPrompt).toContain("Answered or skipped questions:");
    expect(restartedPrompt).toContain(
      "- Q01 (answered) [Foundation]: Reliable structured output handling.",
    );
    expect(restartedPrompt).toContain("Pending questions:");
    expect(restartedPrompt).not.toContain(
      "## Compiled Questions (from council)",
    );
    expect(restartedPrompt).not.toContain("questions:\n  - id: Q01");
  });
});
