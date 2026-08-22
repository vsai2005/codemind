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

  describe("tolerates the typos that silently downgraded a request to plain chat", () => {
    /**
     * The message that actually failed in production. Two slips - a transposed "give"
     * and a missing space in "in the" - meant no qualifier matched, so a clear PDF
     * request fell through to normal chat. The model then invented a tool it does not
     * have and streamed JSON into the reply.
     */
    it("classifies the exact message that failed", () => {
      const result = detectArtifactIntent("giev me inthe pdf the code okay");
      expect(result?.type).toBe("pdf");
    });

    it("classifies the correctly spelled version identically", () => {
      const result = detectArtifactIntent("basic html of calendar give me in the pdf the code");
      expect(result?.type).toBe("pdf");
    });

    it("treats the misspelled and correct forms the same way", () => {
      const typo = detectArtifactIntent("giev me inthe pdf the code okay");
      const clean = detectArtifactIntent("give me in the pdf the code okay");
      expect(typo).toEqual(clean);
    });

    for (const prompt of [
      "gimme the report as a pdf",
      "gve me the code as a pdf",
      "giv me the calendar in a pdf",
    ]) {
      it(`handles ${JSON.stringify(prompt)}`, () => {
        expect(detectArtifactIntent(prompt)?.type).toBe("pdf");
      });
    }

    it("applies the same repair to zip requests", () => {
      expect(detectArtifactIntent("giev me the project as a zip")?.type).toBe("zip");
    });
  });

  describe("accepts natural in-the-pdf phrasing", () => {
    for (const prompt of [
      "put the code in a pdf",
      "give me in the pdf the code",
      "i want the calendar inside a pdf",
      "write the notes within a pdf",
    ]) {
      it(`handles ${JSON.stringify(prompt)}`, () => {
        expect(detectArtifactIntent(prompt)?.type).toBe("pdf");
      });
    }
  });

  describe("accepts the phrasings people actually type", () => {
    // Probed against real phrasings after the first fix still missed 10 of 17.
    // The gaps were structural: AS_PDF and IN_PDF both demanded an article, and
    // DELIVERY knew "give me" but not "give it to me", "i want" or "make me".
    for (const prompt of [
      "can you create a pdf",
      "make me a pdf",
      "i want a pdf",
      "i need it as a pdf file",
      "can u make pdf",
      "give it to me as pdf",
      "as pdf",
      "in pdf",
      "send it in pdf",
      "convert this to pdf",
      "can you give me the pdf",
      "do it in pdf format",
      "pdf format",
      "export as pdf",
    ]) {
      it(`handles ${JSON.stringify(prompt)}`, () => {
        expect(detectArtifactIntent(prompt)?.type).toBe("pdf");
      });
    }
  });

  describe("descriptive mentions of PDFs are still not requests", () => {
    // The lookahead in IN_PDF exists for these: "in pdf files" describes PDFs,
    // "in pdf" asks for one.
    for (const prompt of [
      "how text is stored in pdf files",
      "which pdf readers do you recommend",
      "the pdf was corrupted",
      "i opened a pdf yesterday",
      "explain how pdf compression works",
    ]) {
      it(`returns null for ${JSON.stringify(prompt)}`, () => {
        expect(detectArtifactIntent(prompt)).toBeNull();
      });
    }

    it("leaves 'pdf please' alone, one word from the bare noun", () => {
      // Deliberate. Treating a politeness marker as evidence of intent is weak, and
      // a miss now degrades gracefully: the model answers and invites the user to
      // ask for the download explicitly.
      expect(detectArtifactIntent("pdf please")).toBeNull();
    });
  });

  describe("the word pdf alone never triggers generation", () => {
    for (const prompt of [
      "pdf",
      "pdfs",
      "i opened a pdf yesterday",
      "what is a pdf",
      "how do i read a pdf in python",
      "the pdf was corrupted",
      "explain how pdf compression works",
    ]) {
      it(`returns null for ${JSON.stringify(prompt)}`, () => {
        expect(detectArtifactIntent(prompt)).toBeNull();
      });
    }
  });
});
