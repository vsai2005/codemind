import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  listModels,
  listModelsForClient,
  getModelDescriptor,
  getDefaultModelId,
  resolveModel,
} from "@/lib/ai/models/registry";

/**
 * GLM 5.3 Flash, via OpenRouter.
 *
 * Every number below is LITERAL and comes from OpenRouter's catalogue entry, not from
 * the constants in registry.ts. A fixture derived from the constant it checks moves with
 * a mutation of that constant and proves nothing — and the specific failure this guards
 * against is a plausible-looking wrong number, since the catalogue also carries
 * `z-ai/glm-5.3`, a `:batch` variant and a floating alias, all with different ceilings.
 */

const ID = "glm-5-3-flash";

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "sk-or-v1-testkeytestkeytestkeytestkeytestkey";
});

afterEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_GLM_MODEL;
});

describe("the model is registered", () => {
  it("exists and is enabled", () => {
    const d = getModelDescriptor(ID);

    expect(d).not.toBeNull();
    expect(d?.enabled).toBe(true);
  });

  it("is offered to users, unlike the classification entry", () => {
    // MUTATION GUARD against it being marked `internal` by copy-paste from the entry
    // directly below it in the registry, which would hide it from the picker entirely.
    expect(d().internal).toBeUndefined();
    expect(listModels().map((m) => m.id)).toContain(ID);
    expect(listModelsForClient().map((m) => m.id)).toContain(ID);
  });

  it("is served by OpenRouter", () => {
    expect(d().provider).toBe("openrouter");
    expect(d().providerLabel).toBe("OpenRouter");
  });

  it("does not displace the house default", () => {
    // Order is meaningful in this registry: getDefaultModelId walks it and takes the
    // first configured entry. A new model must not silently become everyone's default.
    expect(getDefaultModelId()).not.toBe(ID);
  });
});

describe("the ids and ceilings match the catalogue", () => {
  it("points at the flash id, not its neighbours", () => {
    /**
     * THE ONE THAT MATTERS. `z-ai/glm-5.3` is a different and pricier model,
     * `z-ai/glm-5.3-flash:batch` is a different endpoint, and `~z-ai/glm-flash-latest`
     * floats. Only one of the four is what was asked for.
     */
    expect(d().providerModelId).toBe("z-ai/glm-5.3-flash");
  });

  it("carries the advertised context and output ceilings", () => {
    expect(d().providerContextTokens).toBe(1_310_720);
    expect(d().maxOutputTokens).toBe(131_072);
  });

  it("declares image support but not streaming-less operation", () => {
    // input_modalities is text/image/video; only images are reachable through
    // /api/upload, so vision means images here as it does for the other entries.
    expect(d().supportsVision).toBe(true);
    expect(d().supportsStreaming).toBe(true);
  });

  it("is repointable without a deploy", () => {
    // An OpenRouter id has 404'd upstream in this registry before.
    process.env.OPENROUTER_GLM_MODEL = "z-ai/glm-5.3";

    expect(d().providerModelId).toBe("z-ai/glm-5.3");
  });

  it("does not share the Inkling entry's variable", () => {
    /**
     * MUTATION GUARD. Reusing OPENROUTER_MODEL here would repoint BOTH entries at once,
     * which is how an entry labelled "Inkling Small" once ended up serving Nemotron.
     */
    process.env.OPENROUTER_MODEL = "some/other-model";

    expect(d().providerModelId).toBe("z-ai/glm-5.3-flash");

    delete process.env.OPENROUTER_MODEL;
  });
});

describe("resolving it", () => {
  it("resolves with an OpenRouter key present", () => {
    expect(() => resolveModel(ID)).not.toThrow();
  });

  it("clamps the context to CodeMind's target, not the provider's ceiling", () => {
    // 1,310,720 is what the provider supports; 512,000 is what this product decided to
    // send. The descriptor records the first and resolveModel applies the second.
    expect(resolveModel(ID).effectiveContextTokens).toBe(512_000);
  });

  it("fails with a clear error when the key is absent", () => {
    delete process.env.OPENROUTER_API_KEY;

    expect(() => resolveModel(ID)).toThrow(/not configured/i);
  });
});

/** Shorthand that fails loudly rather than returning undefined fields. */
function d() {
  const found = getModelDescriptor(ID);
  if (!found) throw new Error(`${ID} is not registered`);
  return found;
}
