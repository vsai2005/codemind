import { generateText } from "ai";
import { resolveModel, getDefaultModelId } from "@/lib/ai/models/registry";
import { logger } from "@/lib/logger";
import { scrubForLog } from "@/lib/ai/failure-classification";

/**
 * Automatic prompt enhancement / planning.
 *
 * A vague request ("create a food delivery app") produces a much better answer if it is
 * first decomposed into an engineering specification. This layer does that decomposition
 * server-side and hands the result to the main model alongside the user's original words.
 *
 * Two hard rules shape the design:
 *
 * 1. IT IS ADAPTIVE. A one-line fix must not be inflated into a system architecture.
 *    Complexity is chosen by the planner and bounds how much structure it emits.
 * 2. IT NEVER REPLACES THE USER'S INTENT. The plan is additive context; the original
 *    message is always still sent verbatim. The planner is told not to invent
 *    requirements, and a failure here degrades to plain generation rather than
 *    blocking the response.
 *
 * What surfaces to the user is a short, readable plan — not chain-of-thought. The
 * planner is explicitly instructed to emit a specification, never deliberation.
 */

export type PlanComplexity = "simple" | "moderate" | "complex";

export interface PlanArea {
  name: string;
  items: string[];
}

export interface ChatPlan {
  intent: string;
  complexity: PlanComplexity;
  summary: string;
  areas: PlanArea[];
  steps: string[];
}

/** Planning is a cheap side call; it must never dominate latency or spend. */
const PLAN_MAX_OUTPUT_TOKENS = 900;

/** Requests below this length are almost never worth decomposing. */
const MIN_CHARS_FOR_PLANNING = 24;

/**
 * Upper bound on the request text handed to the planner. The planner needs the ask,
 * not the whole conversation — sending 512K of context here would double the cost of
 * every turn for no benefit.
 */
const MAX_PROMPT_CHARS_FOR_PLANNING = 4000;
const MAX_CONTEXT_CHARS_FOR_PLANNING = 1500;

const MAX_AREAS = 6;
const MAX_ITEMS_PER_AREA = 6;
const MAX_STEPS = 8;

/** Conversational filler that would only waste a planning call. */
const TRIVIAL_REQUEST = /^(hi|hey|hello|thanks|thank you|ok|okay|yes|no|cool|nice|got it)\b[\s!.?]*$/i;

export function shouldPlan(userText: string): boolean {
  const trimmed = userText.trim();
  if (trimmed.length < MIN_CHARS_FOR_PLANNING) return false;
  if (TRIVIAL_REQUEST.test(trimmed)) return false;
  return true;
}

const PLANNER_SYSTEM = `You are CodeMind's planning stage. You turn a developer's request into a short, structured engineering specification that another model will implement.

Reply with ONLY a JSON object, no prose and no code fence:

{
  "intent": "one sentence restating what the user wants",
  "complexity": "simple" | "moderate" | "complex",
  "summary": "one short sentence describing the approach",
  "areas": [ { "name": "Frontend", "items": ["short phrase", "short phrase"] } ],
  "steps": ["short imperative step"]
}

Rules that matter:
- SCALE TO THE REQUEST. "Fix the login button" is simple: 1-2 areas, no invented architecture. "Build a SaaS app" is complex: use areas such as Frontend, Backend, Database, Features, Security, Deliverables.
- NEVER invent requirements the user did not ask for. If the request is ambiguous, stay conservative and say so in the intent.
- Items are short noun phrases (2-6 words), not sentences.
- At most ${MAX_AREAS} areas, ${MAX_ITEMS_PER_AREA} items per area, ${MAX_STEPS} steps.
- This is a specification the USER will read. Do not describe your own reasoning, do not narrate deliberation, do not use first person.`;

/** Coerce unknown JSON into a ChatPlan, or null when it is not usable. */
function normalizePlan(raw: unknown): ChatPlan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const candidate = raw as Record<string, unknown>;

  const intent = typeof candidate.intent === "string" ? candidate.intent.trim() : "";
  if (intent.length === 0) return null;

  const complexity: PlanComplexity =
    candidate.complexity === "simple" || candidate.complexity === "complex"
      ? candidate.complexity
      : "moderate";

  const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";

  const areas: PlanArea[] = [];
  if (Array.isArray(candidate.areas)) {
    for (const entry of candidate.areas.slice(0, MAX_AREAS)) {
      if (typeof entry !== "object" || entry === null) continue;
      const area = entry as Record<string, unknown>;
      const name = typeof area.name === "string" ? area.name.trim() : "";
      if (!name) continue;

      const items = Array.isArray(area.items)
        ? area.items
            .filter((i): i is string => typeof i === "string" && i.trim().length > 0)
            .map((i) => i.trim())
            .slice(0, MAX_ITEMS_PER_AREA)
        : [];

      if (items.length > 0) areas.push({ name, items });
    }
  }

  const steps = Array.isArray(candidate.steps)
    ? candidate.steps
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .map((s) => s.trim())
        .slice(0, MAX_STEPS)
    : [];

  // A plan with no structure at all is not worth showing.
  if (areas.length === 0 && steps.length === 0) return null;

  return { intent, complexity, summary, areas, steps };
}

/** Pull a JSON object out of a reply that may still be fenced or padded with prose. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;

  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

export interface BuildPlanOptions {
  userText: string;
  /** Conversation memory / retrieved excerpts, already assembled by ContextManager. */
  contextBlocks?: string;
  /** Model the user selected; the planner reuses it unless an override is configured. */
  modelId: string;
  signal?: AbortSignal;
}

/**
 * Produce a plan, or null.
 *
 * Returning null is a completely normal outcome — a trivial request, a planner that
 * timed out, malformed JSON. Callers must treat the plan as optional and proceed with
 * generation regardless. Planning is an enhancement, never a dependency.
 */
export async function buildPlan(options: BuildPlanOptions): Promise<ChatPlan | null> {
  const { userText, contextBlocks, modelId, signal } = options;

  if (!shouldPlan(userText)) return null;

  // A dedicated planner model can be configured; otherwise the user's own selection is
  // reused so planning honours the existing model routing rather than hardcoding one.
  const plannerModelId = process.env.CODEMIND_PLANNER_MODEL || modelId || getDefaultModelId();

  const prompt = [
    `REQUEST:\n${userText.slice(0, MAX_PROMPT_CHARS_FOR_PLANNING)}`,
    contextBlocks
      ? `\n\nRELEVANT CONTEXT (for grounding only, do not plan work for it):\n${contextBlocks.slice(0, MAX_CONTEXT_CHARS_FOR_PLANNING)}`
      : "",
  ].join("");

  try {
    const resolved = resolveModel(plannerModelId);

    const result = await generateText({
      model: resolved.model,
      system: PLANNER_SYSTEM,
      prompt,
      maxTokens: PLAN_MAX_OUTPUT_TOKENS,
      temperature: 0,
      maxRetries: 0,
      abortSignal: signal,
    });

    const plan = normalizePlan(extractJson(result.text));
    if (!plan) {
      logger.debug("Planner returned no usable plan; continuing without one");
      return null;
    }
    return plan;
  } catch (error) {
    // Never surface a planner failure to the user — it is not their problem, and the
    // main generation can proceed perfectly well without a plan.
    logger.warn("Planning stage failed; continuing without a plan", {
      error: error instanceof Error ? scrubForLog(error.message) : "unknown",
    });
    return null;
  }
}

/**
 * Render a plan as compact guidance for the main model.
 *
 * Deliberately terse: the main model already receives the user's original message, so
 * this is a scaffold, not a restatement.
 */
export function planToPromptBlock(plan: ChatPlan): string {
  const areas = plan.areas
    .map((area) => `${area.name}: ${area.items.join(", ")}`)
    .join("\n");
  const steps = plan.steps.length > 0 ? `\nSteps: ${plan.steps.join(" → ")}` : "";

  return `\n\n--- IMPLEMENTATION PLAN ---\nThis plan was derived from the user's request. Follow it, but the user's own words above take precedence if they conflict.\nIntent: ${plan.intent}\n${areas}${steps}`;
}
