import { readFileSync } from "node:fs";
import * as jsYaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { repairInterviewBatchFieldTags } from "../interviewBatchTagRepair";
import { normalizeInterviewTurnOutput } from "../interviewOutput";
import { buildYamlDocument, collectTaggedCandidates } from "../yamlUtils";
import { PROTOCOL_TAGS } from "@shared/protocolTags";

const original = readFileSync(
  new URL("./fixtures/interview-batch-field-tags.txt", import.meta.url),
  "utf8",
);
const retry = original
  .replace("  <current>1</current>", "  current: 1")
  .replace("  <total>9</total>", "  total: 9");
const simple = [
  "<batch_number>1</batch_number>",
  "<progress>",
  "  <current>1</current>",
  "  <total>9</total>",
  "</progress>",
  "<is_final_free_form>false</is_final_free_form>",
  "<ai_commentary>",
  'Keep this wording: "as emitted".',
  "</ai_commentary>",
  "<questions>",
  "  - id: Q01",
  '    question: "What should happen?"',
  "</questions>",
].join("\n");

function batchResponse(body: string): string {
  return `<INTERVIEW_BATCH>\n${body}\n</INTERVIEW_BATCH>`;
}

describe("interview batch field tag recovery", () => {
  it.each([
    ["original", original],
    ["retry", retry],
    ["CRLF", original.replace(/\n/g, "\r\n")],
  ])(
    "recovers the real RICH-3 %s response without changing emitted text or choices",
    (_label, response) => {
      const body = collectTaggedCandidates(
        response,
        PROTOCOL_TAGS.INTERVIEW_BATCH,
      )[0]!.replace(/\r\n?/g, "\n");
      const repaired = repairInterviewBatchFieldTags(body);
      expect(repaired).not.toBeNull();
      const emittedQuestions = jsYaml.load(
        body.slice(
          body.indexOf("<questions>") + "<questions>".length,
          body.indexOf("</parameter>"),
        ),
      );
      const repairedPayload = jsYaml.load(
        repaired!.content.replace("</parameter>", ""),
      ) as Record<string, unknown>;
      expect(repairedPayload.questions).toEqual(emittedQuestions);
      expect(repairedPayload.ai_commentary).toBe(
        body.split("<ai_commentary>\n")[1]!.split("\n</ai_commentary>")[0],
      );

      const result = normalizeInterviewTurnOutput(response);
      expect(result.ok).toBe(true);
      if (!result.ok || result.value.kind !== "batch") return;
      expect(result.value.batch).toMatchObject({
        batchNumber: 1,
        progress: { current: 1, total: 9 },
        isFinalFreeForm: false,
      });
      expect(result.value.batch.questions).toHaveLength(3);
      expect(
        result.value.batch.questions.map(({ id, question, options }) => ({
          id,
          question,
          options,
        })),
      ).toEqual(
        (emittedQuestions as Array<Record<string, unknown>>).map(
          ({ id, question, options }) => ({ id, question, options }),
        ),
      );
      expect(result.repairWarnings).toContain(
        'Repaired interview batch field tag at batch_number, payload line 1: "<batch_number>1</batch_number>" -> "batch_number: 1".',
      );
      expect(
        result.repairWarnings.some((warning) =>
          warning.includes("</parameter>"),
        ),
      ).toBe(true);
      expect(
        result.repairWarnings.some((warning) =>
          warning.includes("tags <progress>"),
        ),
      ).toBe(false);
    },
  );

  it("keeps valid YAML and literal markup unchanged", () => {
    const payload = {
      batch_number: 1,
      progress: { current: 1, total: 9 },
      is_final_free_form: false,
      ai_commentary: "<questions> is literal XML here.",
      questions: [
        {
          id: "Q01",
          question: "<batch_number>1</batch_number>\n<questions>\n</questions>",
        },
      ],
    };
    const canonical = buildYamlDocument(payload);
    expect(repairInterviewBatchFieldTags(canonical)).toBeNull();
    const result = normalizeInterviewTurnOutput(batchResponse(canonical));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "batch") return;
    expect(result.repairApplied).toBe(false);
    expect(result.repairWarnings).toEqual([]);
    expect(result.value.batch.aiCommentary).toBe(payload.ai_commentary);
    expect(result.value.batch.questions[0]!.question).toBe(
      payload.questions[0]!.question,
    );
  });

  it("preserves commentary newlines, colon text, quotes, and literal field tags", () => {
    const commentary =
      'First: "quoted".\n<questions>\n  <current>example</current>\n</questions>\nLast line.';
    const body = simple.replace('Keep this wording: "as emitted".', commentary);
    const result = normalizeInterviewTurnOutput(batchResponse(body));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "batch") return;
    expect(result.value.batch.aiCommentary).toBe(commentary);
    const warning = result.repairWarnings.find((entry) =>
      entry.includes("at ai_commentary,"),
    )!;
    expect(warning).toContain(
      JSON.stringify(`<ai_commentary>\n${commentary}\n</ai_commentary>`),
    );
    expect(warning).toContain(
      JSON.stringify(`ai_commentary: ${JSON.stringify(commentary)}`),
    );
  });

  it("preserves literal XML in question block scalars while repairing sibling fields", () => {
    const body = simple.replace(
      '    question: "What should happen?"',
      [
        "    question: |-",
        "      <questions>",
        "        <batch_number>example</batch_number>",
        "      </questions>",
      ].join("\n"),
    );
    const result = normalizeInterviewTurnOutput(batchResponse(body));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "batch") return;
    expect(result.value.batch.questions[0]!.question).toBe(
      "<questions>\n  <batch_number>example</batch_number>\n</questions>",
    );
  });

  it("supports mixed native YAML fields and recognized tags", () => {
    const body = simple.replace(
      "<batch_number>1</batch_number>",
      "batch_number: 1",
    );
    const result = normalizeInterviewTurnOutput(batchResponse(body));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "batch") return;
    expect(result.value.batch.batchNumber).toBe(1);
  });

  it("accepts an explicitly emitted empty commentary without creating text", () => {
    const body = simple.replace(
      '<ai_commentary>\nKeep this wording: "as emitted".\n</ai_commentary>',
      "<ai_commentary></ai_commentary>",
    );
    const result = normalizeInterviewTurnOutput(batchResponse(body));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "batch") return;
    expect(result.value.batch.aiCommentary).toBe("");
    expect(result.value.batch.isFinalFreeForm).toBe(false);
  });

  it.each([
    [
      "duplicate tagged field",
      simple.replace(
        "<batch_number>1</batch_number>",
        "<batch_number>1</batch_number>\n<batch_number>2</batch_number>",
      ),
    ],
    [
      "tag and YAML duplicate",
      simple.replace(
        "<batch_number>1</batch_number>",
        "batch_number: 2\n<batch_number>1</batch_number>",
      ),
    ],
    [
      "alias conflict",
      simple.replace(
        "<batch_number>1</batch_number>",
        "batchNumber: 2\n<batch_number>1</batch_number>",
      ),
    ],
    [
      "duplicate progress",
      simple.replace("  <total>9</total>", "  <total>9</total>\n  total: 10"),
    ],
    [
      "duplicate native field",
      simple.replace(
        "<batch_number>1</batch_number>",
        "batch_number: 1\nbatch_number: 2",
      ),
    ],
    [
      "missing field value",
      simple.replace(
        "<batch_number>1</batch_number>",
        "<batch_number></batch_number>",
      ),
    ],
    [
      "missing required progress",
      simple.replace("  <current>1</current>\n", ""),
    ],
    [
      "missing free-form flag",
      simple.replace("<is_final_free_form>false</is_final_free_form>\n", ""),
    ],
    [
      "missing commentary",
      simple.replace(
        '<ai_commentary>\nKeep this wording: "as emitted".\n</ai_commentary>\n',
        "",
      ),
    ],
    [
      "unknown root tag",
      simple.replace("<batch_number>1</batch_number>", "<unknown>1</unknown>"),
    ],
    ["unknown native field", `unknown: extra\n${simple}`],
    [
      "tag attributes",
      simple.replace("<batch_number>", '<batch_number source="model">'),
    ],
    [
      "non-integer value",
      simple.replace(
        "<batch_number>1</batch_number>",
        "<batch_number>one</batch_number>",
      ),
    ],
    [
      "invalid boolean",
      simple.replace(
        "<is_final_free_form>false</is_final_free_form>",
        "<is_final_free_form>maybe</is_final_free_form>",
      ),
    ],
    [
      "unknown progress child",
      simple.replace("  <total>9</total>", "  <unknown>9</unknown>"),
    ],
    [
      "different mismatched closing tag",
      simple.replace("</questions>", "</other>"),
    ],
    ["missing commentary close", simple.replace("</ai_commentary>", "")],
  ])("rejects %s without guessing content", (_label, body) => {
    expect(repairInterviewBatchFieldTags(body)).toBeNull();
    const result = normalizeInterviewTurnOutput(batchResponse(body));
    expect(result.ok).toBe(false);
    expect(
      result.repairWarnings.some((warning) =>
        warning.startsWith("Repaired interview batch field tag"),
      ),
    ).toBe(false);
  });

  it("still rejects a structurally repaired batch when a question is missing its text", () => {
    const body = simple.replace('    question: "What should happen?"', "");
    const repaired = repairInterviewBatchFieldTags(body);
    expect(repaired).not.toBeNull();
    expect(repaired!.content).not.toContain("question:");
    expect(normalizeInterviewTurnOutput(batchResponse(body)).ok).toBe(false);
  });

  it.each([
    [
      "question text",
      '    question: "What should happen?"\n    prompt: "A different question"',
    ],
    [
      "question id",
      '    question: "What should happen?"\n    question_id: DIFFERENT',
    ],
    [
      "question rationale",
      '    question: "What should happen?"\n    rationale: "First reason"\n    reason: "Different reason"',
    ],
    [
      "option label",
      '    question: "What should happen?"\n    options:\n      - id: first\n        label: "First label"\n        text: "Different label"',
    ],
    [
      "option id",
      '    question: "What should happen?"\n    options:\n      - id: first\n        key: different\n        label: "First label"',
    ],
  ])(
    "rejects conflicting %s aliases in the recovery branch",
    (_label, questionFields) => {
      const body = simple.replace(
        '    question: "What should happen?"',
        questionFields,
      );
      expect(repairInterviewBatchFieldTags(body)).not.toBeNull();
      expect(normalizeInterviewTurnOutput(batchResponse(body)).ok).toBe(false);
    },
  );

  it("accepts equal nested aliases without discarding different emitted values", () => {
    const body = simple.replace(
      '    question: "What should happen?"',
      [
        '    question: "What should happen?"',
        '    prompt: "What should happen?"',
        "    question_id: Q01",
        "    options:",
        "      - id: first",
        "        key: first",
        '        label: "First label"',
        '        text: "First label"',
      ].join("\n"),
    );
    const result = normalizeInterviewTurnOutput(batchResponse(body));
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "batch") return;
    expect(result.value.batch.questions[0]).toEqual({
      id: "Q01",
      question: "What should happen?",
      options: [{ id: "first", label: "First label" }],
    });
    expect(
      result.repairWarnings.some((warning) => warning.includes("conflicting")),
    ).toBe(false);
  });

  it("keeps the existing alias precedence behavior for ordinary canonical batches", () => {
    const result = normalizeInterviewTurnOutput(
      batchResponse(
        buildYamlDocument({
          batch_number: 1,
          progress: { current: 1, total: 9 },
          is_final_free_form: false,
          ai_commentary: "",
          questions: [
            {
              id: "Q01",
              question: "Keep this question",
              prompt: "A different question",
            },
          ],
        }),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.kind !== "batch") return;
    expect(result.value.batch.questions[0]!.question).toBe(
      "Keep this question",
    );
    expect(result.repairWarnings).toContain(
      'Resolved "question" and ignored the conflicting value in "prompt".',
    );
  });

  it("does not apply this recovery to another status schema", () => {
    const result = normalizeInterviewTurnOutput(
      `<INTERVIEW_COMPLETE>\n${simple}\n</INTERVIEW_COMPLETE>`,
    );
    expect(
      result.repairWarnings.some((warning) =>
        warning.startsWith("Repaired interview batch field tag"),
      ),
    ).toBe(false);
  });
});
