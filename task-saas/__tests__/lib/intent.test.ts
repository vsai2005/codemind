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

    it("now generates from 'pdf please' \— decision reversed, see below", () => {
      /**
       * REVERSED after independent measurement. This previously asserted null, on the
       * reasoning that a politeness marker is weak evidence and the miss degrades
       * gracefully.
       *
       * The reasoning held that the bare noun was the only available signal. It was
       * not: "please" is one discriminator, noun-initial position is another, and a
       * validation set built from phrasings this module was not written against put
       * SIX misses in this single class \— including "pdf abou the the pyton", which a
       * real user actually sent and which produced nothing.
       *
       * The four sibling assertions that motivated the original decision ("pdf",
       * "pdfs", "i opened a pdf yesterday", "the pdf was corrupted") all still hold
       * unchanged, which is what makes the narrower rule safe rather than a loosening.
       */
      expect(detectArtifactIntent("pdf please")?.type).toBe("pdf");
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
  /**
   * MEASURED FAILURES, not imagined ones.
   *
   * The reported symptom was "sometimes it creates a PDF and sometimes it doesn't".
   * Twenty-two ordinary phrasings were run through the detector and SIX fell through to
   * plain chat, in three distinct ways. Each group below is one of those causes, and
   * every string is a phrasing a person would actually type.
   *
   * The prompt was never the problem: for these six, generation was never reached.
   */
  describe("the phrasings that silently fell through to chat", () => {
    describe("an explicitly named PDF outranks a ZIP inferred from the subject", () => {
      it("routes a pdf ABOUT a project to pdf, not zip", () => {
        // "project" says what the document is about; "pdf" says what to produce.
        // This returned zip, so the user asked for a PDF and received an archive.
        expect(detectArtifactIntent("give me a pdf summary of this project")).toEqual({
          type: "pdf",
          reason: "explicit pdf request",
        });
      });

      it("routes a pdf ABOUT several files to pdf, not zip", () => {
        expect(detectArtifactIntent("give me a pdf covering all the files")?.type).toBe("pdf");
      });

      it("still packages a project when no format is named", () => {
        // The inference is not removed, only outranked. Without the word "pdf" this
        // must behave exactly as it always did.
        expect(detectArtifactIntent("give me this project")?.type).toBe("zip");
        expect(detectArtifactIntent("i want all the files")?.type).toBe("zip");
      });

      it("still packages when the user names BOTH formats", () => {
        // Naming pdf must not flip a message that also explicitly says zip. This is
        // decided by the explicit-zip branch, which runs BEFORE the subject-inferred
        // ones — not by the guard above, which such a message never reaches.
        expect(detectArtifactIntent("zip up the project with a pdf inside")?.type).toBe("zip");
        expect(detectArtifactIntent("i want the pdf and the zip")?.type).toBe("zip");
      });
    });

    describe('"show me" no longer cancels a format the user named', () => {
      it("treats show-me plus a named pdf as a request for one", () => {
        // Returned null. A PDF cannot be rendered inside a chat bubble, so asking to
        // see one is asking to be given one.
        expect(detectArtifactIntent("show me a pdf of the design doc")?.type).toBe("pdf");
      });

      it("treats show-me plus a named zip as a request for one", () => {
        expect(detectArtifactIntent("show me the zip of the project")?.type).toBe("zip");
      });

      it("still keeps show-me in the conversation when no format is named", () => {
        expect(detectArtifactIntent("show me middleware.ts")).toBeNull();
        expect(detectArtifactIntent("show me a react component")).toBeNull();
      });
    });

    describe("the verbs people use to ask for a document", () => {
      /**
       * Each phrase is longer than four words and carries NO other signal — no delivery
       * phrase, no "as a pdf", no "pdf format". The verb is the only thing that can
       * classify them, so removing one from the list fails its case here.
       */
      const byVerbAlone = [
        "prepare a pdf covering the retry behaviour",
        "draft a pdf on the caching strategy",
        "build a pdf report of the test coverage",
        "compose a pdf with the release notes",
        "assemble a pdf explaining the auth flow",
        "put together a pdf of the retry logic",
      ];

      for (const text of byVerbAlone) {
        it(`"${text}"`, () => {
          expect(detectArtifactIntent(text)?.type).toBe("pdf");
        });
      }
    });

    describe("a request carrying no verb the gate can match on", () => {
      /**
       * The class that a later, independent validation set showed to be the single
       * largest source of misses. Three signals, never the bare noun alone.
       */
      it("generates from the noun plus a politeness marker", () => {
        expect(detectArtifactIntent("pdf please")?.type).toBe("pdf");
      });

      it("does not generate from a passing mention", () => {
        expect(detectArtifactIntent("the pdf was corrupted")).toBeNull();
        expect(detectArtifactIntent("i opened a pdf yesterday")).toBeNull();
      });
    });
  });

  describe("a PDF named as the object, not used as an adjective", () => {
    /**
     * The narrow rule that lets "show me" through without dragging every sentence
     * containing the word "pdf" with it. Two signals are required: an article in front,
     * and an ending behind — the phrase stops, or takes a preposition.
     *
     * The first attempt at this used a lookahead listing excluded nouns
     * (files/documents/readers/viewers) and "show me the pdf parsing code" walked
     * straight through it. The nouns cannot be enumerated; the shape can.
     */
    it("does not fire when pdf modifies a following noun", () => {
      expect(detectArtifactIntent("show me the pdf parsing code")).toBeNull();
      expect(detectArtifactIntent("how do i read a pdf file in node")).toBeNull();
      expect(detectArtifactIntent("display the pdf viewer settings")).toBeNull();
    });

    it("requires the article", () => {
      // MUTATION GUARD: drop the leading article and "pdf on" matches here, turning a
      // question about a settings page into a document generation.
      expect(detectArtifactIntent("display pdf on the settings page")).toBeNull();
    });

    it("requires a display request alongside it", () => {
      // MUTATION GUARD: the object rule is never accepted on its own. A statement that
      // mentions a PDF asks for nothing.
      expect(detectArtifactIntent("my colleague already attached a pdf.")).toBeNull();
    });

    it("pairs with the DISPLAY subset, not with questions", () => {
      /**
       * MUTATION GUARD, and a bug this actually caused. Pairing the object rule with
       * the whole of SHOW_INLINE made "what is a pdf" a document generation — the
       * question forms in that set ("what is", "how does", "explain how") are answered
       * with prose, not with a file.
       */
      expect(detectArtifactIntent("what is a pdf")).toBeNull();
      expect(detectArtifactIntent("what is a pdf, roughly")).toBeNull();
      expect(detectArtifactIntent("explain how a pdf is structured")).toBeNull();
    });
  });

  /**
   * FOUND BY INDEPENDENT VALIDATION.
   *
   * Everything above was measured against phrasings written by the same session that
   * then fixed the code, so it could only confirm the rules it was derived from. This
   * block comes from a set built the other way round: from actual messages in the dev
   * database, one phrasing quoted in git history as a reported failure, and phrasings
   * generated from a taxonomy of what users are DOING (asking for a document, reporting
   * a broken file, asking a question about a format) rather than from reading the
   * patterns.
   *
   * That set scored 76.2%, not the 100% the earlier one reported.
   */
  describe("word order decides which format is the head of the request", () => {
    /**
     * THE MIRROR FAILURE, which the earlier fix introduced and its tests could not see.
     *
     * Making a named PDF outrank an inferred ZIP was done by disabling the ZIP
     * inference whenever "pdf" appeared anywhere. Three of four archive requests that
     * merely mentioned a pdf then started returning a pdf. The one test covering both
     * formats used a message containing the literal word "zip", which an earlier branch
     * catches, so the guard's real behaviour was never exercised.
     */
    it("a pdf ABOUT a project is a pdf", () => {
      expect(detectArtifactIntent("give me a pdf summary of this project")?.type).toBe("pdf");
      expect(detectArtifactIntent("give me a pdf covering all the files")?.type).toBe("pdf");
    });

    it("a project CONTAINING a pdf is a project", () => {
      expect(detectArtifactIntent("give me the project with a pdf readme inside")?.type).toBe(
        "zip"
      );
      expect(detectArtifactIntent("package the source files and the pdf together")?.type).toBe(
        "zip"
      );
      expect(detectArtifactIntent("i want the repo bundled up, pdf docs and all")?.type).toBe(
        "zip"
      );
    });

    it("still packages a project when no format is named at all", () => {
      expect(detectArtifactIntent("give me this project")?.type).toBe("zip");
      expect(detectArtifactIntent("i want all the files")?.type).toBe("zip");
    });
  });

  describe("asking without a verb", () => {
    it("a politeness marker turns the noun into a request", () => {
      expect(detectArtifactIntent("pdf please")?.type).toBe("pdf");
      expect(detectArtifactIntent("PDF of the API docs, please")?.type).toBe("pdf");
      expect(detectArtifactIntent("emailable pdf of the schema please")?.type).toBe("pdf");
    });

    it("but never when the message is a question", () => {
      // MUTATION GUARD. Politeness attaches to questions as readily as to requests,
      // and the answer to a question is prose.
      expect(detectArtifactIntent("can you please explain what a pdf is")).toBeNull();
      expect(detectArtifactIntent("please explain how pdfs are compressed")).toBeNull();
    });

    it("a desire frame counts, when it touches the noun", () => {
      expect(detectArtifactIntent("a pdf would be nice")?.type).toBe("pdf");
      expect(detectArtifactIntent("any chance of a pdf?")?.type).toBe("pdf");
    });

    it("but not when the frame is about an existing file behaving", () => {
      // MUTATION GUARD, and a false positive this rule actually caused before it was
      // narrowed: an unanchored desire frame made a complaint into a request.
      expect(detectArtifactIntent("it would be nice if the pdf worked")).toBeNull();
    });

    it("opening with the bare noun and a subject counts", () => {
      expect(detectArtifactIntent("pdf of the retry logic")?.type).toBe("pdf");
    });

    it("but not mid-sentence, and not with an article", () => {
      /**
       * MUTATION GUARDS, both from real false positives. Unanchor the pattern and
       * "i already have the pdf of the spec" becomes a request; allow a leading article
       * and "the pdf of the spec is attached" becomes one too. A bare noun at the start
       * of the message is the shape of an order; an article makes it a description.
       */
      expect(detectArtifactIntent("i already have the pdf of the spec, thanks")).toBeNull();
      expect(detectArtifactIntent("the pdf of the spec is attached")).toBeNull();
    });

    it("the bare noun on its own is still never enough", () => {
      // The constraint the original decision was protecting, still honoured.
      expect(detectArtifactIntent("pdf")).toBeNull();
      expect(detectArtifactIntent("pdfs")).toBeNull();
      expect(detectArtifactIntent("the pdf")).toBeNull();
      expect(detectArtifactIntent("i opened a pdf yesterday")).toBeNull();
    });

    it("classifies a real message from the dev database", () => {
      // "pdf abou the the pyton" \— sent by an actual user, produced nothing. Two slips
      // at once: a clipped "about", and a noun-led request with no verb.
      expect(detectArtifactIntent("pdf abou the the pyton")?.type).toBe("pdf");
    });
  });

  describe("a broken file is a report, not an order", () => {
    it('does not generate from "the pdf export button is broken"', () => {
      // The only false positive in the validation set. "export" sits in the delivery
      // list, where it reads as a verb; here it modifies "button".
      expect(detectArtifactIntent("the pdf export button is broken")).toBeNull();
    });

    it("an explicit ask still overrides the report", () => {
      // MUTATION GUARD for the override. Without it, asking for a replacement while
      // saying why is silently downgraded to chat.
      expect(detectArtifactIntent("the pdf is broken, give me a new one")?.type).toBe("pdf");
    });

    it("only suppresses when the broken thing is a FILE", () => {
      // MUTATION GUARD. Drop the format-noun requirement and this genuine request,
      // which happens to be about a broken build, stops generating.
      expect(detectArtifactIntent("make a pdf explaining why the build is broken")?.type).toBe(
        "pdf"
      );
    });
  });

});
