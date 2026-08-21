-- Multi-user account foundation.
--
-- Additive and non-destructive: no table is dropped, no row is deleted, and every new
-- column is either nullable or carries a default, so existing users, conversations,
-- messages and artifacts survive untouched.

-- === User credentials ======================================================
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerified" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- === Artifact ownership ====================================================
-- Denormalised so a download can be authorised with a single indexed predicate
-- instead of joining Artifact -> Message -> Conversation on every request.
ALTER TABLE "Artifact" ADD COLUMN "userId" TEXT;

-- Backfill from the existing relationship chain. Every current artifact already has a
-- derivable owner, so this assigns the correct user without guessing.
UPDATE "Artifact" a
SET "userId" = c."userId"
FROM "Message" m
JOIN "Conversation" c ON c."id" = m."conversationId"
WHERE m."id" = a."messageId";

ALTER TABLE "Artifact"
  ADD CONSTRAINT "Artifact_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- === Multi-user query indexes ==============================================
-- Sidebar: "most recently updated conversations for this user".
CREATE INDEX "Conversation_userId_updatedAt_idx" ON "Conversation"("userId", "updatedAt");
-- Ordered message loads and the historical-retrieval scan.
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
-- Project list for a user.
CREATE INDEX "Project_userId_updatedAt_idx" ON "Project"("userId", "updatedAt");
-- "My artifacts", newest first.
CREATE INDEX "Artifact_userId_createdAt_idx" ON "Artifact"("userId", "createdAt");
