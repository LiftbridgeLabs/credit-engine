import { useEffect, useRef, useState } from "react";
import { Sparkles, Clock, Info } from "lucide-react";
import { api, ApiError, type ServerConnection } from "../../lib/api";
import { Badge, Button, Card, ErrorBanner, Spinner } from "../../components/ui";
import { useToast } from "../../components/toast";
import { DiagnosticsPanel } from "./DiagnosticsPanel";

export default function CreditsControlTab({
  server,
  onServerUpdate,
}: {
  server: ServerConnection;
  onServerUpdate: (s: ServerConnection) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const pollRef = useRef<number | null>(null);
  const toast = useToast();

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  function startPolling() {
    pollRef.current = window.setInterval(async () => {
      const updated = await api.get<ServerConnection>(`/servers/${server.id}`).catch(() => null);
      if (updated?.credits_control_enabled) {
        onServerUpdate(updated);
        setBootstrapping(false);
        toast("Credits control bootstrap complete");
        if (pollRef.current) window.clearInterval(pollRef.current);
      }
    }, 5000);
  }

  async function enable() {
    if (
      !confirm(
        "This disables credits-marker generation on every item across every library on this server, then " +
          "turns Plex's global generation setting on. It runs in the background and can take a few minutes. Continue?",
      )
    )
      return;

    setBusy(true);
    setError(null);
    try {
      await api.post(`/servers/${server.id}/credits-control/enable`);
      setBootstrapping(true);
      startPolling();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to start bootstrap");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!confirm("Turn off Plex's global credits-generation setting? Per-item overrides are left as-is.")) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.post<ServerConnection>(`/servers/${server.id}/credits-control/disable`);
      onServerUpdate(updated);
      toast("Credits control disabled");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to disable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-4">
        <div className="flex items-center gap-3">
          <span
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
              server.credits_control_enabled
                ? "bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-400"
                : "bg-slate-100 dark:bg-slate-800 text-slate-400"
            }`}
          >
            <Sparkles className="h-5 w-5" />
          </span>
          <div className="flex-1">
            <div className="font-medium text-slate-900 dark:text-white">Credits marker control</div>
            <p className="text-sm text-slate-500">
              Disables Plex's automatic credits generation for everything by default; rules selectively
              re-enable it per item.
            </p>
          </div>
          <Badge tone={server.credits_control_enabled ? "good" : "neutral"}>
            {server.credits_control_enabled ? "Enabled" : "Disabled"}
          </Badge>
        </div>

        <div className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-3.5 py-3">
          <Info className="h-4 w-4 mt-0.5 shrink-0 text-slate-400" />
          <div className="space-y-1">
            <p className="font-medium text-slate-700 dark:text-slate-200">What "Enable" actually does to Plex:</p>
            <ol className="list-decimal list-inside space-y-0.5 text-slate-500 dark:text-slate-400">
              <li>Sets every item in every library on this server to "don't generate credits markers for me" (a per-item override, not deleting anything).</li>
              <li>Flips Plex's global "Generate credits video markers" setting from Never to Scheduled.</li>
            </ol>
            <p className="text-slate-500 dark:text-slate-400">
              Net effect: Plex's own background scanner is technically active but harmless, since every item has
              opted out — except whatever you explicitly turn back on via a rule, the library browser, or a watch event.
              On-demand scans (Scan buttons, rules, batches, the Plex webhook) always work immediately, regardless of
              this setting or Plex's own overnight schedule.
            </p>
          </div>
        </div>

        <ErrorBanner message={error} />

        {bootstrapping && (
          <div className="flex items-center gap-2 text-sm text-slate-500 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-3 py-2.5">
            <Spinner /> Bootstrap running in the background — this page updates automatically when it's done.
          </div>
        )}

        {server.credits_control_bootstrapped_at && (
          <p className="text-xs text-slate-500 flex items-center gap-1.5">
            <Clock className="h-3 w-3" />
            Last bootstrapped: {new Date(server.credits_control_bootstrapped_at).toLocaleString()}
          </p>
        )}

        <div>
          {!server.credits_control_enabled ? (
            <Button onClick={enable} disabled={busy || bootstrapping} icon={busy || bootstrapping ? <Spinner /> : undefined}>
              Enable credits control
            </Button>
          ) : (
            <Button variant="danger" onClick={disable} disabled={busy} icon={busy ? <Spinner /> : undefined}>
              Disable credits control
            </Button>
          )}
        </div>
      </Card>

      <DiagnosticsPanel server={server} />
    </div>
  );
}
