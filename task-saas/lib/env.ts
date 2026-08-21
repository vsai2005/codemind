import { z } from "zod";

/**
 * Environment validation and the single source of truth for runtime configuration.
 *
 * Configuration hierarchy — there is exactly one of each, and no other module may
 * define a competing default:
 *
 *     environment variable  →  validated runtime configuration (this file)  →  consumer
 *
 * `lib/ai/context-manager.ts` and `lib/artifacts/generate.ts` re-export the accessors
 * below rather than reading `process.env` themselves, so a limit can only ever be
 * changed in one place.
 *
 * Nothing here logs or returns a secret value. `validateEnv` reports the NAMES of
 * variables that are missing or malformed and never their contents.
 */

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  AUTH_SECRET: z
    .string()
    .min(32, "AUTH_SECRET must be at least 32 characters (generate with: npx auth secret)"),
});

/** Every NVIDIA key slot the gateway will use, in the order it tries them. */
export const NVIDIA_KEY_ENV_VARS = [
  "NVIDIA_API_KEY_1",
  "NVIDIA_API_KEY_2",
  "NVIDIA_API_KEY_3",
  "NVIDIA_API_KEY_4",
  "NVIDIA_API_KEY_5",
  "NVIDIA_API_KEY",
] as const;

export function countConfiguredAiKeys(): number {
  return NVIDIA_KEY_ENV_VARS.filter((name) => Boolean(process.env[name])).length;
}

// ---------------------------------------------------------------------------
// AI token limits
// ---------------------------------------------------------------------------

/**
 * Shipped defaults — the values a fresh deployment runs with when nothing is set in
 * the environment. Deliberately the same numbers the README documents, so a clone
 * behaves like the machine it was developed on.
 *
 * 512,000 rather than the provider's full 1,048,576 ceiling: `estimateTokens` is a
 * heuristic that errs optimistic on dense code, and 512K stays inside the measured
 * ceiling even if the true ratio is 2.0 chars/token. See README "Context limits".
 */
export const AI_LIMIT_DEFAULTS = {
  contextMaxTokens: 512_000,
  maxOutputTokens: 16_384,
  artifactMaxOutputTokens: 16_000,
} as const;

/**
 * Hard bounds. Out-of-range values are clamped, and the adjustment is reported by
 * `validateEnv` at startup.
 *
 * The ceilings are the guard that matters: a context above the provider's 1,048,576
 * limit produces a rejected request rather than a degraded one. The floors only reject
 * degenerate values — a small window is a legitimate configuration (a smaller model, a
 * deliberately constrained deployment, a test), so they are set low enough not to
 * override an operator who meant it. A value that is merely a typo is caught by the
 * startup warning, not by silently rewriting it to something else wrong.
 */
export const AI_LIMIT_BOUNDS = {
  contextMaxTokens: { min: 256, max: 1_048_576 },
  maxOutputTokens: { min: 64, max: 131_072 },
  artifactMaxOutputTokens: { min: 256, max: 32_000 },
} as const;

type AiLimitName = keyof typeof AI_LIMIT_DEFAULTS;

const AI_LIMIT_ENV_VARS: Record<AiLimitName, string> = {
  contextMaxTokens: "AI_CONTEXT_MAX_TOKENS",
  maxOutputTokens: "AI_MAX_OUTPUT_TOKENS",
  artifactMaxOutputTokens: "AI_ARTIFACT_MAX_OUTPUT_TOKENS",
};

interface LimitRead {
  value: number;
  /** Set when the environment supplied something this function had to correct. */
  problem: string | null;
}

/**
 * Read one limit. An unset or empty variable takes the default silently — Docker
 * Compose passes `${VAR:-}`, so empty string is the normal "not configured" case and
 * must not be treated as an error.
 */
function readLimit(name: AiLimitName): LimitRead {
  const envName = AI_LIMIT_ENV_VARS[name];
  const raw = process.env[envName];
  const { min, max } = AI_LIMIT_BOUNDS[name];
  const fallback = AI_LIMIT_DEFAULTS[name];

  if (!raw || raw.trim().length === 0) return { value: fallback, problem: null };

  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return {
      value: fallback,
      problem: `${envName} is not a positive integer; using the default of ${fallback.toLocaleString()}.`,
    };
  }

  if (parsed < min || parsed > max) {
    const clamped = Math.min(Math.max(parsed, min), max);
    return {
      value: clamped,
      problem: `${envName}=${parsed.toLocaleString()} is outside the supported range ${min.toLocaleString()}–${max.toLocaleString()}; clamped to ${clamped.toLocaleString()}.`,
    };
  }

  return { value: parsed, problem: null };
}

/** Total context window CodeMind will assemble a prompt within. */
export function getContextTokenLimit(): number {
  return readLimit("contextMaxTokens").value;
}

/** Tokens reserved for the model's reply, subtracted from the context budget. */
export function getOutputTokenLimit(): number {
  return readLimit("maxOutputTokens").value;
}

/**
 * Output budget for artifact generation. Separate from the chat limit so ordinary
 * replies stay short, and hard-capped: an over-large project fails honestly rather
 * than being generated in truncated form.
 */
export function getArtifactOutputTokenLimit(): number {
  return readLimit("artifactMaxOutputTokens").value;
}

// ---------------------------------------------------------------------------
// Trusted proxy
// ---------------------------------------------------------------------------

/**
 * How many proxy hops in front of this app are under your control.
 *
 * `x-forwarded-for` is client-writable: anything a requester sends arrives verbatim,
 * and only the entries appended by proxies you actually operate are trustworthy. This
 * value says how many entries to trust from the RIGHT of the list.
 *
 *   0 (default)  no trusted proxy — the header is ignored entirely
 *   1            one reverse proxy (nginx, Caddy, a single load balancer)
 *   2            e.g. a CDN in front of a load balancer
 *
 * Defaulting to 0 means an unconfigured deployment cannot be tricked into trusting a
 * forged address. See lib/rate-limit.ts `clientIp`.
 */
export function trustedProxyHops(): number {
  const raw = process.env.CODEMIND_TRUSTED_PROXY_HOPS;
  if (!raw || raw.trim().length === 0) return 0;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (Number.isNaN(parsed) || parsed < 0) return 0;
  return Math.min(parsed, 8);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export interface EnvReport {
  warnings: string[];
}

/**
 * Throws on missing hard requirements; returns non-fatal warnings for optional
 * configuration. AI keys are a warning rather than an error so the app still boots on
 * a machine with no provider access.
 *
 * Called once at startup from instrumentation.ts. Only variable NAMES appear in the
 * output — never a value.
 */
export function validateEnv(): EnvReport {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    // Issue messages are authored above and never interpolate the received value.
    throw new Error(`Invalid environment variables:\n${formatted}`);
  }

  const warnings: string[] = [];

  for (const name of Object.keys(AI_LIMIT_DEFAULTS) as AiLimitName[]) {
    const { problem } = readLimit(name);
    if (problem) warnings.push(problem);
  }

  const context = getContextTokenLimit();
  const output = getOutputTokenLimit();
  if (output >= context) {
    warnings.push(
      `AI_MAX_OUTPUT_TOKENS (${output.toLocaleString()}) is not smaller than AI_CONTEXT_MAX_TOKENS (${context.toLocaleString()}). No room is left for the prompt; every request will fail.`
    );
  }

  if (countConfiguredAiKeys() === 0) {
    warnings.push(
      `No NVIDIA API key configured. Set at least one of: ${NVIDIA_KEY_ENV_VARS.join(", ")}. Chat and artifact generation will fail until one is present.`
    );
  }

  // Demo sign-in is an addition to email/password auth, never a prerequisite for it:
  // auth.ts registers the credentials provider unconditionally. Only the dangerous
  // direction is worth warning about.
  if (process.env.CODEMIND_DEMO_AUTH === "true" && process.env.NODE_ENV === "production") {
    warnings.push(
      "CODEMIND_DEMO_AUTH=true in production: anyone who can load the sign-in page becomes the shared demo user. Disable it unless this is an isolated demo host."
    );
  }

  if (process.env.NODE_ENV === "production" && trustedProxyHops() === 0) {
    warnings.push(
      "CODEMIND_TRUSTED_PROXY_HOPS is not set. x-forwarded-for will be ignored, so unauthenticated requests share one rate-limit bucket. Set it to the number of proxies you operate in front of this app."
    );
  }

  if (process.env.CODEMIND_DISABLE_RATE_LIMIT === "true") {
    warnings.push(
      "CODEMIND_DISABLE_RATE_LIMIT=true: all rate limiting is off. Intended for local development and load testing only."
    );
  }

  return { warnings };
}
