import { generateText } from "ai";
import { getModelDescriptor, listModels, resolveModel } from "@/lib/ai/models/registry";
import { getProviderAdapter } from "@/lib/ai/models/providers";

/**
 * Does a registry entry actually work with the credentials on this machine?
 *
 * WHY THIS EXISTS. Every fact in the registry — the provider model id, the context
 * window, the output ceiling — is copied from a provider's catalogue by hand. The unit
 * tests prove the entry says what it is meant to say; they cannot prove the provider
 * agrees, because they never make a call. That gap is not theoretical here: an
 * OpenRouter entry in this registry was deleted outright when its id started returning
 * 404 upstream, and the catalogue for one model family carries four near-identical ids
 * with different prices and ceilings.
 *
 * So this is the step between "the key is pasted" and "the model is trusted".
 *
 *   npm run check:model                  every enabled model
 *   npm run check:model glm-5-3-flash    one of them
 *
 * Reads .env through tsx's --env-file, so it sees exactly what the app sees.
 */

const PROMPT = "Reply with exactly one word: OK";

/**
 * Output budget for the probe, and it is NOT small on purpose.
 *
 * MEASURED, after this script reported a false failure on its first real use. Nearly
 * every chat model in this registry reasons by default, so a tight cap is spent on the
 * thinking pass and the visible reply comes back empty with finish=length. GLM 5.3 Flash
 * returned "" at 16 tokens and "OK" at 128 — the model was fine, the probe was wrong.
 *
 * A diagnostic that fails on working models is worse than no diagnostic, so the budget
 * is set well above what a reasoning pass needs for a one-word answer. This costs a few
 * seconds per model and buys an answer that means something.
 */
const PROBE_MAX_TOKENS = 256;

/** Never print a credential, only whether one is present. */
function credentialState(id: string): string {
  const d = getModelDescriptor(id);
  if (!d) return "unknown model";
  return getProviderAdapter(d.provider).isConfigured() ? "key present" : "NO KEY CONFIGURED";
}

async function check(id: string): Promise<boolean> {
  const d = getModelDescriptor(id);
  if (!d) {
    console.log(`  UNKNOWN   ${id}  (not in the registry)`);
    return false;
  }

  const cred = credentialState(id);
  if (cred !== "key present") {
    console.log(`  SKIP      ${id.padEnd(30)} ${d.providerLabel.padEnd(11)} ${cred}`);
    return false;
  }

  const started = Date.now();
  try {
    const resolved = resolveModel(id, { allowInternal: true });
    const result = await generateText({
      model: resolved.model,
      prompt: PROMPT,
      maxTokens: PROBE_MAX_TOKENS,
      temperature: 0,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(30_000),
    });
    const ms = Date.now() - started;
    const text = result.text.trim().replace(/\s+/g, " ").slice(0, 40);
    // An empty reply is still a REAL failure rather than a pass -- but with the budget
    // above it now means something is genuinely wrong, not that the probe was too tight.
    const ok = text.length > 0;
    console.log(
      `  ${ok ? "OK      " : "EMPTY   "}  ${id.padEnd(30)} ${String(ms).padStart(6)}ms  ` +
        `${JSON.stringify(text)}${ok ? "" : "   <- answered with nothing at all"}`
    );
    return ok;
  } catch (error) {
    console.log(
      `  FAILED    ${id.padEnd(30)} ${String(Date.now() - started).padStart(6)}ms  ` +
        String(error instanceof Error ? error.message : error).slice(0, 70)
    );
    return false;
  }
}

(async () => {
  const requested = process.argv.slice(2);
  const ids = requested.length > 0 ? requested : listModels().map((d) => d.id);

  console.log(`Checking ${ids.length} model(s) against the live provider.\n`);
  let ok = 0;
  for (const id of ids) if (await check(id)) ok++;
  console.log(`\n${ok}/${ids.length} answered.`);
  if (ok < ids.length) {
    console.log("A SKIP means no credential for that provider; FAILED means it answered badly.");
  }
})();
