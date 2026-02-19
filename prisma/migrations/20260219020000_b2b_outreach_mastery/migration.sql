-- CreateTable
CREATE TABLE "MergeCandidate" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "sourceId" INTEGER NOT NULL,
    "targetId" INTEGER NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "status" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MergeCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealSnapshot" (
    "id" TEXT NOT NULL,
    "dealId" INTEGER NOT NULL,
    "stageId" INTEGER NOT NULL,
    "pipelineId" INTEGER,
    "value" DOUBLE PRECISION,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DealSnapshot_dealId_snapshotAt_idx" ON "DealSnapshot"("dealId", "snapshotAt");
