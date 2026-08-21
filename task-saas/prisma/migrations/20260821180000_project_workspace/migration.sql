-- Project workspace: standing instructions, durable memory, and archiving.
--
-- Additive and non-destructive. Every column is nullable with no default, so all
-- existing projects and their conversations remain valid and unchanged.
ALTER TABLE "Project" ADD COLUMN "instructions" TEXT;
ALTER TABLE "Project" ADD COLUMN "memory" JSONB;
ALTER TABLE "Project" ADD COLUMN "archivedAt" TIMESTAMP(3);
