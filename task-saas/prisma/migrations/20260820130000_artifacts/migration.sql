-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('zip', 'pdf', 'file');

-- CreateTable
CREATE TABLE "Artifact" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "type" "ArtifactType" NOT NULL,
    "filename" TEXT NOT NULL,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "byteSize" INTEGER NOT NULL DEFAULT 0,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Artifact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Artifact_messageId_idx" ON "Artifact"("messageId");

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
