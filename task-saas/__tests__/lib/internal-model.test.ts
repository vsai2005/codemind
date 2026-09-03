import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  listModels,
  listModelsForClient,
  getModelDescriptor,
  getDefaultModelId,
  resolveModel,
} from "@/lib/ai/models/registry";
import { INTENT_CLASSIFIER_MODEL_ID } from "@/lib/ai/intent-classifier";
import { __resetScheduler } from "@/lib/ai/key-scheduler";

/**
 * `internal` models: resolvable for background work, never offered to a user.
 *
 * WHY A THIRD STATE EXISTS. The registry previously had two: `enabled: false` hides a
 * model AND makes it unresolvable, so it can serve nothing; plain `enabled: true` puts
 * it in the picker as a chat option. A model that exists only to answer a routing
 * question in 240ms is neither — it must be reachable by name and absent from the menu.
 *
 * Both halves are asserted here, because each fails differently and silently: a leak
 * into `listModels` shows users a model they should never pick, and a missing
 * `resolveModel` guard lets a client select it by sending the id by hand, which the
 * picker being clean would not prevent.
 */

const INTERNAL = "ising-calibration-1-5";

beforeEach(() => {
  process.env.NVIDIA_API_KEY = "nvapi-testkeytestkeytestkeytestkey";
  // The NVIDIA adapter leases keys from the scheduler, which snapshots the environment
  // once. Without this reset it stays initialised from import time and every resolve
  // fails with "provider is not configured" -- a failure that looks like the guard
  // under test rejecting the model, which is exactly the wrong thing to conclude.
  __resetScheduler();
});

afterEach(() => {
  delete process.env.NVIDIA_API_KEY;
  delete process.env.CODEMIND_INTENT_PROVIDER_MODEL;
});

describe("the classification model is registered", () => {
  it("exists under the id the classifier asks for", () => {
    // MUTATION GUARD against the two drifting apart. A renamed registry entry with an
    // unchanged constant fails only at runtime, on a provider call, in production.
    expect(INTENT_CLASSIFIER_MODEL_ID).toBe(INTERNAL);
    expect(getModelDescriptor(INTENT_CLASSIFIER_MODEL_ID)).not.toBeNull();
  });

  it("is marked internal and enabled", () => {
    const d = getModelDescriptor(INTERNAL);

    expect(d?.internal).toBe(true);
    expect(d?.enabled).toBe(true);
  });

  it("declares no vision and a small output ceiling", () => {
    // It answers with one word. A large ceiling here would be meaningless, and vision
    // would be a claim nothing checks.
    const d = getModelDescriptor(INTERNAL);

    expect(d?.supportsVision).toBe(false);
    expect(d?.maxOutputTokens).toBe(4_096);
  });

  it("reads its provider model id from the environment", () => {
    /**
     * Not a formality. This id is not a well-known public model, and the last
     * OpenRouter entry in the registry was deleted when its id 404'd upstream. An
     * operator has to be able to repoint it without a deploy.
     */
    process.env.CODEMIND_INTENT_PROVIDER_MODEL = "meta/llama-3.2-11b-vision-instruct";

    expect(getModelDescriptor(INTERNAL)?.providerModelId).toBe(
      "meta/llama-3.2-11b-vision-instruct"
    );
  });

  it("falls back to the measured default when unset", () => {
    expect(getModelDescriptor(INTERNAL)?.providerModelId).toBe(
      "nvidia/ising-calibration-1.5-31b"
    );
  });
});

describe("an internal model is never offered to a user", () => {
  it("is absent from listModels", () => {
    expect(listModels().map((d) => d.id)).not.toContain(INTERNAL);
  });

  it("is absent from the client-facing picker", () => {
    expect(listModelsForClient().map((m) => m.id)).not.toContain(INTERNAL);
  });

  it("is never chosen as the house default", () => {
    /**
     * MUTATION GUARD, and the failure it prevents is the worst one available: a
     * classification model silently becoming the model that answers everybody's chat.
     * Filtering inside `listModels` rather than at each call site is what makes this
     * hold for the picker and the default at the same time.
     */
    expect(getDefaultModelId()).not.toBe(INTERNAL);
  });

  it("still lists the ordinary models", () => {
    // The filter must exclude one entry, not empty the registry.
    const ids = listModels().map((d) => d.id);

    expect(ids).toContain("nemotron-3-ultra");
    expect(ids.length).toBeGreaterThan(2);
  });
});

describe("resolving an internal model", () => {
  it("is refused without an explicit opt-in", () => {
    /**
     * THE GUARD THAT ACTUALLY MATTERS. The chat route passes the user's requested id
     * straight to resolveModel, so `listModels` hiding the entry is a UI fact and not a
     * guarantee — a client can send any string it likes.
     */
    expect(() => resolveModel(INTERNAL)).toThrow(/not selectable/i);
  });

  it("is allowed for a caller that asks for it", () => {
    expect(() => resolveModel(INTERNAL, { allowInternal: true })).not.toThrow();
  });

  it("does not change how ordinary models resolve", () => {
    // MUTATION GUARD: a guard written as `!options?.allowInternal` alone, without the
    // `descriptor.internal` half, would refuse every model on the normal path.
    expect(() => resolveModel("nemotron-3-ultra")).not.toThrow();
  });

  it("still refuses an unknown id, opt-in or not", () => {
    expect(() => resolveModel("no-such-model", { allowInternal: true })).toThrow(/unknown/i);
  });
});
