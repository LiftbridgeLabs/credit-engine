import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ScrollText, Pause, Play, Trash2, Info } from "lucide-react";
import { api, ApiError, type LogEntry, type LogLevel } from "../lib/api";
import { Badge, Button, ErrorBanner } from "../components/ui";

const LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

const LEVEL_TONE: Record<LogLevel, "neutral" | "brand" | "warn" | "bad"> = {
  DEBUG: "neutral",
  INFO: "brand",
  WARNING: "warn",
  ERROR: "bad",
  CRITICAL: "bad",
};

// Tuned for the console's own dark background, which it keeps in both themes — see the panel
// below for why it isn't a Card.
const LEVEL_TEXT_COLOR: Record<LogLevel, string> = {
  DEBUG: "text-slate-400",
  INFO: "text-slate-100",
  WARNING: "text-amber-300",
  ERROR: "text-red-300",
  CRITICAL: "text-red-300",
};

// Anything longer than this, or containing newlines, is collapsed to its first line behind a
// toggle. A single Celery traceback is ~60 lines and would otherwise push everything else out of
// view — which is exactly what makes the interesting entry impossible to find.
const COLLAPSE_OVER_CHARS = 200;

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const long = entry.message.includes("\n") || entry.message.length > COLLAPSE_OVER_CHARS;
  const firstLine = entry.message.split("\n", 1)[0];

  return (
    <div className="py-0.5 border-b border-slate-900/70 last:border-0">
      <div className="flex gap-2 items-baseline">
        <span className="text-slate-500 shrink-0 tabular-nums">
          {new Date(entry.created_at).toLocaleTimeString()}
        </span>
        <span className="shrink-0">
          <Badge tone={LEVEL_TONE[entry.level]}>{entry.level}</Badge>
        </span>
        <span className="text-slate-500 shrink-0">{entry.logger_name}</span>
        <span className={`${LEVEL_TEXT_COLOR[entry.level]} ${long ? "truncate" : "break-words"} min-w-0`}>
          {long ? firstLine : entry.message}
        </span>
        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 ml-auto text-slate-400 hover:text-slate-200 underline decoration-dotted"
          >
            {expanded ? "hide" : "details"}
          </button>
        )}
      </div>
      {long && expanded && (
        // whitespace-pre-wrap keeps a traceback's line structure; break-words wraps only at word
        // boundaries, where break-all used to split identifiers mid-character into noise.
        <pre className={`${LEVEL_TEXT_COLOR[entry.level]} whitespace-pre-wrap break-words mt-1 mb-2 pl-2 border-l-2 border-slate-700`}>
          {entry.message}
        </pre>
      )}
    </div>
  );
}

// Keep the rendered list bounded — a long overnight session at Debug level could otherwise grow
// the DOM without limit even though the underlying table is already capped by retention settings.
const MAX_RENDERED = 1000;

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [level, setLevel] = useState<LogLevel>("INFO");
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const sinceIdRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  async function loadInitial() {
    try {
      const rows = await api.get<LogEntry[]>(`/logs?level=${level}`);
      setEntries(rows);
      sinceIdRef.current = rows.length > 0 ? rows[rows.length - 1].id : 0;
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load logs");
    }
  }

  async function poll() {
    if (pausedRef.current) return;
    try {
      const rows = await api.get<LogEntry[]>(`/logs?level=${level}&since_id=${sinceIdRef.current}`);
      if (rows.length === 0) return;
      sinceIdRef.current = rows[rows.length - 1].id;
      setEntries((prev) => [...prev, ...rows].slice(-MAX_RENDERED));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to poll logs");
    }
  }

  useEffect(() => {
    loadInitial();
    const interval = window.setInterval(poll, 2000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [level]);

  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries, paused]);

  async function clearLogs() {
    if (!confirm("Clear all stored logs? This can't be undone.")) return;
    setClearing(true);
    try {
      await api.delete("/logs");
      setEntries([]);
      sinceIdRef.current = 0;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to clear logs");
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          to="/servers"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All servers
        </Link>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white flex items-center gap-2">
          <ScrollText className="h-5 w-5" /> Logs
        </h1>
        <p className="text-sm text-slate-500">
          Everything CreditEngine does across every server — bootstraps, rule applies, scans, and webhook
          activity. Updates live every couple seconds; pause to freeze the view without losing anything.
          Almost everything is logged at INFO — Debug adds only a couple of internal messages, so it will
          look much the same.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel)}
          className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
        >
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}+
            </option>
          ))}
        </select>
        <Button
          variant="secondary"
          size="sm"
          icon={paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          onClick={() => setPaused((p) => !p)}
        >
          {paused ? "Resume" : "Pause"}
        </Button>
        <div className="flex-1" />
        <Button
          variant="danger"
          size="sm"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={clearLogs}
          disabled={clearing}
        >
          Clear logs
        </Button>
      </div>

      <ErrorBanner message={error} />

      {paused && (
        <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/50 rounded-lg px-3 py-2">
          <Info className="h-4 w-4 shrink-0" />
          Paused — new entries are still being recorded, just not shown here until you resume.
        </div>
      )}

      {/* Deliberately not a Card: Card hardcodes `bg-white dark:bg-slate-900`, and a `bg-slate-950`
          passed through className competes with it in the same Tailwind layer rather than
          overriding it — so this panel used to render white in light mode while its text colours
          were chosen for a dark background, which is what made it unreadable. A console stays a
          console in both themes. */}
      <div className="rounded-xl border border-slate-800 bg-slate-950 shadow-sm overflow-hidden">
        <div className="max-h-[65vh] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed">
          {entries.length === 0 && <p className="text-slate-500">No log entries at this level yet.</p>}
          {entries.map((e) => (
            <LogRow key={e.id} entry={e} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
