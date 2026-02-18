const MS_IN_DAY = 24 * 60 * 60 * 1000;

export function toUtcDate(input: Date | string): Date {
  return input instanceof Date ? new Date(input.toISOString()) : new Date(input);
}

export function addBusinessDays(input: Date, businessDays: number): Date {
  const result = new Date(input);
  let remaining = businessDays;

  while (remaining > 0) {
    result.setUTCDate(result.getUTCDate() + 1);
    const day = result.getUTCDay();
    if (day !== 0 && day !== 6) {
      remaining -= 1;
    }
  }

  return result;
}

export function dateToYyyyMmDd(input: Date): string {
  const year = input.getUTCFullYear();
  const month = String(input.getUTCMonth() + 1).padStart(2, "0");
  const day = String(input.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dayKey(date = new Date()): string {
  return dateToYyyyMmDd(date);
}

export type PipedriveActivityLike = {
  due_date?: string | null;
  due_time?: string | null;
  done?: boolean;
};

export function activityDueAtUtc(activity: PipedriveActivityLike): Date | null {
  if (!activity.due_date) {
    return null;
  }

  const dueTime = activity.due_time && activity.due_time.length >= 5 ? activity.due_time : "23:59";
  const date = new Date(`${activity.due_date}T${dueTime}:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export function hasFutureActivity(
  activities: PipedriveActivityLike[],
  now = new Date()
): boolean {
  return activities.some((activity) => {
    if (activity.done) {
      return false;
    }
    const due = activityDueAtUtc(activity);
    return due ? due.getTime() > now.getTime() : false;
  });
}

export function hasActivityWithinDays(
  activities: PipedriveActivityLike[],
  businessDays: number,
  now = new Date()
): boolean {
  const upperBound = addBusinessDays(now, businessDays).getTime() + MS_IN_DAY;
  return activities.some((activity) => {
    if (activity.done) {
      return false;
    }
    const due = activityDueAtUtc(activity);
    if (!due) {
      return false;
    }

    const dueTime = due.getTime();
    return dueTime >= now.getTime() && dueTime <= upperBound;
  });
}
