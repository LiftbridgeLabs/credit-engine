import { useEffect, useState } from "react";
import { RefreshCw, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { api, ApiError, type Diagnostics, type Library, type ServerConnection } from "../../lib/api";
import { Badge, Button, Card, Spinner } from "../../components/ui";

interface Warning {
  tone: "bad" | "warn" | "neutral";
  text: string;
}

function buildWarnings(diag: Diagnostics, server: ServerConnection, libraries: Library[]): Warning[] {
  // Global "never" is a hard master switch — nothing below it matters until it changes, so surface
  // that as the one relevant fact instead of noisy library-level warnings that are currently moot.
  if (diag.global_behavior === "never") {
    return [
      {
        tone: "neutral",
        text: "Global credits generation is fully off (never) — nothing will generate regardless of any per-library or per-item setting. Safe default while testing.",
      },
    ];
  }

  const warnings: Warning[] = [];

  if (!server.credits_control_enabled) {
    warnings.push({
      tone: "bad",
      text: `Plex's global credits setting is "${diag.global_behavior}" even though CreditEngine shows credits control as disabled here — state has drifted (often from re-linking a server, or changing this directly in Plex). Items not yet explicitly disabled are exposed to Plex's own automatic sweep.`,
    });
  }

  if (diag.global_behavior === "asap") {
    warnings.push({
      tone: "warn",
      text: 'Global behavior is "asap" — Plex generates markers immediately as media is scanned or added, not just during the scheduled window. This is more aggressive than "scheduled".',
    });
  }

  // Only libraries you've actually included matter here — a non-included library with detection
  // off isn't a problem, it's often the correct state (nothing routes through it anyway).
  const includedSectionIds = new Set(libraries.filter((l) => l.included).map((l) => l.section_id));
  for (const lib of diag.libraries) {
    if (includedSectionIds.has(lib.section_id) && !lib.credits_detection_enabled) {
      warnings.push({
        tone: "bad",
        text: `"${lib.title}" is included, but credits detection is turned off at the library level in Plex itself — items explicitly enabled here won't generate anything until you turn this on (Plex → Manage Library → Edit → Advanced → Enable credits detection).`,
      });
    }
  }

  if (warnings.length === 0) {
    warnings.push({
      tone: "neutral",
      text: `Plex's own background sweep is active and runs between ${diag.butler_window.start_hour}:00–${diag.butler_window.end_hour}:00. Anything not yet explicitly disabled by the time that window runs could get swept automatically.`,
    });
  }

  return warnings;
}

export function DiagnosticsPanel({ server }: { server: ServerConnection }) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [d, l] = await Promise.all([
        api.get<Diagnostics>(`/servers/${server.id}/diagnostics`),
        api.get<Library[]>(`/servers/${server.id}/libraries`),
      ]);
      setDiag(d);
      setLibraries(l);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load Plex settings");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server.id]);

  const warnings = diag ? buildWarnings(diag, server, libraries) : [];
  const includedSectionIds = new Set(libraries.filter((l) => l.included).map((l) => l.section_id));

  return (
    <Card className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-medium text-slate-900 dark:text-white">Plex configuration</div>
          <p className="text-sm text-slate-500">Live read from Plex — not cached, always current.</p>
        </div>
        <Button variant="ghost" size="sm" icon={<RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />} onClick={load} disabled={loading} />
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {!diag && !error && (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      )}

      {diag && (
        <>
          <div className="flex flex-wrap gap-2">
            <Badge tone={diag.global_behavior === "never" ? "neutral" : "brand"}>
              Global: {diag.global_behavior}
            </Badge>
            <Badge tone={diag.butler_task_enabled ? "brand" : "neutral"}>
              Butler sweep {diag.butler_task_enabled ? "on" : "off"} ({diag.butler_window.start_hour}:00–{diag.butler_window.end_hour}:00)
            </Badge>
            {diag.libraries.map((lib) => {
              const included = includedSectionIds.has(lib.section_id);
              // Detection state only matters (good/bad) for libraries you've included — otherwise it's neutral either way.
              const tone = !included ? "neutral" : lib.credits_detection_enabled ? "good" : "bad";
              return (
                <Badge key={lib.section_id} tone={tone}>
                  {lib.title}
                  {!included && " (not included)"}: {lib.credits_detection_enabled ? "detection on" : "detection off"}
                </Badge>
              );
            })}
          </div>

          {warnings.length > 0 ? (
            <div className="space-y-2">
              {warnings.map((w, i) => {
                const Icon = w.tone === "bad" ? AlertTriangle : w.tone === "warn" ? AlertTriangle : Info;
                const styles = {
                  bad: "bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-300",
                  warn: "bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300",
                  neutral: "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300",
                }[w.tone];
                return (
                  <div key={i} className={`flex items-start gap-2 rounded-lg px-3 py-2.5 text-sm ${styles}`}>
                    <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                    <span>{w.text}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              No issues detected — Plex's settings match what CreditEngine expects.
            </div>
          )}
        </>
      )}
    </Card>
  );
}
