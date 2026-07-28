const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type Frequency = "none" | "daily" | "weekly" | "custom";

export interface ParsedSchedule {
  frequency: Frequency;
  time: string;
  dayOfWeek: number;
  raw: string;
}

export function parseCron(cron: string | null): ParsedSchedule {
  if (!cron) return { frequency: "none", time: "03:00", dayOfWeek: 0, raw: "" };

  const parts = cron.trim().split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, month, dow] = parts;
    const isNum = (s: string) => /^\d+$/.test(s);
    if (isNum(min) && isNum(hour) && dom === "*" && month === "*" && dow === "*") {
      return { frequency: "daily", time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`, dayOfWeek: 0, raw: cron };
    }
    if (isNum(min) && isNum(hour) && dom === "*" && month === "*" && isNum(dow)) {
      return { frequency: "weekly", time: `${hour.padStart(2, "0")}:${min.padStart(2, "0")}`, dayOfWeek: Number(dow), raw: cron };
    }
  }
  return { frequency: "custom", time: "03:00", dayOfWeek: 0, raw: cron };
}

export function buildCron(frequency: Frequency, time: string, dayOfWeek: number): string | null {
  if (frequency === "none") return null;
  const [hour, min] = time.split(":");
  if (frequency === "daily") return `${Number(min)} ${Number(hour)} * * *`;
  if (frequency === "weekly") return `${Number(min)} ${Number(hour)} * * ${dayOfWeek}`;
  return null;
}

/** For display badges — "CreditEngine's own schedule" label, not Plex's. */
export function formatScheduleLabel(cron: string | null): string {
  const p = parseCron(cron);
  if (p.frequency === "daily") return `Daily at ${p.time}`;
  if (p.frequency === "weekly") return `Weekly on ${DAY_NAMES[p.dayOfWeek]} at ${p.time}`;
  if (p.frequency === "custom") return cron ?? "";
  return "Manual only";
}
