import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, ChevronLeft, ScanLine, Search, CheckCircle2 } from "lucide-react";
import { api, ApiError, type BrowseItem } from "../../lib/api";
import { Button, Input, Spinner } from "../../components/ui";
import { PAGE_SIZES, getStoredPageSize, setStoredPageSize } from "../../lib/pageSize";

function BrowseNode({ serverId, item, depth }: { serverId: number; item: BrowseItem; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<BrowseItem[] | null>(null);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);

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

  const label =
    item.type === "episode" && item.index != null ? `E${item.index} — ${item.title}` : item.title;
  // Plex's analyze action cascades to every child of a show/season — scanning one of those directly
  // (instead of a specific movie/episode) silently turns a targeted scan into a full-show sweep.
  const scannable = item.type === "movie" || item.type === "episode";

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
        <span className="text-sm flex-1 truncate text-slate-700 dark:text-slate-300">{label}</span>
        {scanStatus === "Queued" ? (
          <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" /> Queued
          </span>
        ) : (
          scannable && (
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
          )
        )}
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

export default function LibraryBrowser({ serverId, sectionId }: { serverId: number; sectionId: number }) {
  const [items, setItems] = useState<BrowseItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(getStoredPageSize);

  useEffect(() => {
    api
      .get<BrowseItem[]>(`/servers/${serverId}/browse?section_id=${sectionId}`)
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to browse"));
  }, [serverId, sectionId]);

  useEffect(() => {
    setPage(1);
  }, [filter, pageSize]);

  function changePageSize(size: number) {
    setPageSize(size);
    setStoredPageSize(size);
  }

  const filtered = items?.filter((i) => i.title.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400 mt-2">{error}</p>;
  if (items === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="mt-3 border-t border-slate-100 dark:border-slate-900 pt-3">
      <div className="flex items-center gap-2 mb-2">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
          <Input
            placeholder={`Filter ${items.length} items…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="pl-8"
          />
        </div>
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

      <div className="rounded-lg border border-slate-100 dark:border-slate-900 px-2">
        {paged.map((item) => (
          <BrowseNode key={item.rating_key} serverId={serverId} item={item} depth={0} />
        ))}
        {filtered.length === 0 && <p className="text-sm text-slate-500 py-3 text-center">No matches.</p>}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-2 text-sm text-slate-500">
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
    </div>
  );
}
