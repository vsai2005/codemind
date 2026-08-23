-- AlterTable
ALTER TABLE "Repository" ADD COLUMN     "symbolsExtracted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "RepositoryFile" ADD COLUMN     "symbols" TEXT[] DEFAULT ARRAY[]::TEXT[];

