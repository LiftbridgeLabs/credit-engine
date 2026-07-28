import { useEffect, useState } from "react";
import { Plus, Webhook, Trash2, CheckCircle2, XCircle, Info } from "lucide-react";
import { api, ApiError, type ArrInstance } from "../../lib/api";
import { Badge, Button, Card, ErrorBanner, Input, Spinner } from "../../components/ui";
import { EmptyState } from "../../components/EmptyState";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/toast";

export default function ArrInstancesTab({ serverId }: { serverId: number }) {
  const [instances, setInstances] = useState<ArrInstance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const [type, setType] = useState<"sonarr" | "radarr">("sonarr");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  // No auto-guessed default: "localhost" is essentially never correct here, since Sonarr/Radarr
  // commonly run on a different host/VM than this app — always requires an explicit answer.
  const [callbackBaseUrl, setCallbackBaseUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    try {
      setInstances(await api.get<ArrInstance[]>(`/servers/${serverId}/arr-instances`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load arr instances");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function link() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post(`/servers/${serverId}/arr-instances`, {
        type,
        base_url: baseUrl,
        api_key: apiKey,
        callback_base_url: callbackBaseUrl,
      });
      setAdding(false);
      setBaseUrl("");
      setApiKey("");
      toast(`Linked ${type}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to link");
    } finally {
      setSubmitting(false);
    }
  }

  async function unlink(id: number) {
    if (!confirm("Remove this instance? This also deletes the webhook connection from Sonarr/Radarr.")) return;
    try {
      await api.delete(`/servers/${serverId}/arr-instances/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to unlink");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-sm text-slate-500 bg-slate-100 dark:bg-slate-900 rounded-lg px-3 py-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            This doesn't scan or generate anything itself. It means the moment Sonarr/Radarr imports something
            new, CreditEngine immediately sets it to "don't generate credits" — the same default everything else
            gets — instead of leaving it exposed to Plex's own automatic sweep for up to 2 minutes until the
            periodic safety check catches it. Linking pushes a Webhook connection into Sonarr/Radarr
            automatically; no manual URL copy-pasting.
          </span>
        </div>
        {instances !== null && instances.length > 0 && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)} className="shrink-0">
            Link an instance
          </Button>
        )}
      </div>

      <ErrorBanner message={error} />

      {adding && (
        <Modal title="Link Sonarr/Radarr" onClose={() => setAdding(false)}>
          <div className="space-y-3">
            <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm">
              {(["sonarr", "radarr"] as const).map((t) => (
                <button
                  key={t}
                  className={`flex-1 px-2 py-1.5 rounded-md capitalize transition-colors ${type === t ? "bg-white dark:bg-slate-700 shadow-sm font-medium" : "text-slate-500"}`}
                  onClick={() => setType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Base URL</label>
              <Input placeholder="http://sonarr:8989" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">API key</label>
              <Input value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                This app's address (as {type} would reach it)
              </label>
              <Input
                autoComplete="off"
                placeholder="http://192.168.1.x:8000"
                value={callbackBaseUrl}
                onChange={(e) => setCallbackBaseUrl(e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">
                {type} tests this address when saving the connection, so it must be genuinely reachable
                from wherever {type} runs — "localhost" only works if {type} is on this exact machine.
              </p>
            </div>
            <Button onClick={link} disabled={submitting || !baseUrl || !apiKey || !callbackBaseUrl} className="w-full">
              {submitting ? <Spinner /> : "Link"}
            </Button>
          </div>
        </Modal>
      )}

      {instances === null && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {instances?.length === 0 && (
        <EmptyState
          icon={<Webhook className="h-10 w-10" />}
          title="No Sonarr/Radarr instances linked"
          description="Newly imported content gets disabled immediately, before Plex's own scheduler can catch it."
          action={
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Link an instance
            </Button>
          }
        />
      )}

      <div className="grid gap-2.5">
        {instances?.map((inst) => (
          <Card key={inst.id} className="flex items-center justify-between py-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500">
                <Webhook className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <span className="font-medium capitalize text-slate-900 dark:text-white">{inst.type}</span>
                <div className="text-xs text-slate-500 font-mono truncate">{inst.base_url}</div>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Badge tone={inst.notification_id ? "good" : "bad"}>
                {inst.notification_id ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <XCircle className="h-3 w-3 mr-1" />}
                {inst.notification_id ? "Webhook created" : "Webhook not created"}
              </Badge>
              <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => unlink(inst.id)} />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
