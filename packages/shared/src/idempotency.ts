import type { PrismaClient } from "@prisma/client";
import { stableHash } from "./hash.js";

export type IdempotencyAcquireResult = {
  acquired: boolean;
  reason?: "already_done" | "in_progress";
};

export async function acquireIdempotencyKey(
  prisma: PrismaClient,
  scope: string,
  key: string,
  payload: unknown
): Promise<IdempotencyAcquireResult> {
  const requestHash = stableHash(payload);

  try {
    await prisma.idempotencyKey.create({
      data: {
        scope,
        key,
        requestHash,
        status: "started"
      }
    });
    return { acquired: true };
  } catch {
    const existing = await prisma.idempotencyKey.findUnique({
      where: {
        scope_key: { scope, key }
      }
    });

    if (!existing) {
      return { acquired: false, reason: "in_progress" };
    }

    if (existing.status === "done") {
      return { acquired: false, reason: "already_done" };
    }

    if (existing.requestHash === requestHash) {
      return { acquired: false, reason: "in_progress" };
    }

    await prisma.idempotencyKey.update({
      where: { id: existing.id },
      data: { requestHash, status: "started" }
    });

    return { acquired: true };
  }
}

export async function markIdempotencyStatus(
  prisma: PrismaClient,
  scope: string,
  key: string,
  status: "done" | "failed"
): Promise<void> {
  await prisma.idempotencyKey.update({
    where: { scope_key: { scope, key } },
    data: { status }
  });
}
