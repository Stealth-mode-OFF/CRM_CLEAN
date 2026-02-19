export type PipedriveEntityType = "deal" | "lead" | "activity";

function normalizeDomain(companyDomain?: string): string {
  if (!companyDomain) {
    return "https://app.pipedrive.com";
  }

  const value = companyDomain.trim();
  if (!value) {
    return "https://app.pipedrive.com";
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    return value.replace(/\/$/, "");
  }

  return `https://${value}.pipedrive.com`;
}

export function buildPipedrivePath(
  entityType: PipedriveEntityType,
  entityId: string | number,
  options: { userId?: string | number } = {}
): string {
  if (entityType === "deal") {
    return `/deal/${entityId}`;
  }

  if (entityType === "lead") {
    return `/leads/inbox/${entityId}`;
  }

  const userId = options.userId ?? "me";
  return `/activities/list/user/${userId}/${entityId}`;
}

export function buildPipedriveUrl(
  entityType: PipedriveEntityType,
  entityId: string | number,
  companyDomain?: string,
  options: { userId?: string | number } = {}
): string {
  const base = normalizeDomain(companyDomain);
  return `${base}${buildPipedrivePath(entityType, entityId, options)}`;
}
