import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Settings2, Info } from "lucide-react";
import { api, ApiError, type AppSettings } from "../lib/api";
import { Button, Card, ErrorBanner, Input, Spinner } from "../components/ui";
import { useToast } from "../components/toast";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [maxEntries, setMaxEntries] = useState(50_000);
  const [retentionDays, setRetentionDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    api
      .get<AppSettings>("/settings/logs")
      .then((s) => {
        setSettings(s);
        setMaxEntries(s.log_max_entries);
        setRetentionDays(s.log_retention_days);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load settings"));
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<AppSettings>("/settings/logs", {
        log_max_entries: maxEntries,
        log_retention_days: retentionDays,
      });
      setSettings(updated);
      toast("Settings saved");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  const dirty = settings !== null && (maxEntries !== settings.log_max_entries || retentionDays !== settings.log_retention_days);

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
          <Settings2 className="h-5 w-5" /> Settings
        </h1>
        <p className="text-sm text-slate-500">App-wide settings — not tied to any one server.</p>
      </div>

      <ErrorBanner message={error} />

      {settings === null && !error && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {settings && (
        <Card className="space-y-4">
          <div>
            <h2 className="font-medium text-slate-900 dark:text-white">Log retention</h2>
            <p className="text-sm text-slate-500">
              Old log entries are pruned automatically, checked every 10 minutes. Whichever limit below is hit
              first is the one that applies.
            </p>
          </div>

          <div className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/50 rounded-lg px-3.5 py-3">
            <Info className="h-4 w-4 mt-0.5 shrink-0 text-slate-400" />
            <p>"Max entries" counts log lines, not megabytes — a rough but reliable stand-in for storage size.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium mb-1">Max entries to keep</label>
              <Input
                type="number"
                min={100}
                step={1000}
                value={maxEntries}
                onChange={(e) => setMaxEntries(Number(e.target.value))}
              />
              <p className="text-xs text-slate-500 mt-1">At least 100.</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Days to keep</label>
              <Input
                type="number"
                min={1}
                value={retentionDays}
                onChange={(e) => setRetentionDays(Number(e.target.value))}
              />
              <p className="text-xs text-slate-500 mt-1">At least 1 day.</p>
            </div>
          </div>

          <Button onClick={save} disabled={saving || !dirty} icon={saving ? <Spinner /> : undefined}>
            Save
          </Button>
        </Card>
      )}
    </div>
  );
}
