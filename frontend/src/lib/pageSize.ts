const PAGE_SIZE_KEY = "credit_engine_browser_page_size";
export const PAGE_SIZES = [25, 50, 100, 200] as const;

export function getStoredPageSize(): number {
  const stored = Number(localStorage.getItem(PAGE_SIZE_KEY));
  return PAGE_SIZES.includes(stored as (typeof PAGE_SIZES)[number]) ? stored : 25;
}

export function setStoredPageSize(size: number): void {
  localStorage.setItem(PAGE_SIZE_KEY, String(size));
}
