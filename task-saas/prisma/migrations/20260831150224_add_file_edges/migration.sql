-- CreateEnum
CREATE TYPE "FileEdgeKind" AS ENUM ('resolved', 'external', 'unresolved');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "importsExtracted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "FileEdge" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "targetFileId" TEXT,
    "specifier" TEXT NOT NULL,
    "kind" "FileEdgeKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FileEdge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "FileEdge_repositoryId_sourceFileId_idx" ON "FileEdge"("repositoryId", "sourceFileId");

-- CreateIndex
CREATE INDEX "FileEdge_repositoryId_targetFileId_idx" ON "FileEdge"("repositoryId", "targetFileId");

-- CreateIndex
CREATE UNIQUE INDEX "FileEdge_sourceFileId_specifier_key" ON "FileEdge"("sourceFileId", "specifier");

-- AddForeignKey
ALTER TABLE "FileEdge" ADD CONSTRAINT "FileEdge_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileEdge" ADD CONSTRAINT "FileEdge_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "RepositoryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FileEdge" ADD CONSTRAINT "FileEdge_targetFileId_fkey" FOREIGN KEY ("targetFileId") REFERENCES "RepositoryFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
