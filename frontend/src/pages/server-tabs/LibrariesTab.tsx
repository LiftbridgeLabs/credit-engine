import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, Film, Tv, Music, FolderOpen, Info } from "lucide-react";
import { api, ApiError, type Library } from "../../lib/api";
import { Badge, Button, Card, ErrorBanner, Spinner, Toggle } from "../../components/ui";
import { EmptyState } from "../../components/EmptyState";

const TYPE_ICON = { movie: Film, show: Tv, artist: Music } as const;

export default function LibrariesTab({ serverId }: { serverId: number }) {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  async function load() {
    try {
      setLibraries(await api.get<Library[]>(`/servers/${serverId}/libraries`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load libraries");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      await api.post(`/servers/${serverId}/libraries/sync`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function toggleIncluded(lib: Library) {
    try {
      const updated = await api.patch<Library>(`/servers/${serverId}/libraries/${lib.id}?included=${!lib.included}`);
      setLibraries((prev) => prev?.map((l) => (l.id === lib.id ? updated : l)) ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to update library");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-start gap-2 text-sm text-slate-500 bg-slate-100 dark:bg-slate-900 rounded-lg px-3 py-2">
          <Info className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            "Included" libraries are available for rules and batches to target — separate from
            credits-control protection, which covers every library on the server. "Open" below takes you
            to that library's dashboard — credits status, filtering, and scanning.
          </span>
        </div>
        <Button
          variant="secondary"
          icon={<RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />}
          onClick={sync}
          disabled={syncing}
          className="shrink-0"
          title="Re-reads which library sections exist on this Plex server. Doesn't touch cached titles, art or credits status — that's Sync content, on the Servers page."
        >
          Refresh list
        </Button>
      </div>

      <ErrorBanner message={error} />

      {libraries === null && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {libraries?.length === 0 && (
        <EmptyState
          icon={<FolderOpen className="h-10 w-10" />}
          title="No libraries found yet"
          description="Refresh to pull in this server's library sections."
          action={
            <Button icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={sync} disabled={syncing}>
              Refresh list
            </Button>
          }
        />
      )}

      <div className="grid gap-2.5">
        {libraries?.map((lib) => {
          const Icon = TYPE_ICON[lib.type as keyof typeof TYPE_ICON] ?? FolderOpen;
          return (
            <Card key={lib.id} className="py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 dark:bg-slate-800 text-slate-500">
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="font-medium text-slate-900 dark:text-white truncate">{lib.title}</div>
                    <Badge>{lib.type}</Badge>
                  </div>
                </div>
                <div className="flex gap-2 shrink-0">
                  {(lib.type === "show" || lib.type === "movie") && (
                    <Link to={`/servers/${serverId}/libraries/${lib.section_id}`}>
                      <Button size="sm" variant="secondary">
                        Open
                      </Button>
                    </Link>
                  )}
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500 hidden sm:inline">Included</span>
                    <Toggle checked={lib.included} onChange={() => toggleIncluded(lib)} label={`Include ${lib.title}`} />
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
