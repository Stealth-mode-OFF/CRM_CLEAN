export type LeadScoreLead = {
  add_time?: string;
  label_ids?: string[] | null;
};

export type LeadScorePerson = {
  email?: Array<{ value?: string }>;
  phone?: Array<{ value?: string }>;
};

export type LeadScoreOrg = {
  website?: string | null;
  domain?: string | null;
  web?: string | null;
};

function hasRecentCreatedAt(addTime: string | undefined, days: number): boolean {
  if (!addTime) {
    return false;
  }

  const createdAt = Date.parse(addTime);
  if (Number.isNaN(createdAt)) {
    return false;
  }

  const ageMs = Date.now() - createdAt;
  return ageMs <= days * 24 * 60 * 60 * 1000;
}

function hasPersonEmail(person: LeadScorePerson | null | undefined): boolean {
  return Boolean(person?.email?.some((entry) => typeof entry.value === "string" && entry.value.includes("@")));
}

function hasPersonPhone(person: LeadScorePerson | null | undefined): boolean {
  return Boolean(person?.phone?.some((entry) => typeof entry.value === "string" && entry.value.trim() !== ""));
}

function hasOrgDomain(org: LeadScoreOrg | null | undefined): boolean {
  const candidates = [org?.domain, org?.website, org?.web];
  return candidates.some((value) => typeof value === "string" && value.includes("."));
}

export function scoreLead(
  lead: LeadScoreLead,
  person?: LeadScorePerson | null,
  org?: LeadScoreOrg | null
): number {
  let score = 0;

  if (hasPersonEmail(person)) {
    score += 30;
  }

  if (org) {
    score += 20;
  }

  if (hasOrgDomain(org)) {
    score += 15;
  }

  if (hasRecentCreatedAt(lead.add_time, 7)) {
    score += 10;
  }

  if (Array.isArray(lead.label_ids) && lead.label_ids.length > 0) {
    score += 10;
  }

  if (hasPersonPhone(person)) {
    score += 15;
  }

  return Math.max(0, Math.min(100, score));
}
