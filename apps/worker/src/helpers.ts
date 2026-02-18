import { AUTOPILOT_PREFIX } from "@autopilot/shared";

export type ParsedWebhook =
  | { type: "deal"; id: number; action?: string }
  | { type: "lead"; id: string; action?: string }
  | { type: "unknown"; action?: string };

function parseNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

export function parseWebhookPayload(payload: unknown): ParsedWebhook {
  if (!payload || typeof payload !== "object") {
    return { type: "unknown" };
  }

  const value = payload as Record<string, unknown>;
  const meta = (value.meta as Record<string, unknown> | undefined) ?? {};
  const object = String(meta.object ?? value.object ?? "").toLowerCase();
  const action = String(meta.action ?? value.action ?? "").toLowerCase();

  const current = (value.current as Record<string, unknown> | undefined) ??
    (value.data as Record<string, unknown> | undefined) ??
    {};

  if (object === "deal" || object === "deals") {
    const id = parseNumber(current.id ?? value.id);
    if (id !== null) {
      return { type: "deal", id, action };
    }
  }

  if (object === "lead" || object === "leads") {
    const id = current.id ?? value.id;
    if (typeof id === "string" && id.trim()) {
      return { type: "lead", id, action };
    }
  }

  const dealId = parseNumber(value.deal_id ?? current.deal_id ?? current.id);
  if (dealId !== null && (String(value.event ?? "").includes("deal") || String(meta.object ?? "").includes("deal"))) {
    return { type: "deal", id: dealId, action };
  }

  const leadId = value.lead_id ?? current.lead_id ?? current.id;
  if (typeof leadId === "string" && leadId.trim()) {
    return { type: "lead", id: leadId, action };
  }

  return { type: "unknown", action };
}

export function stageAllowed(activeStageIds: number[] | undefined, stageId: unknown): boolean {
  if (!activeStageIds || activeStageIds.length === 0) {
    return true;
  }
  if (typeof stageId !== "number") {
    return false;
  }
  return activeStageIds.includes(stageId);
}

export function asPersonOrOrgId(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value === "object" && "value" in value) {
    const maybe = (value as { value?: unknown }).value;
    if (typeof maybe === "number") {
      return maybe;
    }
  }
  return undefined;
}

export function hasAutopilotPrefix(content: string | null | undefined): boolean {
  if (!content) {
    return false;
  }
  return content.includes(AUTOPILOT_PREFIX);
}
