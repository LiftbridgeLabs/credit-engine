import { useEffect, useState } from "react";
import { ChevronRight, ChevronDown, ChevronLeft, Search, Plus, Check } from "lucide-react";
import { api, ApiError, type BrowseItem, type Library } from "../lib/api";
import { Button, Input, Spinner } from "./ui";
import { PAGE_SIZES, getStoredPageSize, setStoredPageSize } from "../lib/pageSize";

export interface PickedItem {
  rating_key: number;
  title: string;
}

function PickerNode({
  serverId,
  item,
  depth,
  onPick,
  pickedKeys,
}: {
  serverId: number;
  item: BrowseItem;
  depth: number;
  onPick: (item: PickedItem) => void;
  pickedKeys: Set<number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<BrowseItem[] | null>(null);

  async function toggleExpand() {
    if (!expanded && children === null) {
      try {
        setChildren(await api.get<BrowseItem[]>(`/servers/${serverId}/browse/${item.rating_key}/children`));
      } catch {
        return;
      }
    }
    setExpanded(!expanded);
  }

  const label = item.type === "episode" && item.index != null ? `E${item.index} — ${item.title}` : item.title;
  const picked = pickedKeys.has(item.rating_key);
  // Plex's analyze action cascades to every child of a show/season — picking one of those (instead
  // of a specific movie/episode) silently turns a targeted scan into a full-show sweep. Only leaf
  // items are safe to queue directly; shows/seasons must be drilled into instead.
  const scannable = item.type === "movie" || item.type === "episode";

  return (
    <div style={{ marginLeft: depth * 18 }}>
      <div className="flex items-center gap-2 py-1.5 border-b border-slate-100 dark:border-slate-900">
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
        {scannable ? (
          <button
            onClick={() => onPick({ rating_key: item.rating_key, title: label })}
            className={`shrink-0 flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-md transition-colors ${
              picked
                ? "bg-emerald-50 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-400"
                : "bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-brand-50 hover:text-brand-700 dark:hover:bg-brand-950 dark:hover:text-brand-300"
            }`}
          >
            {picked ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
            {picked ? "Added" : "Add"}
          </button>
        ) : (
          <span className="shrink-0 text-xs text-slate-400 italic pr-1">pick an episode</span>
        )}
      </div>
      {expanded && children && (
        <div>
          {children.map((c) => (
            <PickerNode key={c.rating_key} serverId={serverId} item={c} depth={depth + 1} onPick={onPick} pickedKeys={pickedKeys} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Browse a server's included libraries and pick item(s) by rating key, instead of typing raw IDs. */
export function ItemPicker({
  serverId,
  onPick,
  pickedKeys,
}: {
  serverId: number;
  onPick: (item: PickedItem) => void;
  pickedKeys: Set<number>;
}) {
  const [libraries, setLibraries] = useState<Library[] | null>(null);
  const [sectionId, setSectionId] = useState<number | null>(null);
  const [items, setItems] = useState<BrowseItem[] | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(getStoredPageSize);

  useEffect(() => {
    api
      .get<Library[]>(`/servers/${serverId}/libraries`)
      .then((libs) => {
        const browsable = libs.filter((l) => l.type === "show" || l.type === "movie");
        setLibraries(browsable);
        if (browsable.length === 1) setSectionId(browsable[0].section_id);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load libraries"));
  }, [serverId]);

  useEffect(() => {
    if (sectionId === null) return;
    setItems(null);
    api
      .get<BrowseItem[]>(`/servers/${serverId}/browse?section_id=${sectionId}`)
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to browse"));
  }, [serverId, sectionId]);

  useEffect(() => {
    setPage(1);
  }, [filter, pageSize, sectionId]);

  function changePageSize(size: number) {
    setPageSize(size);
    setStoredPageSize(size);
  }

  const filtered = items?.filter((i) => i.title.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (libraries === null) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  if (libraries.length === 0) {
    return <p className="text-sm text-slate-500">No browsable libraries synced yet — sync in the Libraries tab first.</p>;
  }

  return (
    <div className="space-y-2">
      {libraries.length > 1 && (
        <select
          value={sectionId ?? ""}
          onChange={(e) => setSectionId(Number(e.target.value))}
          className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-sm"
        >
          <option value="" disabled>
            Choose a library…
          </option>
          {libraries.map((l) => (
            <option key={l.id} value={l.section_id}>
              {l.title}
            </option>
          ))}
        </select>
      )}

      {sectionId !== null && (
        <>
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
              <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="pl-8" />
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
          {items === null && (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          )}
          <div className="rounded-lg border border-slate-100 dark:border-slate-900 px-2">
            {paged.map((item) => (
              <PickerNode key={item.rating_key} serverId={serverId} item={item} depth={0} onPick={onPick} pickedKeys={pickedKeys} />
            ))}
            {items !== null && filtered.length === 0 && <p className="text-sm text-slate-500 py-3 text-center">No matches.</p>}
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
