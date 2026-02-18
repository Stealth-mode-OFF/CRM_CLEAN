export const AUTOPILOT_QUEUE = "autopilot";

export const JOB_NAMES = {
  processWebhookEvent: "processWebhookEvent",
  slaDealEnforce: "slaDealEnforce",
  leadTriageEnforce: "leadTriageEnforce",
  slaSweep: "slaSweep",
  mergeReview: "mergeReview"
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const AUTOPILOT_PREFIX = "[AUTOPILOT]";
