import { useState } from "react";
import { Input } from "./ui";
import { buildCron, parseCron, type Frequency } from "../lib/cron";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function SchedulePicker({ value, onChange }: { value: string | null; onChange: (cron: string | null) => void }) {
  const initial = parseCron(value);
  const [frequency, setFrequency] = useState<Frequency>(initial.frequency);
  const [time, setTime] = useState(initial.time);
  const [dayOfWeek, setDayOfWeek] = useState(initial.dayOfWeek);
  const [raw, setRaw] = useState(initial.raw);

  function update(next: Partial<{ frequency: Frequency; time: string; dayOfWeek: number; raw: string }>) {
    const merged = { frequency, time, dayOfWeek, raw, ...next };
    setFrequency(merged.frequency);
    setTime(merged.time);
    setDayOfWeek(merged.dayOfWeek);
    setRaw(merged.raw);
    onChange(merged.frequency === "custom" ? merged.raw || null : buildCron(merged.frequency, merged.time, merged.dayOfWeek));
  }

  return (
    <div className="space-y-2">
      <label className="block text-sm font-medium mb-1">
        Schedule <span className="font-normal text-slate-400">(CreditEngine's own — independent of Plex's nightly window)</span>
      </label>
      <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm">
        {(["none", "daily", "weekly", "custom"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => update({ frequency: f })}
            className={`flex-1 px-2 py-1.5 rounded-md capitalize transition-colors ${
              frequency === f ? "bg-white dark:bg-slate-700 shadow-sm font-medium" : "text-slate-500"
            }`}
          >
            {f === "none" ? "Manual only" : f}
          </button>
        ))}
      </div>

      {frequency === "daily" && (
        <div className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">Every day at</span>
          <Input type="time" value={time} onChange={(e) => update({ time: e.target.value })} className="w-32" />
        </div>
      )}

      {frequency === "weekly" && (
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-slate-500">Every</span>
          <select
            value={dayOfWeek}
            onChange={(e) => update({ dayOfWeek: Number(e.target.value) })}
            className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
          <span className="text-slate-500">at</span>
          <Input type="time" value={time} onChange={(e) => update({ time: e.target.value })} className="w-32" />
        </div>
      )}

      {frequency === "custom" && (
        <div>
          <Input placeholder="0 3 * * *" value={raw} onChange={(e) => update({ raw: e.target.value })} />
          <p className="text-xs text-slate-500 mt-1">Raw cron expression, for anything the presets above can't express.</p>
        </div>
      )}

      {frequency === "none" && (
        <p className="text-xs text-slate-500">
          Only runs when you click "Apply now" / "Run now" yourself — not tied to Plex's own schedule at all.
        </p>
      )}
    </div>
  );
}
