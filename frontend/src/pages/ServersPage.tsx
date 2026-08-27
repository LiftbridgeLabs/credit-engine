import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Plus, RefreshCw, Server, Webhook, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { api, ApiError, type PlexDiscoveredServer, type PlexServerConnection, type ServerConnection } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Input, Spinner } from "../components/ui";
import { EmptyState } from "../components/EmptyState";
import { Modal } from "../components/Modal";
import { useToast } from "../components/toast";

export default function ServersPage() {
  const [servers, setServers] = useState<ServerConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState<Set<number>>(new Set());
  const toast = useToast();

  async function load() {
    try {
      setServers(await api.get<ServerConnection[]>("/servers"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load servers");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function syncContent(e: React.MouseEvent, serverId: number) {
    e.preventDefault(); // the card itself is a Link — don't navigate when clicking this button
    e.stopPropagation();
    setSyncing((prev) => new Set(prev).add(serverId));
    try {
      const res = await api.post<{ status: string }>(`/servers/${serverId}/sync-content`);
      toast(
        res.status === "already_running"
          ? "A content sync is already running for this server — leaving it to finish"
          : "Content sync started — running in the background, can take a while on a large library",
      );
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed to start sync");
    } finally {
      // Fire-and-forget — there's no fine-grained "done" signal to poll yet, so this just
      // reflects "request sent", not "sync finished". Browsing gets faster once it actually
      // completes; no other feedback in the meantime.
      window.setTimeout(() => {
        setSyncing((prev) => {
          const next = new Set(prev);
          next.delete(serverId);
          return next;
        });
      }, 2000);
    }
  }

  async function unlinkServer(e: React.MouseEvent, server: ServerConnection) {
    e.preventDefault();
    e.stopPropagation();
    if (!window.confirm(`Remove ${server.name} from CreditEngine?`)) return;
    setDeleting((prev) => new Set(prev).add(server.id));
    try {
      await api.delete(`/servers/${server.id}`);
      setServers((prev) => prev?.filter((item) => item.id !== server.id) ?? prev);
      toast(`Removed ${server.name}`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Failed to remove server");
    } finally {
      setDeleting((prev) => {
        const next = new Set(prev);
        next.delete(server.id);
        return next;
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Your Plex servers</h1>
          <p className="text-sm text-slate-500">Manage credits-marker generation per server.</p>
        </div>
        {servers !== null && servers.length > 0 && (
          <Button icon={<Plus className="h-4 w-4" />} onClick={() => setLinking(true)}>
            Link a server
          </Button>
        )}
      </div>

      <ErrorBanner message={error} />

      {linking && (
        <Modal title="Link a Plex server" onClose={() => setLinking(false)}>
          <LinkServerForm
            linkedClientIdentifiers={new Set(
              (servers ?? [])
                .map((server) => server.client_identifier)
                .filter((identifier): identifier is string => identifier !== null),
            )}
            onLinked={() => {
              setLinking(false);
              load();
            }}
          />
        </Modal>
      )}

      {servers === null && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {servers?.length === 0 && (
        <EmptyState
          icon={<Server className="h-10 w-10" />}
          title="No servers linked yet"
          description="Link a Plex server to start managing credits-marker generation."
          action={
            <Button icon={<Plus className="h-4 w-4" />} onClick={() => setLinking(true)}>
              Link a server
            </Button>
          }
        />
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {servers?.map((s) => (
          <div key={s.id} className="relative">
            <Link to={`/servers/${s.id}`}>
            <Card hover className="h-full">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 dark:bg-brand-950 text-brand-600 dark:text-brand-400">
                  <Server className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-900 dark:text-white truncate">{s.name}</div>
                  <div className="text-xs text-slate-500 font-mono truncate">{s.base_url}</div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                    <Badge tone={s.credits_control_enabled ? "good" : "neutral"}>
                      {s.credits_control_enabled ? "Credits control on" : "Credits control off"}
                    </Badge>
                    <Badge tone={s.webhook_verified_at ? "good" : "neutral"}>
                      <Webhook className="h-3 w-3 mr-1" />
                      {s.webhook_verified_at ? "Webhook verified" : "Webhook unverified"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<RefreshCw className={`h-3 w-3 ${syncing.has(s.id) ? "animate-spin" : ""}`} />}
                      onClick={(e) => syncContent(e, s.id)}
                      disabled={syncing.has(s.id)}
                      className="ml-auto"
                      title="Rebuilds the cached contents of every included library — titles, art references and credits status — so new shows and movies appear in Browse. Runs automatically on an interval; this is the don't-wait-for-it button."
                    >
                      Sync content
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Trash2 className="h-3 w-3" />}
                      onClick={(e) => unlinkServer(e, s)}
                      disabled={deleting.has(s.id)}
                      title="Remove this server from CreditEngine"
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              </div>
            </Card>
            </Link>
          </div>
        ))}
      </div>
    </div>
  );
}

// Plex reports a connection option for every network interface it can see, including a server's own
// internal Docker bridge networks (172.16.0.0/12) — noise for a user picking where to connect from.
function isDockerBridgeUri(uri: string): boolean {
  const match = uri.match(/^https?:\/\/(\d{1,3})-(\d{1,3})-\d{1,3}-\d{1,3}[.-]/);
  if (!match) return false;
  const [, a, b] = match;
  return a === "172" && Number(b) >= 16 && Number(b) <= 31;
}

function connectionScore(c: PlexServerConnection): number {
  if (isDockerBridgeUri(c.uri)) return 3;
  if (c.relay) return 2;
  if (c.local) return 0;
  return 1;
}

// Plex's own hostnames embed the client identifier for TLS SNI, e.g.
// "https://10-10-10-5.76e1550f50c34d15b167c6e....plex.direct:32400" — meaningless to a user.
// Reduce that back to the plain "10.10.10.5:32400" they'd actually recognize; leave real
// custom domains (plex.streamstead.io) alone since those are already readable.
function friendlyAddress(uri: string): string {
  try {
    const u = new URL(uri);
    const plexDirect = u.hostname.match(/^(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\..+\.plex\.direct$/);
    const host = plexDirect ? plexDirect[1].replace(/-/g, ".") : u.hostname;
    return `${host}${u.port ? ":" + u.port : ""}`;
  } catch {
    return uri;
  }
}

function connectionKind(c: PlexServerConnection): { label: string; tone: "good" | "neutral" } {
  if (isDockerBridgeUri(c.uri)) return { label: "Docker-internal", tone: "neutral" };
  if (c.local) return { label: "Local network", tone: "good" };
  if (c.relay) return { label: "Plex Relay (slower)", tone: "neutral" };
  return { label: "Remote", tone: "neutral" };
}

function LinkServerForm({
  linkedClientIdentifiers,
  onLinked,
}: {
  linkedClientIdentifiers: Set<string>;
  onLinked: () => void;
}) {
  const [mode, setMode] = useState<"plex" | "manual">("plex");
  const [discovered, setDiscovered] = useState<PlexDiscoveredServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const toast = useToast();

  const [manualName, setManualName] = useState("");
  const [manualUrl, setManualUrl] = useState("");
  const [manualToken, setManualToken] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  async function discover() {
    setError(null);
    setDiscovered(null);
    try {
      setDiscovered(await api.get<PlexDiscoveredServer[]>("/auth/plex/servers"));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} — you may need to log out and "Login with Plex" first`
          : "Failed to load Plex servers",
      );
    }
  }

  useEffect(() => {
    if (mode === "plex") discover();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  async function linkDiscovered(server: PlexDiscoveredServer, connectionUri: string) {
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/servers", {
        name: server.name,
        base_url: connectionUri,
        token: server.access_token,
        client_identifier: server.client_identifier,
      });
      toast(`Linked ${server.name}`);
      onLinked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to link server");
    } finally {
      setSubmitting(false);
    }
  }

  async function linkManual() {
    setSubmitting(true);
    setError(null);
    try {
      await api.post("/servers", { name: manualName, base_url: manualUrl, token: manualToken });
      toast(`Linked ${manualName}`);
      onLinked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to link server");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-sm">
        <button
          className={`flex-1 px-2 py-1.5 rounded-md transition-colors ${mode === "plex" ? "bg-white dark:bg-slate-700 shadow-sm font-medium" : "text-slate-500"}`}
          onClick={() => setMode("plex")}
        >
          Discover via Plex
        </button>
        <button
          className={`flex-1 px-2 py-1.5 rounded-md transition-colors ${mode === "manual" ? "bg-white dark:bg-slate-700 shadow-sm font-medium" : "text-slate-500"}`}
          onClick={() => setMode("manual")}
        >
          Manual entry
        </button>
      </div>

      <ErrorBanner message={error} />

      {mode === "plex" && (
        <div className="space-y-3">
          {discovered === null && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          {discovered?.filter((server) => !linkedClientIdentifiers.has(server.client_identifier)).length === 0 && (
            <p className="text-sm text-slate-500">No unlinked servers found on your Plex account.</p>
          )}
          {discovered?.filter((server) => !linkedClientIdentifiers.has(server.client_identifier)).map((server) => {
            const ranked = [...server.connections].sort((a, b) => connectionScore(a) - connectionScore(b));
            const [recommended, ...rest] = ranked;
            const others = rest.filter((c) => !isDockerBridgeUri(c.uri) || ranked.every((r) => isDockerBridgeUri(r.uri)));
            const isExpanded = expanded.has(server.client_identifier);
            const recKind = connectionKind(recommended);

            return (
              <div key={server.client_identifier} className="border border-slate-200 dark:border-slate-800 rounded-lg p-3.5">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-medium text-sm text-slate-900 dark:text-white">{server.name}</div>
                    <div className="flex items-center gap-1.5 mt-1 text-xs text-slate-500">
                      <Badge tone={recKind.tone}>{recKind.label}</Badge>
                      <span className="font-mono truncate">{friendlyAddress(recommended.uri)}</span>
                    </div>
                  </div>
                  <Button size="sm" disabled={submitting} onClick={() => linkDiscovered(server, recommended.uri)} className="shrink-0">
                    Link this server
                  </Button>
                </div>

                {others.length > 0 && (
                  <div className="mt-2.5 pt-2.5 border-t border-slate-100 dark:border-slate-900">
                    <button
                      className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                      onClick={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(server.client_identifier)) next.delete(server.client_identifier);
                          else next.add(server.client_identifier);
                          return next;
                        })
                      }
                    >
                      {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                      {isExpanded ? "Hide" : `${others.length} other connection option${others.length === 1 ? "" : "s"}`}
                    </button>
                    {isExpanded && (
                      <div className="space-y-1.5 mt-2">
                        {others.map((c) => {
                          const kind = connectionKind(c);
                          return (
                            <div key={c.uri} className="flex items-center justify-between gap-2 text-xs">
                              <span className="truncate flex items-center gap-1.5">
                                <Badge tone={kind.tone}>{kind.label}</Badge>
                                <span className="font-mono text-slate-500 truncate">{friendlyAddress(c.uri)}</span>
                              </span>
                              <Button size="sm" variant="secondary" disabled={submitting} onClick={() => linkDiscovered(server, c.uri)} className="shrink-0">
                                Use this
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {mode === "manual" && (
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Name</label>
            <Input value={manualName} onChange={(e) => setManualName(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Base URL</label>
            <Input
              placeholder="http://192.168.1.x:32400"
              value={manualUrl}
              onChange={(e) => setManualUrl(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Token</label>
            <Input value={manualToken} onChange={(e) => setManualToken(e.target.value)} />
          </div>
          <Button disabled={submitting} onClick={linkManual} className="w-full">
            {submitting ? <Spinner /> : "Link server"}
          </Button>
        </div>
      )}
    </div>
  );
}
