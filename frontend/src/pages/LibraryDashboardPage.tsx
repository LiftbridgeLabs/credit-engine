import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  ChevronDown,
  ChevronLeft,
  ScanLine,
  ListChecks,
  Search,
  CheckCircle2,
  Filter,
} from "lucide-react";
import { api, ApiError, type BrowseItem, type Library, type LibraryStats } from "../lib/api";
import { Badge, Button, Card, ErrorBanner, Input, Spinner, Toggle } from "../components/ui";
import { Thumb } from "../components/Thumb";
import { PAGE_SIZES, getStoredPageSize, setStoredPageSize } from "../lib/pageSize";

// Survives component unmount (plain module state, not React state) — switching libraries or
// navigating away and back reads from here first instead of re-fetching from scratch every time.
const itemsCache = new Map<string, BrowseItem[]>();
const statsCache = new Map<string, LibraryStats>();

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <Card className="py-3 text-center">
      <div className="text-2xl font-semibold text-slate-900 dark:text-white">{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
    </Card>
  );
}

// Seasons/episodes once you've drilled into a show — a list, not a grid, since episode numbers
// and titles matter more here than poster art. Only show/movie support enabling credits
// generation at all (confirmed directly against Plex — seasons don't expose the preference), so
// this view is for on-demand scanning and status only, never a settings toggle.
function BrowseNode({ serverId, item, depth }: { serverId: number; item: BrowseItem; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<BrowseItem[] | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [bulkScanning, setBulkScanning] = useState(false);
  const [bulkResult, setBulkResult] = useState<string | null>(null);

  async function toggleExpand() {
    if (!expanded && children === null) {
      try {
        setChildren(await api.get<BrowseItem[]>(`/servers/${serverId}/browse/${item.rating_key}/children`));
      } catch (err) {
        setScanStatus(err instanceof ApiError ? err.message : "Failed to load");
        return;
      }
    }
    setExpanded(!expanded);
  }

  async function scan() {
    setScanning(true);
    setScanStatus(null);
    try {
      await api.post(`/servers/${serverId}/scans?rating_key=${item.rating_key}`);
      setScanStatus("Queued");
    } catch (err) {
      setScanStatus(err instanceof ApiError ? err.message : "Failed to queue");
    } finally {
      setScanning(false);
    }
  }

  async function scanAllEpisodes() {
    setBulkScanning(true);
    setBulkResult(null);
    try {
      const episodes = await api.get<BrowseItem[]>(`/servers/${serverId}/browse/${item.rating_key}/episodes`);
      if (
        !confirm(
          `Queue real-time scans for all ${episodes.length} episode(s) under "${item.title}"? They start ` +
            "immediately, one per episode — not a single scan of the whole thing.",
        )
      ) {
        setBulkScanning(false);
        return;
      }
      for (const ep of episodes) {
        await api.post(`/servers/${serverId}/scans?rating_key=${ep.rating_key}`);
      }
      setBulkResult(`Queued ${episodes.length}`);
    } catch (err) {
      setBulkResult(err instanceof ApiError ? err.message : "Failed to queue");
    } finally {
      setBulkScanning(false);
    }
  }

  const label = item.type === "episode" && item.index != null ? `E${item.index} — ${item.title}` : item.title;
  const scannable = item.type === "movie" || item.type === "episode";
  const isContainer = item.type === "show" || item.type === "season";

  return (
    <div style={{ marginLeft: depth * 18 }}>
      <div className="flex items-center gap-2 py-1.5 border-b border-slate-100 dark:border-slate-900 group">
        {item.has_children ? (
          <button
            onClick={toggleExpand}
            className="w-4 h-4 shrink-0 flex items-center justify-center text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <Thumb serverId={serverId} ratingKey={item.rating_key} hasThumb={item.has_thumb} />
        <span className="text-sm flex-1 truncate text-slate-700 dark:text-slate-300">{label}</span>
        {item.type === "episode" && item.has_credits != null && (
          <Badge tone={item.has_credits ? "good" : "neutral"}>{item.has_credits ? "Has credits" : "Missing"}</Badge>
        )}
        {scanStatus === "Queued" ? (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" /> Queued
          </span>
        ) : scannable ? (
          <Button
            size="sm"
            variant="ghost"
            icon={scanning ? <Spinner /> : <ScanLine className="h-3.5 w-3.5" />}
            onClick={scan}
            disabled={scanning}
            className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            Scan
          </Button>
        ) : isContainer ? (
          <Button
            size="sm"
            variant="ghost"
            icon={bulkScanning ? <Spinner /> : <ListChecks className="h-3.5 w-3.5" />}
            onClick={scanAllEpisodes}
            disabled={bulkScanning}
          >
            {bulkScanning ? "Queuing…" : (bulkResult ?? "Scan all episodes")}
          </Button>
        ) : null}
        {scanStatus && scanStatus !== "Queued" && <span className="text-xs text-red-500">{scanStatus}</span>}
      </div>
      {expanded && children && (
        <div>
          {children.map((c) => (
            <BrowseNode key={c.rating_key} serverId={serverId} item={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function PosterCard({
  serverId,
  item,
  onOpen,
  onToggled,
}: {
  serverId: number;
  item: BrowseItem;
  onOpen: () => void;
  onToggled: (ratingKey: number, enabled: boolean) => void;
}) {
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [toggling, setToggling] = useState(false);

  async function scan(e: React.MouseEvent) {
    e.stopPropagation();
    setScanning(true);
    setScanStatus(null);
    try {
      await api.post(`/servers/${serverId}/scans?rating_key=${item.rating_key}`);
      setScanStatus("Queued");
    } catch (err) {
      setScanStatus(err instanceof ApiError ? err.message : "Failed to queue");
    } finally {
      setScanning(false);
    }
  }

  async function toggleCredits() {
    setToggling(true);
    try {
      const next = !item.credits_enabled;
      await api.post(`/servers/${serverId}/browse/${item.rating_key}/credits?enabled=${next}`);
      onToggled(item.rating_key, next);
    } catch {
      // silently leave the toggle as-is — the card will just still show the old state, which is
      // accurate, so no separate error surface needed for this one
    } finally {
      setToggling(false);
    }
  }

  return (
    <div>
      <div
        onClick={item.has_children ? onOpen : undefined}
        className={`group relative aspect-[2/3] rounded-lg overflow-hidden ring-1 ring-slate-200 dark:ring-slate-800 ${item.has_children ? "cursor-pointer" : ""}`}
      >
        <Thumb serverId={serverId} ratingKey={item.rating_key} hasThumb={item.has_thumb} size="poster" />
        {item.has_children && (
          <span className="absolute top-1.5 right-1.5 bg-slate-900/70 text-white rounded-full p-1">
            <ChevronRight className="h-3 w-3" />
          </span>
        )}
        {item.type === "movie" &&
          (scanStatus === "Queued" ? (
            <span className="absolute bottom-1.5 right-1.5 flex items-center gap-1 text-xs bg-emerald-600 text-white px-2 py-1 rounded-md">
              <CheckCircle2 className="h-3 w-3" /> Queued
            </span>
          ) : (
            <button
              onClick={scan}
              disabled={scanning}
              className="absolute bottom-1.5 right-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity flex items-center gap-1 text-xs bg-slate-900/80 hover:bg-brand-600 text-white px-2 py-1 rounded-md"
            >
              {scanning ? <Spinner className="h-3 w-3" /> : <ScanLine className="h-3 w-3" />}
              Scan
            </button>
          ))}
        {scanStatus && scanStatus !== "Queued" && (
          <span className="absolute bottom-1.5 left-1.5 right-1.5 text-xs text-red-200 bg-red-900/80 px-1.5 py-0.5 rounded truncate">
            {scanStatus}
          </span>
        )}
      </div>
      <p className="text-sm mt-1.5 truncate text-slate-700 dark:text-slate-300">{item.title}</p>
      {item.type === "show" && item.episode_count != null && (
        <p className="text-xs text-slate-500">
          {item.episodes_with_credits}/{item.episode_count} have credits
        </p>
      )}
      {item.type === "movie" && item.has_credits != null && (
        <Badge tone={item.has_credits ? "good" : item.credits_enabled ? "warn" : "neutral"}>
          {item.has_credits ? "Has credits" : item.credits_enabled ? "Pending" : "Missing"}
        </Badge>
      )}
      <div className="flex items-center gap-1.5 mt-1" onClick={(e) => e.stopPropagation()}>
        <Toggle checked={!!item.credits_enabled} onChange={toggleCredits} label={`Enable credits for ${item.title}`} />
        <span className="text-xs text-slate-500">{toggling ? "Saving…" : item.credits_enabled ? "Enabled" : "Disabled"}</span>
      </div>
    </div>
  );
}

export default function LibraryDashboardPage() {
  const { id, sectionId: sectionIdParam } = useParams<{ id: string; sectionId: string }>();
  const serverId = Number(id);
  const sectionId = Number(sectionIdParam);
  const navigate = useNavigate();

  const cacheKey = `${serverId}:${sectionId}`;
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [items, setItems] = useState<BrowseItem[] | null>(itemsCache.get(cacheKey) ?? null);
  const [stats, setStats] = useState<LibraryStats | null>(statsCache.get(cacheKey) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [missingOnly, setMissingOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(getStoredPageSize);
  const [drilled, setDrilled] = useState<BrowseItem | null>(null);
  const [drilledChildren, setDrilledChildren] = useState<BrowseItem[] | null>(null);

  useEffect(() => {
    api
      .get<Library[]>(`/servers/${serverId}/libraries`)
      .then((libs) => setLibraries(libs.filter((l) => l.type === "show" || l.type === "movie")))
      .catch(() => {});
  }, [serverId]);

  useEffect(() => {
    const key = `${serverId}:${sectionId}`;
    // Cached data (if any) shows immediately; a fresh fetch still runs underneath so it stays
    // current — the point is never staring at a blank spinner for a library you already loaded.
    setItems(itemsCache.get(key) ?? null);
    setStats(statsCache.get(key) ?? null);
    setDrilled(null);
    setError(null);

    api
      .get<BrowseItem[]>(`/servers/${serverId}/browse?section_id=${sectionId}`)
      .then((data) => {
        itemsCache.set(key, data);
        setItems(data);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to browse"));

    api
      .get<LibraryStats>(`/servers/${serverId}/browse/stats?section_id=${sectionId}`)
      .then((data) => {
        statsCache.set(key, data);
        setStats(data);
      })
      .catch(() => setStats(null));
  }, [serverId, sectionId]);

  useEffect(() => {
    setPage(1);
  }, [filter, pageSize, missingOnly]);

  function changePageSize(size: number) {
    setPageSize(size);
    setStoredPageSize(size);
  }

  function handleToggled(ratingKey: number, enabled: boolean) {
    setItems((prev) => {
      if (!prev) return prev;
      const next = prev.map((i) => (i.rating_key === ratingKey ? { ...i, credits_enabled: enabled } : i));
      itemsCache.set(cacheKey, next);
      return next;
    });
  }

  async function openItem(item: BrowseItem) {
    if (!item.has_children) return;
    setDrilled(item);
    setDrilledChildren(null);
    try {
      setDrilledChildren(await api.get<BrowseItem[]>(`/servers/${serverId}/browse/${item.rating_key}/children`));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to browse");
    }
  }

  const currentLib = libraries.find((l) => l.section_id === sectionId);
  const filtered = (items ?? []).filter((i) => {
    if (!i.title.toLowerCase().includes(filter.toLowerCase())) return false;
    if (missingOnly) {
      if (i.type === "movie") return !i.has_credits;
      if (i.type === "show") return (i.episode_count ?? 0) > (i.episodes_with_credits ?? 0);
    }
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-4">
      <div>
        <Link
          to={`/servers/${serverId}`}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to server
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{currentLib?.title ?? "Library"}</h1>
          {libraries.length > 1 && (
            <select
              value={sectionId}
              onChange={(e) => navigate(`/servers/${serverId}/libraries/${e.target.value}`)}
              className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
            >
              {libraries.map((l) => (
                <option key={l.id} value={l.section_id}>
                  {l.title}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <ErrorBanner message={error} />

      {items === null && (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      )}

      {items !== null && drilled && (
        <div>
          <button
            onClick={() => setDrilled(null)}
            className="flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 mb-3"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to library
          </button>
          <div className="flex items-center gap-3 mb-3">
            <div className="h-16 w-11 rounded overflow-hidden shrink-0">
              <Thumb serverId={serverId} ratingKey={drilled.rating_key} hasThumb={drilled.has_thumb} size="poster" />
            </div>
            <div className="font-medium text-slate-900 dark:text-white">{drilled.title}</div>
          </div>
          {drilledChildren === null ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : (
            <div className="rounded-lg border border-slate-100 dark:border-slate-900 px-2">
              {drilledChildren.map((c) => (
                <BrowseNode key={c.rating_key} serverId={serverId} item={c} depth={0} />
              ))}
            </div>
          )}
        </div>
      )}

      {items !== null && !drilled && (
        <>
          {stats && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <StatCard value={stats.top_level_count} label="Shows / Movies" />
              <StatCard value={stats.has_credits} label="Has credits" />
              <StatCard value={stats.pending} label="Pending" />
              <StatCard value={stats.missing} label="Missing" />
            </div>
          )}

          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input
                placeholder={`Filter ${items.length} items…`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="pl-8"
              />
            </div>
            <Button
              variant={missingOnly ? "primary" : "secondary"}
              size="sm"
              icon={<Filter className="h-3.5 w-3.5" />}
              onClick={() => setMissingOnly((v) => !v)}
              className="shrink-0"
            >
              Missing only
            </Button>
            <select
              value={pageSize}
              onChange={(e) => changePageSize(Number(e.target.value))}
              className="px-2 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm shrink-0"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size} / page
                </option>
              ))}
            </select>
          </div>

          {filtered.length === 0 && <p className="text-sm text-slate-500 py-3 text-center">No matches.</p>}

          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 gap-3">
            {paged.map((item) => (
              <PosterCard key={item.rating_key} serverId={serverId} item={item} onOpen={() => openItem(item)} onToggled={handleToggled} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm text-slate-500">
              <Button variant="ghost" size="sm" icon={<ChevronLeft className="h-3.5 w-3.5" />} onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
                Prev
              </Button>
              <span>
                Page {page} of {totalPages} ({filtered.length} items)
              </span>
              <Button variant="ghost" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
