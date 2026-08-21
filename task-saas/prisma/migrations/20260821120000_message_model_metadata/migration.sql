-- Multi-model support: record which model produced each assistant message.
--
-- Both columns are nullable with no default, so every existing row stays valid and
-- pre-multi-model conversations continue to render. No data is rewritten.
ALTER TABLE "Message" ADD COLUMN "provider" TEXT;
ALTER TABLE "Message" ADD COLUMN "model" TEXT;
