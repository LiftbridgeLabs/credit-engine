import type { BrowseItem } from "./api";

const SORT_KEY = "credit_engine_library_sort";

export const LIBRARY_SORTS = {
  enabled: "Enabled first",
  title: "Title A–Z",
  missing: "Most missing credits",
} as const;
export type LibrarySort = keyof typeof LIBRARY_SORTS;

// Every read and write is guarded: storage can be unavailable (private windows, blocked site
// data), and a remembered sort is only a convenience.
export function getStoredSort(): LibrarySort {
  try {
    const stored = localStorage.getItem(SORT_KEY);
    if (stored && stored in LIBRARY_SORTS) return stored as LibrarySort;
  } catch {
    // fall through to the default
  }
  return "enabled";
}

export function setStoredSort(sort: LibrarySort): void {
  try {
    localStorage.setItem(SORT_KEY, sort);
  } catch {
    // not remembered — harmless
  }
}

// Plex files "The Gentlemen" under G, so this does too.
function titleKey(item: BrowseItem): string {
  return item.title.replace(/^(the|a|an)\s+/i, "").toLowerCase();
}

function missingCount(item: BrowseItem): number {
  if (item.type === "show") return (item.episode_count ?? 0) - (item.episodes_with_credits ?? 0);
  return item.has_credits ? 0 : 1;
}

function enabledRank(item: BrowseItem): number {
  if (item.never) return 2;
  return item.credits_enabled ? 0 : 1;
}

export function sortItems(items: BrowseItem[], sort: LibrarySort): BrowseItem[] {
  const byTitle = (a: BrowseItem, b: BrowseItem) => titleKey(a).localeCompare(titleKey(b));
  const sorted = [...items];
  if (sort === "title") sorted.sort(byTitle);
  else if (sort === "enabled") sorted.sort((a, b) => enabledRank(a) - enabledRank(b) || byTitle(a, b));
  else sorted.sort((a, b) => missingCount(b) - missingCount(a) || byTitle(a, b));
  return sorted;
}
