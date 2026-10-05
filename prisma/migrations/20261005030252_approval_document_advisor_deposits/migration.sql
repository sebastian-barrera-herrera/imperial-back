-- AlterTable
ALTER TABLE "Profile" ADD COLUMN     "country" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "advisorId" TEXT,
ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivationReason" TEXT;

-- CreateTable
CREATE TABLE "ApprovalDocument" (
    "requestId" TEXT NOT NULL,
    "issuerName" TEXT NOT NULL,
    "signerName" TEXT,
    "signerTitle" TEXT,
    "financialEntity" TEXT NOT NULL,
    "accountLast4" TEXT,
    "requestDate" DATE NOT NULL,
    "issuePlace" TEXT NOT NULL,
    "notes" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalDocument_pkey" PRIMARY KEY ("requestId")
);

-- CreateTable
CREATE TABLE "ClientDeposit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "depositedAt" DATE NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientDeposit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ClientDeposit_clientId_depositedAt_idx" ON "ClientDeposit"("clientId", "depositedAt");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_advisorId_fkey" FOREIGN KEY ("advisorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalDocument" ADD CONSTRAINT "ApprovalDocument_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DisbursementRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDeposit" ADD CONSTRAINT "ClientDeposit_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
