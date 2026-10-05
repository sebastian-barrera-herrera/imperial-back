-- CreateEnum
CREATE TYPE "InvestmentStatus" AS ENUM ('ACTIVE', 'REDEEMED');

-- CreateTable
CREATE TABLE "OpportunityValuation" (
    "id" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "unitValue" DECIMAL(14,4) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityValuation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investment" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "units" DECIMAL(18,6) NOT NULL,
    "unitCost" DECIMAL(14,4) NOT NULL,
    "investedAt" DATE NOT NULL,
    "status" "InvestmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "redeemedAt" DATE,
    "redeemedValue" DECIMAL(14,2),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Investment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OpportunityValuation_opportunityId_date_idx" ON "OpportunityValuation"("opportunityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "OpportunityValuation_opportunityId_date_key" ON "OpportunityValuation"("opportunityId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Investment_code_key" ON "Investment"("code");

-- CreateIndex
CREATE INDEX "Investment_userId_idx" ON "Investment"("userId");

-- CreateIndex
CREATE INDEX "Investment_opportunityId_idx" ON "Investment"("opportunityId");

-- AddForeignKey
ALTER TABLE "OpportunityValuation" ADD CONSTRAINT "OpportunityValuation_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "InvestmentOpportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investment" ADD CONSTRAINT "Investment_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "InvestmentOpportunity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
