-- User-facing implementation plan attached to an assistant message.
-- Nullable with no default, so every existing message stays valid.
ALTER TABLE "Message" ADD COLUMN "plan" JSONB;
