import { useEffect, useState } from "react";
import { Plus, Layers, Play, Trash2, Pencil, Clock, Info, X } from "lucide-react";
import { api, ApiError, type ScanBatch } from "../../lib/api";
import { Badge, Button, Card, ErrorBanner, Input, Spinner } from "../../components/ui";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { ItemPicker, type PickedItem } from "../../components/ItemPicker";
import { SchedulePicker } from "../../components/SchedulePicker";
import { formatScheduleLabel } from "../../lib/cron";
import { useToast } from "../../components/toast";

type ModalState = "closed" | "new" | ScanBatch;

export default function BatchesTab({ serverId }: { serverId: number }) {
  const [batches, setBatches] = useState<ScanBatch[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>("closed");
  const [runResult, setRunResult] = useState<Record<number, string>>({});
  const [running, setRunning] = useState<number | null>(null);
  const toast = useToast();

  async function load() {
    try {
      setBatches(await api.get<ScanBatch[]>(`/servers/${serverId}/batches`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load batches");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function runBatch(batch: ScanBatch) {
    setRunning(batch.id);
    setRunResult((prev) => ({ ...prev, [batch.id]: "" }));
    try {
      const result = await api.post<{ queued: number }>(`/servers/${serverId}/batches/${batch.id}/run`);
      setRunResult((prev) => ({ ...prev, [batch.id]: `Queued ${result.queued} scan jobs` }));
      toast(`Ran "${batch.name}"`);
      await load();
    } catch (err) {
      setRunResult((prev) => ({ ...prev, [batch.id]: err instanceof ApiError ? err.message : "Failed to run" }));
    } finally {
      setRunning(null);
    }
  }

  async function deleteBatch(id: number) {
    if (!confirm("Delete this batch?")) return;
    try {
      await api.delete(`/servers/${serverId}/batches/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-sm text-slate-500 bg-slate-100 dark:bg-slate-900 rounded-lg px-3 py-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            A batch is a fixed list of specific movies/shows/episodes to scan — useful for a curated set you
            want to keep re-running on a schedule.
          </span>
        </div>
        {batches !== null && batches.length > 0 && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal("new")} className="shrink-0">
            New batch
          </Button>
        )}
      </div>

      <ErrorBanner message={error} />

      {modal !== "closed" && (
        <BatchModal
          serverId={serverId}
          batch={modal === "new" ? null : modal}
          onClose={() => setModal("closed")}
          onSaved={() => {
            setModal("closed");
            load();
          }}
        />
      )}

      {batches === null && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {batches?.length === 0 && (
        <EmptyState
          icon={<Layers className="h-10 w-10" />}
          title="No batches yet"
          description="A curated set of items you can run on demand or on a schedule."
          action={
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal("new")}>
              New batch
            </Button>
          }
        />
      )}

      <div className="grid gap-2.5">
        {batches?.map((batch) => (
          <Card key={batch.id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-slate-900 dark:text-white">{batch.name}</div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  <Badge>{batch.rating_keys.length} items</Badge>
                  <Badge>
                    <Clock className="h-3 w-3 mr-1" />
                    {formatScheduleLabel(batch.schedule_cron)}
                  </Badge>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  icon={running === batch.id ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
                  onClick={() => runBatch(batch)}
                  disabled={running === batch.id}
                >
                  Run now
                </Button>
                <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setModal(batch)} />
                <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => deleteBatch(batch.id)} />
              </div>
            </div>
            {runResult[batch.id] && <p className="text-xs text-slate-500">{runResult[batch.id]}</p>}
            {batch.last_run_at && (
              <p className="text-xs text-slate-500">Last run: {new Date(batch.last_run_at).toLocaleString()}</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function BatchModal({
  serverId,
  batch,
  onClose,
  onSaved,
}: {
  serverId: number;
  batch: ScanBatch | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = batch !== null;
  const [name, setName] = useState(batch?.name ?? "");
  // Editing an existing batch: we only stored rating keys, not titles, so pre-existing items show
  // a fallback label until re-picked. New items added via the picker get real titles.
  const [picked, setPicked] = useState<PickedItem[]>(
    batch?.rating_keys.map((k) => ({ rating_key: k, title: `rating key ${k}` })) ?? [],
  );
  const [cron, setCron] = useState<string | null>(batch?.schedule_cron ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function togglePicked(item: PickedItem) {
    setPicked((prev) =>
      prev.some((p) => p.rating_key === item.rating_key) ? prev.filter((p) => p.rating_key !== item.rating_key) : [...prev, item],
    );
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    const body = { name, rating_keys: picked.map((p) => p.rating_key), schedule_cron: cron };
    try {
      if (isEdit) {
        await api.patch(`/servers/${serverId}/batches/${batch.id}`, body);
        toast(`Batch "${name}" updated`);
      } else {
        await api.post(`/servers/${serverId}/batches`, body);
        toast(`Batch "${name}" created`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save batch");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit batch" : "New batch"} onClose={onClose}>
      <div className="space-y-3">
        <ErrorBanner message={error} />
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">
            Items {picked.length > 0 && <span className="text-slate-400 font-normal">({picked.length} selected)</span>}
          </label>
          {picked.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {picked.map((p) => (
                <span
                  key={p.rating_key}
                  className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-md bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300 text-xs"
                >
                  {p.title}
                  <button onClick={() => togglePicked(p)} className="hover:text-brand-900 dark:hover:text-brand-100">
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <ItemPicker serverId={serverId} onPick={togglePicked} pickedKeys={new Set(picked.map((p) => p.rating_key))} />
        </div>

        <SchedulePicker value={cron} onChange={setCron} />
        <Button onClick={submit} disabled={submitting || !name || picked.length === 0} className="w-full">
          {submitting ? <Spinner /> : isEdit ? "Save changes" : "Create batch"}
        </Button>
      </div>
    </Modal>
  );
}
