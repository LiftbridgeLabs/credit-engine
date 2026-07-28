import { useEffect, useState } from "react";
import { ScanLine, Clock, Loader2, CheckCircle2, XCircle, Plus, ChevronDown } from "lucide-react";
import { api, ApiError, type ScanJob } from "../../lib/api";
import { Badge, Button, Card, ErrorBanner, Input, Spinner } from "../../components/ui";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { ItemPicker, type PickedItem } from "../../components/ItemPicker";
import { useToast } from "../../components/toast";

const statusTone: Record<ScanJob["status"], "neutral" | "good" | "bad"> = {
  pending: "neutral",
  running: "neutral",
  complete: "good",
  failed: "bad",
};

const statusIcon: Record<ScanJob["status"], typeof Clock> = {
  pending: Clock,
  running: Loader2,
  complete: CheckCircle2,
  failed: XCircle,
};

export default function ScansTab({ serverId }: { serverId: number }) {
  const [jobs, setJobs] = useState<ScanJob[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [ratingKey, setRatingKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  async function load() {
    try {
      setJobs(await api.get<ScanJob[]>(`/servers/${serverId}/scans`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load scans");
    }
  }

  useEffect(() => {
    load();
    const interval = window.setInterval(load, 5000);
    return () => window.clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function queueScanKey(key: number, label: string) {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/servers/${serverId}/scans?rating_key=${key}`);
      toast(`Queued scan for ${label}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to queue scan");
    } finally {
      setSubmitting(false);
    }
  }

  async function pick(item: PickedItem) {
    setPicking(false);
    await queueScanKey(item.rating_key, item.title);
  }

  async function queueManual() {
    await queueScanKey(Number(ratingKey), `rating key ${ratingKey}`);
    setRatingKey("");
  }

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-slate-500">
            A "scan" is CreditEngine telling Plex to analyze one item and generate its credits marker — this is the
            history of every time that happened, whether you queued it here, a rule or batch triggered it, or it
            fired automatically when someone started watching. Check here if you want to confirm a scan actually
            worked.
          </p>
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setPicking(true)} disabled={submitting}>
            Queue a scan
          </Button>
        </div>

        <button
          onClick={() => setAdvancedOpen(!advancedOpen)}
          className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
        >
          <ChevronDown className={`h-3 w-3 transition-transform ${advancedOpen ? "" : "-rotate-90"}`} />
          Advanced: enter a rating key directly
        </button>
        {advancedOpen && (
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Rating key</label>
              <Input placeholder="38129" value={ratingKey} onChange={(e) => setRatingKey(e.target.value)} />
              <p className="text-xs text-slate-500 mt-1">Plex's internal numeric ID for an item — the picker above finds this for you.</p>
            </div>
            <Button icon={submitting ? <Spinner /> : <ScanLine className="h-3.5 w-3.5" />} onClick={queueManual} disabled={submitting || !ratingKey}>
              Queue
            </Button>
          </div>
        )}
      </Card>

      {picking && (
        <Modal title="Pick something to scan" onClose={() => setPicking(false)}>
          <ItemPicker serverId={serverId} onPick={pick} pickedKeys={new Set()} />
        </Modal>
      )}

      <ErrorBanner message={error} />

      {jobs === null && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {jobs?.length === 0 && (
        <EmptyState icon={<ScanLine className="h-10 w-10" />} title="No scans yet" description="Scans queued here, via rules, batches, or the library browser will show up." />
      )}

      <div className="grid gap-2">
        {jobs?.map((job) => {
          const StatusIcon = statusIcon[job.status];
          return (
            <Card key={job.id} className="flex items-center justify-between py-2.5">
              <div className="min-w-0">
                <span className="font-medium text-slate-900 dark:text-white text-sm truncate">
                  {job.title ?? `rating key ${job.rating_key}`}
                </span>{" "}
                <span className="text-xs text-slate-500">{new Date(job.created_at).toLocaleString()}</span>
                {job.error && <p className="text-xs text-red-600 dark:text-red-400 truncate">{job.error}</p>}
              </div>
              <Badge tone={statusTone[job.status]}>
                <StatusIcon className={`h-3 w-3 mr-1 ${job.status === "running" ? "animate-spin" : ""}`} />
                {job.status}
              </Badge>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
