-- CreateEnum
CREATE TYPE "IssuedDocumentCategory" AS ENUM ('CONTRACT', 'RESOLUTION', 'CERTIFICATE', 'INVOICE', 'REPORT', 'OTHER');

-- CreateTable
CREATE TABLE "IssuedDocument" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "caseId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "category" "IssuedDocumentCategory" NOT NULL DEFAULT 'OTHER',
    "originalName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssuedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioImage" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "originalMime" TEXT NOT NULL,
    "originalSize" INTEGER NOT NULL,
    "originalSha256" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StudioVersion" (
    "id" TEXT NOT NULL,
    "imageId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "label" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "edits" JSONB NOT NULL,
    "createdById" TEXT,
    "createdByEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StudioVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IssuedDocument_clientId_createdAt_idx" ON "IssuedDocument"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "StudioImage_createdAt_idx" ON "StudioImage"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StudioVersion_imageId_version_key" ON "StudioVersion"("imageId", "version");

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedDocument" ADD CONSTRAINT "IssuedDocument_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StudioVersion" ADD CONSTRAINT "StudioVersion_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "StudioImage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
