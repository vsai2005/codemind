import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AI_LIMIT_BOUNDS,
  AI_LIMIT_DEFAULTS,
  getArtifactOutputTokenLimit,
  getContextTokenLimit,
  getOutputTokenLimit,
  trustedProxyHops,
  validateEnv,
} from "@/lib/env";

/**
 * The configuration hierarchy is the point of these tests:
 *
 *     environment variable  →  validated runtime configuration  →  consumer
 *
 * The defect they guard against is drift — a documented value living somewhere other
 * than the code default, so that a fresh deployment silently runs on different numbers
 * from the machine it was developed on.
 */

const AI_VARS = [
  "AI_CONTEXT_MAX_TOKENS",
  "AI_MAX_OUTPUT_TOKENS",
  "AI_ARTIFACT_MAX_OUTPUT_TOKENS",
  "CODEMIND_TRUSTED_PROXY_HOPS",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const name of AI_VARS) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of AI_VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("AI limit configuration", () => {
  it("ships the documented defaults when nothing is configured", () => {
    expect(getContextTokenLimit()).toBe(512_000);
    expect(getOutputTokenLimit()).toBe(16_384);
    expect(getArtifactOutputTokenLimit()).toBe(16_000);
  });

  it("keeps the defaults table and the accessors in agreement", () => {
    expect(getContextTokenLimit()).toBe(AI_LIMIT_DEFAULTS.contextMaxTokens);
    expect(getOutputTokenLimit()).toBe(AI_LIMIT_DEFAULTS.maxOutputTokens);
    expect(getArtifactOutputTokenLimit()).toBe(AI_LIMIT_DEFAULTS.artifactMaxOutputTokens);
  });

  it("treats an empty string as unset", () => {
    // Docker Compose passes ${VAR:-}, so empty is the normal "not configured" case.
    process.env.AI_CONTEXT_MAX_TOKENS = "";
    expect(getContextTokenLimit()).toBe(AI_LIMIT_DEFAULTS.contextMaxTokens);
  });

  it("honours a configured value inside the supported range", () => {
    process.env.AI_CONTEXT_MAX_TOKENS = "200000";
    expect(getContextTokenLimit()).toBe(200_000);
  });

  it("clamps a value above the provider ceiling", () => {
    process.env.AI_CONTEXT_MAX_TOKENS = "5000000";
    expect(getContextTokenLimit()).toBe(AI_LIMIT_BOUNDS.contextMaxTokens.max);
  });

  it("falls back to the default when the value is not a positive integer", () => {
    process.env.AI_MAX_OUTPUT_TOKENS = "not-a-number";
    expect(getOutputTokenLimit()).toBe(AI_LIMIT_DEFAULTS.maxOutputTokens);
  });

  it("allows a deliberately small window rather than overriding the operator", () => {
    // A small context is a legitimate configuration, not a misconfiguration.
    process.env.AI_CONTEXT_MAX_TOKENS = "512";
    expect(getContextTokenLimit()).toBe(512);
  });
});

describe("trustedProxyHops", () => {
  it("defaults to zero so an unconfigured deployment trusts no forwarded header", () => {
    expect(trustedProxyHops()).toBe(0);
  });

  it("reads a configured hop count", () => {
    process.env.CODEMIND_TRUSTED_PROXY_HOPS = "2";
    expect(trustedProxyHops()).toBe(2);
  });

  it("refuses negative and unparsable values", () => {
    process.env.CODEMIND_TRUSTED_PROXY_HOPS = "-3";
    expect(trustedProxyHops()).toBe(0);
    process.env.CODEMIND_TRUSTED_PROXY_HOPS = "banana";
    expect(trustedProxyHops()).toBe(0);
  });
});

describe("validateEnv", () => {
  // Vitest does not load .env, so the hard requirements are supplied here. Without
  // them every case below would throw for the wrong reason and still look "correct".
  const REQUIRED = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/db?schema=public",
    AUTH_SECRET: "0123456789012345678901234567890123456789",
  } as const;

  let savedRequired: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedRequired = {};
    for (const [name, value] of Object.entries(REQUIRED)) {
      savedRequired[name] = process.env[name];
      process.env[name] = value;
    }
  });

  afterEach(() => {
    for (const name of Object.keys(REQUIRED)) {
      if (savedRequired[name] === undefined) delete process.env[name];
      else process.env[name] = savedRequired[name];
    }
  });

  it("passes when the hard requirements are present", () => {
    expect(() => validateEnv()).not.toThrow();
  });

  it("throws when DATABASE_URL is missing, naming the variable", () => {
    delete process.env.DATABASE_URL;
    expect(() => validateEnv()).toThrowError(/DATABASE_URL/);
  });

  it("throws when AUTH_SECRET is too short, without echoing the value", () => {
    process.env.AUTH_SECRET = "hunter2-but-far-too-short";

    expect(() => validateEnv()).toThrowError(/AUTH_SECRET/);
    // The rejected value must never appear in the message that gets logged.
    expect(() => validateEnv()).not.toThrowError(/hunter2/);
  });

  it("reports a clamped limit as a warning rather than failing the boot", () => {
    process.env.AI_CONTEXT_MAX_TOKENS = "9999999";
    const { warnings } = validateEnv();
    expect(warnings.some((w) => w.includes("AI_CONTEXT_MAX_TOKENS"))).toBe(true);
  });

  it("warns when the output reservation leaves no room for a prompt", () => {
    process.env.AI_CONTEXT_MAX_TOKENS = "1000";
    process.env.AI_MAX_OUTPUT_TOKENS = "2000";
    const { warnings } = validateEnv();
    expect(warnings.some((w) => w.includes("No room is left"))).toBe(true);
  });

  it("does not claim that sign-in is unavailable without demo auth", () => {
    // The credentials provider is registered unconditionally. The old warning said
    // otherwise and would have pushed an operator toward enabling demo auth.
    const previous = process.env.CODEMIND_DEMO_AUTH;
    delete process.env.CODEMIND_DEMO_AUTH;

    try {
      const { warnings } = validateEnv();
      expect(warnings.some((w) => w.includes("no sign-in provider"))).toBe(false);
    } finally {
      if (previous !== undefined) process.env.CODEMIND_DEMO_AUTH = previous;
    }
  });
});
