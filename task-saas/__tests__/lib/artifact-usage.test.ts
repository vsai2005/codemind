import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const generateText = vi.fn();

vi.mock("ai", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, generateText: (...a: unknown[]) => generateText(...a) };
});

import { generateArtifact } from "@/lib/artifacts/generate";

/**
 * Usage capture on the ARTIFACT path.
 *
 * The streaming path recorded tokens; this one discarded `result.usage` at the point
 * generateText returned, so a download turn persisted with no token record while a
 * chat turn in the same conversation recorded its own. The conversation total then
 * depended on which branch happened to answer it.
 *
 * The null contract is the same as the column's: a provider that reports nothing
 * stores null, never zero. Gemini reports nothing at all, so this is the common case
 * rather than an edge one.
 */
/**
 * A body long enough to pass validation. validateArtifact rejects a short PDF as
 * "too short to be a complete PDF" — a real guard against a truncated generation,
 * and one a fixture has to satisfy rather than sidestep.
 */
const PDF_BODY = Array.from(
  { length: 12 },
  (_, i) =>
    `## Section ${i + 1} — this section describes part ${i + 1} of the report in ` +
    `enough detail that the document reads as complete rather than truncated.`
).join("\n\n");

const PDF_OUTPUT = `<codemind_artifact type="pdf" name="report.pdf">
# Report

${PDF_BODY}
</codemind_artifact>`;

function options() {
  return { type: "pdf" as const, userPrompt: "make a report pdf" };
}

describe("artifact generation usage", () => {
  beforeEach(() => {
    process.env.NVIDIA_API_KEY_1 = "test-key";
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.NVIDIA_API_KEY_1;
  });

  it("returns the usage the provider reported", async () => {
    generateText.mockResolvedValue({
      text: PDF_OUTPUT,
      finishReason: "stop",
      usage: { promptTokens: 812, completionTokens: 240 },
    });

    const result = await generateArtifact(options());

    expect(result.ok).toBe(true);
    expect((result as { usage: unknown }).usage).toEqual({
      promptTokens: 812,
      completionTokens: 240,
    });
  });

  it("stores null, not zero, when the provider reports nothing", async () => {
    // Gemini and DeepSeek run under compatibility:"compatible" and send no usage
    // chunk, so the SDK leaves its NaN seed in place.
    generateText.mockResolvedValue({
      text: PDF_OUTPUT,
      finishReason: "stop",
      usage: { promptTokens: Number.NaN, completionTokens: Number.NaN },
    });

    const result = await generateArtifact(options());

    expect((result as { usage: unknown }).usage).toEqual({
      promptTokens: null,
      completionTokens: null,
    });
  });

  it("stores null when the response carries no usage object at all", async () => {
    generateText.mockResolvedValue({ text: PDF_OUTPUT, finishReason: "stop" });

    const result = await generateArtifact(options());

    expect((result as { usage: unknown }).usage).toEqual({
      promptTokens: null,
      completionTokens: null,
    });
  });

  it("keeps a genuine zero distinct from a missing count", async () => {
    // A provider CAN legitimately report zero prompt tokens. That is a measurement and
    // must survive as 0, while an absent completion count stays null — the whole point
    // of the nullable column.
    generateText.mockResolvedValue({
      text: PDF_OUTPUT,
      finishReason: "stop",
      usage: { promptTokens: 0, completionTokens: undefined },
    });

    const result = await generateArtifact(options());

    expect((result as { usage: { promptTokens: number | null; completionTokens: number | null } }).usage)
      .toEqual({ promptTokens: 0, completionTokens: null });
  });

  it("rejects a negative count rather than storing it", async () => {
    generateText.mockResolvedValue({
      text: PDF_OUTPUT,
      finishReason: "stop",
      usage: { promptTokens: -5, completionTokens: 10 },
    });

    const result = await generateArtifact(options());

    expect((result as { usage: { promptTokens: number | null } }).usage.promptTokens).toBeNull();
  });
});
