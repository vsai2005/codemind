import { z } from "zod";

/**
 * Environment validation.
 *
 * Mirrors the architecture that actually ships: Postgres + Auth.js with the demo
 * credentials provider + NVIDIA NIM. There is no Google OAuth provider, so Google
 * credentials are not required (and are not read anywhere).
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

export interface EnvReport {
  warnings: string[];
}

/**
 * Throws on missing hard requirements; returns non-fatal warnings for optional
 * configuration. AI keys are a warning rather than an error so the task features
 * still boot on a machine with no NIM access.
 */
export function validateEnv(): EnvReport {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const formatted = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    console.error(`\n❌ Invalid environment variables:\n${formatted}\n`);
    throw new Error("Invalid environment variables");
  }

  const warnings: string[] = [];

  if (countConfiguredAiKeys() === 0) {
    warnings.push(
      `No NVIDIA API key configured. Set at least one of: ${NVIDIA_KEY_ENV_VARS.join(", ")}. Chat and artifact generation will fail until one is present.`
    );
  }

  if (process.env.CODEMIND_DEMO_AUTH !== "true") {
    warnings.push(
      "CODEMIND_DEMO_AUTH is not enabled, so no sign-in provider is registered. Set CODEMIND_DEMO_AUTH=true for local demo use, or configure a real provider."
    );
  } else if (process.env.NODE_ENV === "production") {
    warnings.push(
      "CODEMIND_DEMO_AUTH=true in production: every visitor signs in as the shared demo user."
    );
  }

  return { warnings };
}
