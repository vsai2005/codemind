import { describe, it, expect } from "vitest";
import { detectArtifactIntent } from "@/lib/ai/intent";

describe("detectArtifactIntent", () => {
  describe("returns null for normal chat", () => {
    const prompts = [
      "Show me a React component.",
      "Show me middleware.ts",
      "How do I implement a resilient streaming queue?",
      "Explain how Docker layer caching works",
      "What is the difference between SSR and SSG?",
      "Review this implementation",
      "Help me debug an error",
      "Write a function that debounces calls",
      "Can you display the config for me",
      "walk me through the auth flow",
      "",
    ];

    for (const prompt of prompts) {
      it(JSON.stringify(prompt), () => {
        expect(detectArtifactIntent(prompt)).toBeNull();
      });
    }
  });

  describe("detects zip requests", () => {
    const prompts = [
      "Create a React app and give me the project",
      "give me a zip",
      "Build a personal finance tracker and send me the whole project",
      "zip it up for me",
      "Can you package the project for download?",
      "give me all the files",
    ];

    for (const prompt of prompts) {
      it(JSON.stringify(prompt), () => {
        expect(detectArtifactIntent(prompt)?.type).toBe("zip");
      });
    }
  });

  describe("detects pdf requests", () => {
    const prompts = [
      "Explain Docker as a PDF",
      "give me a PDF",
      "Generate a PDF summarising the architecture",
      "export this as a pdf please",
    ];

    for (const prompt of prompts) {
      it(JSON.stringify(prompt), () => {
        expect(detectArtifactIntent(prompt)?.type).toBe("pdf");
      });
    }
  });

  describe("detects single-file requests", () => {
    const prompts = [
      "Create middleware.ts and give me the file.",
      "give me App.tsx",
      "give me the python script",
      "download the component for me",
    ];

    for (const prompt of prompts) {
      it(JSON.stringify(prompt), () => {
        expect(detectArtifactIntent(prompt)?.type).toBe("file");
      });
    }
  });

  it("lets an explicit delivery phrase override an inline phrasing", () => {
    expect(detectArtifactIntent("show me the structure, then give me the project")?.type).toBe("zip");
  });

  it("ignores non-string input", () => {
    expect(detectArtifactIntent(null)).toBeNull();
    expect(detectArtifactIntent(undefined)).toBeNull();
    expect(detectArtifactIntent(42)).toBeNull();
  });
});
