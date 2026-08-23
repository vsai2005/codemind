-- AlterTable
ALTER TABLE "RepositoryFile" ADD COLUMN     "internalSymbols" TEXT[] DEFAULT ARRAY[]::TEXT[];

