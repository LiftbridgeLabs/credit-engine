import { useEffect, useState } from "react";
import { Plus, ListChecks, Play, Trash2, Pencil, Clock, Info } from "lucide-react";
import { api, ApiError, type Library, type ScanRule } from "../../lib/api";
import { Badge, Button, Card, ErrorBanner, Input, Spinner } from "../../components/ui";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { SchedulePicker } from "../../components/SchedulePicker";
import { formatScheduleLabel } from "../../lib/cron";
import { useToast } from "../../components/toast";

type ModalState = "closed" | "new" | ScanRule;

export default function RulesTab({ serverId }: { serverId: number }) {
  const [rules, setRules] = useState<ScanRule[] | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>("closed");
  const [applyResult, setApplyResult] = useState<Record<number, string>>({});
  const [applyTitles, setApplyTitles] = useState<Record<number, string[]>>({});
  const [titlesOpen, setTitlesOpen] = useState<number | null>(null);
  const [applying, setApplying] = useState<number | null>(null);
  const toast = useToast();

  async function load() {
    try {
      const [r, l] = await Promise.all([
        api.get<ScanRule[]>(`/servers/${serverId}/rules`),
        api.get<Library[]>(`/servers/${serverId}/libraries`),
      ]);
      setRules(r);
      setLibraries(l);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load rules");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function applyRule(rule: ScanRule) {
    setApplying(rule.id);
    setApplyResult((prev) => ({ ...prev, [rule.id]: "" }));
    try {
      const result = await api.post<{ enabled_count: number; disabled_count: number; enabled_titles: string[] }>(
        `/servers/${serverId}/rules/${rule.id}/apply`,
      );
      setApplyResult((prev) => ({
        ...prev,
        [rule.id]: `Enabled ${result.enabled_count}, disabled ${result.disabled_count}`,
      }));
      setApplyTitles((prev) => ({ ...prev, [rule.id]: result.enabled_titles }));
      toast(`Applied "${rule.name}"`);
      await load();
    } catch (err) {
      setApplyResult((prev) => ({
        ...prev,
        [rule.id]: err instanceof ApiError ? err.message : "Failed to apply",
      }));
    } finally {
      setApplying(null);
    }
  }

  async function deleteRule(id: number) {
    if (!confirm("Delete this rule?")) return;
    try {
      await api.delete(`/servers/${serverId}/rules/${id}`);
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
            A rule finds items matching its criteria and enables credits generation for them — everything
            else in its target libraries gets disabled again, so items automatically turn back off once they
            stop matching. Applies once when you click "Apply now," or automatically on the schedule you set.
            Right now "recently watched" is the only rule type; more can be added later.
          </span>
        </div>
        {rules !== null && rules.length > 0 && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal("new")} className="shrink-0">
            New rule
          </Button>
        )}
      </div>

      <ErrorBanner message={error} />

      {modal !== "closed" && (
        <RuleModal
          serverId={serverId}
          libraries={libraries}
          rule={modal === "new" ? null : modal}
          onClose={() => setModal("closed")}
          onSaved={() => {
            setModal("closed");
            load();
          }}
        />
      )}

      {rules === null && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {rules?.length === 0 && (
        <EmptyState
          icon={<ListChecks className="h-10 w-10" />}
          title="No rules yet"
          description='e.g. "recently watched, last 30 days" — automatically re-enables and disables items as they match.'
          action={
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setModal("new")}>
              New rule
            </Button>
          }
        />
      )}

      <div className="grid gap-2.5">
        {rules?.map((rule) => (
          <Card key={rule.id} className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-slate-900 dark:text-white">{rule.name}</div>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  <Badge tone="brand">recently watched, {rule.criteria.days}d</Badge>
                  <Badge>
                    <Clock className="h-3 w-3 mr-1" />
                    {formatScheduleLabel(rule.schedule_cron)}
                  </Badge>
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  icon={applying === rule.id ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
                  onClick={() => applyRule(rule)}
                  disabled={applying === rule.id}
                >
                  Apply now
                </Button>
                <Button size="sm" variant="secondary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setModal(rule)} />
                <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => deleteRule(rule.id)} />
              </div>
            </div>
            {applyResult[rule.id] && (
              <div className="text-xs text-slate-500">
                <span>{applyResult[rule.id]}</span>
                {applyTitles[rule.id]?.length > 0 && (
                  <>
                    {" — "}
                    <button
                      className="text-brand-600 dark:text-brand-400 hover:underline"
                      onClick={() => setTitlesOpen(titlesOpen === rule.id ? null : rule.id)}
                    >
                      {titlesOpen === rule.id ? "hide titles" : "show what was enabled"}
                    </button>
                    {titlesOpen === rule.id && (
                      <ul className="mt-1.5 space-y-0.5 max-h-40 overflow-y-auto rounded-md bg-slate-50 dark:bg-slate-800/50 px-2.5 py-1.5">
                        {applyTitles[rule.id].map((t, i) => (
                          <li key={i} className="truncate">{t}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
            {rule.last_run_at && (
              <p className="text-xs text-slate-500">Last applied: {new Date(rule.last_run_at).toLocaleString()}</p>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}

function RuleModal({
  serverId,
  libraries,
  rule,
  onClose,
  onSaved,
}: {
  serverId: number;
  libraries: Library[];
  rule: ScanRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = rule !== null;
  const [name, setName] = useState(rule?.name ?? "");
  const [days, setDays] = useState(rule?.criteria.days ?? 30);
  const [libraryIds, setLibraryIds] = useState<number[]>(rule?.criteria.library_ids ?? []);
  const [cron, setCron] = useState<string | null>(rule?.schedule_cron ?? null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function toggleLibrary(id: number) {
    setLibraryIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    const body = {
      name,
      enabled: true,
      criteria: { type: "recently_watched", days, library_ids: libraryIds },
      schedule_cron: cron,
    };
    try {
      if (isEdit) {
        await api.patch(`/servers/${serverId}/rules/${rule.id}`, body);
        toast(`Rule "${name}" updated`);
      } else {
        await api.post(`/servers/${serverId}/rules`, body);
        toast(`Rule "${name}" created`);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to save rule");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal title={isEdit ? "Edit rule" : "New rule"} onClose={onClose}>
      <div className="space-y-3">
        <ErrorBanner message={error} />
        <div>
          <label className="block text-sm font-medium mb-1">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Recently watched within (days)</label>
          <Input type="number" min={1} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Libraries</label>
          <div className="flex flex-wrap gap-2">
            {libraries.map((lib) => (
              <button
                key={lib.id}
                type="button"
                onClick={() => toggleLibrary(lib.id)}
                className={`px-2.5 py-1 rounded-md text-sm transition-colors ${
                  libraryIds.includes(lib.id)
                    ? "bg-brand-600 text-white"
                    : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300"
                }`}
              >
                {lib.title}
              </button>
            ))}
            {libraries.length === 0 && (
              <span className="text-sm text-slate-500">No libraries synced — sync them in the Libraries tab first.</span>
            )}
          </div>
        </div>
        <SchedulePicker value={cron} onChange={setCron} />
        <Button onClick={submit} disabled={submitting || !name || libraryIds.length === 0} className="w-full">
          {submitting ? <Spinner /> : isEdit ? "Save changes" : "Create rule"}
        </Button>
      </div>
    </Modal>
  );
}
