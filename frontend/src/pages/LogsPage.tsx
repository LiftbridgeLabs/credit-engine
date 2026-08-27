import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, ScrollText, Pause, Play, Trash2, Info } from "lucide-react";
import { api, ApiError, type LogEntry, type LogLevel } from "../lib/api";
import { Button, ErrorBanner } from "../components/ui";

const LEVELS: LogLevel[] = ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"];

// Short, fixed-width labels so the level column lines up and the eye can scan straight down it.
// A full-width Badge pill per row was heavier than the message it was labelling.
const LEVEL_LABEL: Record<LogLevel, string> = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARNING: "WARN",
  ERROR: "ERROR",
  CRITICAL: "CRIT",
};

// Readable on the page's own background in both themes. The previous attempt forced a dark
// console into a light app, which fixed the contrast bug but left the panel fighting everything
// around it — and still rendered small, unaligned grey-on-dark text.
const LEVEL_COLOR: Record<LogLevel, string> = {
  DEBUG: "text-slate-400 dark:text-slate-500",
  INFO: "text-sky-600 dark:text-sky-400",
  WARNING: "text-amber-600 dark:text-amber-400",
  ERROR: "text-red-600 dark:text-red-400",
  CRITICAL: "text-red-600 dark:text-red-400",
};

const MESSAGE_COLOR: Record<LogLevel, string> = {
  DEBUG: "text-slate-500 dark:text-slate-400",
  INFO: "text-slate-800 dark:text-slate-100",
  WARNING: "text-amber-700 dark:text-amber-300",
  ERROR: "text-red-700 dark:text-red-300",
  CRITICAL: "text-red-700 dark:text-red-300",
};

// Anything longer than this, or containing newlines, collapses to its first line behind a toggle.
// A single Celery traceback is ~60 lines and would otherwise push every other entry out of view,
// which is exactly what makes the interesting one impossible to find.
const COLLAPSE_OVER_CHARS = 200;

// Keep the rendered list bounded — a long overnight session at Debug level could otherwise grow
// the DOM without limit even though the underlying table is already capped by retention settings.
const MAX_RENDERED = 1000;

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const long = entry.message.includes("\n") || entry.message.length > COLLAPSE_OVER_CHARS;
  const firstLine = entry.message.split("\n", 1)[0];

  return (
    <div className="border-b border-slate-100 dark:border-slate-800/70 last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/40">
      <div className="flex gap-3 px-3 py-1.5 items-baseline">
        <time className="shrink-0 w-[5.5rem] tabular-nums text-slate-400 dark:text-slate-500">
          {new Date(entry.created_at).toLocaleTimeString()}
        </time>
        <span className={`shrink-0 w-12 font-semibold ${LEVEL_COLOR[entry.level]}`}>
          {LEVEL_LABEL[entry.level]}
        </span>
        <span className="shrink-0 w-44 truncate text-slate-400 dark:text-slate-500 hidden md:block">
          {entry.logger_name}
        </span>
        <span className={`min-w-0 flex-1 ${MESSAGE_COLOR[entry.level]} ${long ? "truncate" : "break-words"}`}>
          {long ? firstLine : entry.message}
        </span>
        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="shrink-0 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 underline decoration-dotted"
          >
            {expanded ? "hide" : "details"}
          </button>
        )}
      </div>
      {long && expanded && (
        // whitespace-pre-wrap keeps a traceback's line structure; break-words wraps at word
        // boundaries, where break-all used to split identifiers mid-character into noise.
        <pre
          className={`${MESSAGE_COLOR[entry.level]} whitespace-pre-wrap break-words mx-3 mb-2 pl-3 border-l-2 border-slate-200 dark:border-slate-700`}
        >
          {entry.message}
        </pre>
      )}
    </div>
  );
}

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
          Everything CreditEngine does across every server. Updates live; pause to freeze the view
          without losing anything.
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
        <span className="text-xs text-slate-400 hidden sm:inline">
          almost everything is logged at INFO
        </span>
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

      {/* Deliberately not a Card: Card hardcodes `bg-white dark:bg-slate-900`, and a background
          passed through className competes with it in the same Tailwind layer rather than
          overriding it — which is what left this panel unreadable in the first place. */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm overflow-hidden">
        <div className="max-h-[65vh] overflow-y-auto font-mono text-[13px] leading-6">
          {entries.length === 0 && (
            <p className="px-3 py-3 text-slate-500 dark:text-slate-400">No log entries at this level yet.</p>
          )}
          {entries.map((e) => (
            <LogRow key={e.id} entry={e} />
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
