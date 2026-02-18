import { Queue } from "bullmq";
import { AUTOPILOT_QUEUE } from "@autopilot/shared";

export function createQueue(redisUrl: string): Queue {
  return new Queue(AUTOPILOT_QUEUE, {
    connection: {
      url: redisUrl
    },
    defaultJobOptions: {
      attempts: 5,
      removeOnComplete: true,
      backoff: {
        type: "exponential",
        delay: 500
      }
    }
  });
}
