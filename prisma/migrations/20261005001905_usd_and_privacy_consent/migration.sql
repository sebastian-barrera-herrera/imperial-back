-- AlterTable
ALTER TABLE "Case" ALTER COLUMN "currency" SET DEFAULT 'USD';

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "privacyAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "privacyVersion" TEXT;
