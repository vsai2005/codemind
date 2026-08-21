import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_DOCUMENT_CHARS, MAX_IMAGE_BYTES } from "@/lib/attachments";

/**
 * Request validation for POST /api/chat.
 *
 * `messages` is browser-supplied and fully attacker-controlled for any authenticated
 * user, so it is validated structurally here and semantically in lib/attachments.ts.
 * Nothing in this payload conveys ownership — the conversation owner is always
 * resolved from the server session.
 */

export const MAX_MESSAGES_PER_REQUEST = 200;

/**
 * Hard cap on a single message, paired with AI_CONTEXT_MAX_TOKENS=512000.
 *
 * ContextManager estimates at 4 chars/token, so 2,000,000 chars ≈ 500,000 estimated
 * tokens — just inside the budget left after the output reservation. Raising the
 * context limit without raising this would be inert: the cap rejects the request
 * before ContextManager ever runs.
 *
 * Keep the two in step. See README "Context limits".
 */
export const MAX_MESSAGE_CHARS = 2_000_000;

/**
 * Aggregate cap across every message in one request.
 *
 * The per-message cap does not bound the request: 200 messages at 2,000,000 characters
 * each is 400MB, and `req.json()` allocates all of it before Zod sees the first field.
 * This is what actually bounds the payload.
 *
 * Sized to hold a full 512K-token current message (~2M chars), a long conversation
 * history, and one or two base64 image attachments (~14M chars per 10MB image) with
 * room to spare. It sits below BODY_LIMITS.chat so the transport limit never rejects
 * something this schema would have accepted — the two must move together.
 */
export const MAX_TOTAL_REQUEST_CHARS = 32_000_000;

/** Base64 inflates by ~4/3; allow the data URL prefix on top. */
const MAX_IMAGE_URL_CHARS = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 128;

/** Prisma cuid-shaped identifier. Deliberately looser than z.string().cuid(). */
const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid id format");

export const imageAttachmentSchema = z.object({
  type: z.literal("image"),
  id: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
  /** Validated in depth by validateImageDataUrl(); must be a CodeMind upload data URL. */
  url: z.string().min(1).max(MAX_IMAGE_URL_CHARS),
});

export const documentAttachmentSchema = z.object({
  type: z.literal("document"),
  id: z.string().max(100).optional(),
  name: z.string().max(200).optional(),
  extractedText: z.string().max(MAX_DOCUMENT_CHARS + 1_000),
});

export const attachmentSchema = z.discriminatedUnion("type", [
  imageAttachmentSchema,
  documentAttachmentSchema,
]);

export const attachmentBlockSchema = z.object({
  attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS_PER_MESSAGE),
});

export const chatMessageSchema = z.object({
  id: z.string().max(100).optional(),
  role: z.enum(["system", "user", "assistant", "data"]),
  content: z.string().max(MAX_MESSAGE_CHARS),
});

export const chatRequestSchema = z
  .object({
    messages: z.array(chatMessageSchema).min(1).max(MAX_MESSAGES_PER_REQUEST),
    conversationId: idSchema.nullish(),
    /**
     * Workspace for a NEW conversation. Shape-checked here; ownership of the project
     * is verified server-side before it is ever written.
     */
    projectId: idSchema.nullish(),
    /**
     * CodeMind model id chosen by the user. Shape-checked here only — the registry
     * decides whether it is real. An unregistered id must never reach a provider.
     */
    model: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, "invalid model id")
      .nullish(),
  })
  .refine((data) => data.messages[data.messages.length - 1]?.role === "user", {
    message: "the last message must be a user message",
    path: ["messages"],
  })
  .refine(
    (data) =>
      data.messages.reduce((total, message) => total + message.content.length, 0) <=
      MAX_TOTAL_REQUEST_CHARS,
    {
      message: `the conversation exceeds the ${MAX_TOTAL_REQUEST_CHARS.toLocaleString()} character limit for a single request`,
      path: ["messages"],
    }
  );

export type ChatMessageInput = z.infer<typeof chatMessageSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type AttachmentInput = z.infer<typeof attachmentSchema>;

/** Flatten Zod issues into a short, non-leaky error string. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => {
      const path = issue.path.join(".");
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join("; ");
}
