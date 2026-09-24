import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Eye, RefreshCw, Trash2 } from "lucide-react";
import { api, ApiError, type PlexWebhookStatus, type ServerConnection } from "../../lib/api";
import { Badge, Button, Card, ErrorBanner, Input, Spinner } from "../../components/ui";
import { useToast } from "../../components/toast";

function timeAgo(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** How Plex tells this app that something was played — the only thing that turns "I started
 * watching a show" into "its credits get generated". It fails silently when the address Plex has
 * on file stops being valid (the app moved, changed port, gained a path prefix), which looks
 * exactly like it working and never having anything to do — so this shows the delivery record,
 * not just the configuration. */
export function PlexWebhookCard({ server }: { server: ServerConnection }) {
  // Plex must reach this app at whatever address the *browser* is using to reach it now — the app
  // itself can't know that (proxies, port mappings), so it's the default and stays editable.
  const [baseUrl, setBaseUrl] = useState(window.location.origin);
  const [status, setStatus] = useState<PlexWebhookStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A re-check that finds nothing new changes nothing on screen, which reads as a dead button — so
  // it shows that it's working, and when it last finished.
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [revealed, setRevealed] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setChecking(true);
    try {
      setStatus(
        await api.get<PlexWebhookStatus>(
          `/servers/${server.id}/plex-webhook?callback_base_url=${encodeURIComponent(baseUrl)}`,
        ),
      );
      setError(null);
      setCheckedAt(new Date());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to check the Plex webhook");
    } finally {
      setChecking(false);
    }
  }, [server.id, baseUrl]);

  useEffect(() => {
    load();
  }, [load]);

  async function register() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/servers/${server.id}/plex-webhook/register`, { callback_base_url: baseUrl });
      toast("Webhook added to your Plex account");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to register the webhook");
    } finally {
      setBusy(false);
    }
  }

  async function remove(hookId: string, shown: string) {
    if (
      !confirm(
        `Remove this webhook from your Plex account?\n\n${shown}\n\nIf it points at a second CreditEngine ` +
          "that's still in use, that one will stop hearing about plays.",
      )
    )
      return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/servers/${server.id}/plex-webhook/remove`, { hook_id: hookId });
      toast("Webhook removed");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to remove the webhook");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    const text = status?.expected_url ?? "";
    try {
      // Only exists on secure origins — a LAN address over plain http (the usual way this is
      // reached) doesn't count, so this is expected to fall through to the select-and-copy path.
      await navigator.clipboard.writeText(text);
      toast("Copied");
    } catch {
      setRevealed(true);
      window.setTimeout(() => {
        urlRef.current?.select();
        document.execCommand("copy");
        toast("Copied — or press Ctrl+C if your browser blocked it");
      }, 0);
    }
  }

  const lastEvent = server.plex_webhook_last_event_at ?? status?.last_event_at ?? null;
  const lastEventLabel = status?.last_event ?? server.plex_webhook_last_event;

  let badge: { tone: "good" | "warn" | "bad" | "neutral"; text: string } = { tone: "neutral", text: "Checking…" };
  if (status) {
    if (lastEvent) badge = { tone: "good", text: `Last play ${timeAgo(lastEvent)}` };
    else if (status.registered) badge = { tone: "warn", text: "Registered — no plays received yet" };
    else if (status.registered === false) badge = { tone: "bad", text: "Not registered in Plex" };
    else badge = { tone: "warn", text: "Never received a play" };
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="font-medium text-slate-900 dark:text-white">Watch webhook</div>
          <p className="text-sm text-slate-500">
            How Plex tells CreditEngine that you started playing something, so that show gets its credits
            generated. Only real playback counts — marking things as watched in Plex sends nothing.
          </p>
        </div>
        <Badge tone={badge.tone}>{badge.text}</Badge>
      </div>

      <ErrorBanner message={error ?? status?.error ?? null} />

      {lastEvent && (
        <p className="text-xs text-slate-500">
          Most recent event: <span className="font-mono">{lastEventLabel}</span> · {new Date(lastEvent).toLocaleString()}
        </p>
      )}

      {status?.registered === false && !lastEvent && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Plex isn't set to call this app, so watching things can't trigger anything. Register it below.
        </p>
      )}

      <div>
        <label className="block text-sm font-medium mb-1">Address Plex should use to reach CreditEngine</label>
        <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://192.168.1.x:5173" />
        <p className="text-xs text-slate-500 mt-1">
          Defaults to the address you're using right now. Change it if Plex reaches this app some other way
          (a reverse proxy, a different hostname).
        </p>
      </div>

      {status && (
        <div>
          <label className="block text-sm font-medium mb-1">Webhook URL</label>
          <div className="flex gap-2">
            <Input
              ref={urlRef}
              readOnly
              type={revealed ? "text" : "password"}
              value={status.expected_url}
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <Button variant="secondary" size="sm" icon={<Eye className="h-3.5 w-3.5" />} onClick={() => setRevealed((v) => !v)}>
              {revealed ? "Hide" : "Show"}
            </Button>
            <Button variant="secondary" size="sm" icon={<Copy className="h-3.5 w-3.5" />} onClick={copy}>
              Copy
            </Button>
          </div>
          <p className="text-xs text-slate-500 mt-1">Contains this server's secret — hidden until you ask.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {status?.can_manage && (
          <Button
            onClick={register}
            disabled={busy || status.registered === true}
            icon={busy ? <Spinner /> : undefined}
          >
            {status.registered ? "Registered in Plex" : "Register in Plex"}
          </Button>
        )}
        <Button
          variant="secondary"
          icon={<RefreshCw className={`h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />}
          onClick={load}
          disabled={busy || checking}
        >
          {checking ? "Checking…" : "Re-check"}
        </Button>
        {checkedAt && !checking && (
          <span className="self-center text-xs text-slate-500">Checked {checkedAt.toLocaleTimeString()}</span>
        )}
      </div>

      {status && !status.can_manage && (
        <p className="text-sm text-slate-500">
          This login isn't linked to a Plex account, so CreditEngine can't register the webhook for you. Paste
          the URL above into Plex → Settings → Webhooks.
        </p>
      )}

      {status && status.others.length > 0 && (
        <div className="space-y-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 p-3">
          <p className="text-sm text-amber-800 dark:text-amber-300">
            Your Plex account also has {status.others.length === 1 ? "a webhook" : `${status.others.length} webhooks`}{" "}
            pointing at a CreditEngine at a different address. If that address is an old one, Plex is calling
            something that no longer exists.
          </p>
          {status.others.map((o) => (
            <div key={o.hook_id} className="flex items-center gap-2">
              <span className="flex-1 truncate font-mono text-xs text-amber-900 dark:text-amber-200">{o.url}</span>
              <Button
                variant="danger"
                size="sm"
                icon={<Trash2 className="h-3.5 w-3.5" />}
                onClick={() => remove(o.hook_id, o.url)}
                disabled={busy}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
