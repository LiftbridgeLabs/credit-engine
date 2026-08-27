// The frontend is served by the same container/origin as the API (FastAPI serves the built SPA
// directly — see backend/app/main.py) — so a relative path is correct by default, and works
// unchanged behind a reverse proxy at any domain, with no build-time URL to get wrong. Only
// needed as a real URL when frontend and backend genuinely run on different hosts (e.g. the
// Vite dev server during local frontend development, talking to a separately-running backend).
//
// Every backend route lives under /api (see main.py) — baked in here once so every existing
// api.get("/servers") style call across the app is already correct without touching each one.
const API_BASE = (import.meta.env.VITE_API_BASE_URL || "") + "/api";

export function getApiBase(): string {
  return API_BASE;
}

const TOKEN_KEY = "credit_engine_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const detail = isJson && body?.detail ? body.detail : `Request failed (${res.status})`;
    throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail));
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// --- Types mirroring the backend's Pydantic/SQLAlchemy shapes ---

export interface VersionInfo {
  version: string;
}

export interface AuthStatus {
  has_users: boolean;
}

export interface TokenResponse {
  access_token: string;
  user_id: number;
  is_admin: boolean;
}

export interface Me {
  id: number;
  email: string;
  is_admin: boolean;
  plex_username: string | null;
  has_password: boolean;
}

export interface PlexServerConnection {
  uri: string;
  local: boolean;
  relay: boolean;
}

export interface PlexDiscoveredServer {
  name: string;
  client_identifier: string;
  access_token: string;
  owned: boolean;
  connections: PlexServerConnection[];
}

export interface ServerConnection {
  id: number;
  name: string;
  base_url: string;
  client_identifier: string | null;
  credits_control_enabled: boolean;
  credits_control_bootstrapped_at: string | null;
  last_new_item_check_at: string | null;
  webhook_secret: string;
  webhook_verified_at: string | null;
  created_at: string;
}

export interface Library {
  id: number;
  server_id: number;
  section_id: number;
  title: string;
  type: string;
  included: boolean;
}

export interface ScanRule {
  id: number;
  server_id: number;
  name: string;
  enabled: boolean;
  criteria: { type: string; days: number; library_ids: number[] };
  schedule_cron: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface ScanBatch {
  id: number;
  server_id: number;
  name: string;
  rating_keys: number[];
  schedule_cron: string | null;
  last_run_at: string | null;
  created_at: string;
}

export interface ScanJob {
  id: number;
  server_id: number;
  batch_id: number | null;
  rating_key: number;
  title: string | null;
  status: "pending" | "running" | "complete" | "failed";
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ArrInstance {
  id: number;
  server_id: number;
  type: "sonarr" | "radarr";
  base_url: string;
  notification_id: number | null;
  created_at: string;
}

export interface BrowseItem {
  rating_key: number;
  title: string;
  type: "show" | "season" | "episode" | "movie";
  index: number | null;
  season_number: number | null;
  has_children: boolean;
  has_thumb: boolean;
  // Null = genuinely unknown (no sync has ever run against this library yet), not "false".
  credits_enabled: boolean | null;
  has_credits: boolean | null;
  // Only populated on "show" rows, from a per-library rollup computed at browse time.
  episode_count: number | null;
  episodes_with_credits: number | null;
}

export interface LibraryStats {
  top_level_count: number;
  total_items: number;
  has_credits: number;
  pending: number;
  missing: number;
}

// The thumb endpoint is hit from plain <img> tags, which can't send an Authorization header — the
// session token goes as a query param instead (see get_current_user_via_query on the backend).
// Never embeds the Plex token itself; that stays server-side.
export function thumbUrl(serverId: number, ratingKey: number): string {
  return `${getApiBase()}/servers/${serverId}/browse/${ratingKey}/thumb?auth=${encodeURIComponent(getToken() ?? "")}`;
}

export interface Diagnostics {
  global_behavior: "never" | "scheduled" | "asap";
  butler_task_enabled: boolean;
  butler_window: { start_hour: number; end_hour: number };
  libraries: { section_id: number; title: string; credits_detection_enabled: boolean }[];
}

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface LogEntry {
  id: number;
  created_at: string;
  level: LogLevel;
  logger_name: string;
  message: string;
  server_id: number | null;
}

export interface AppSettings {
  id: number;
  log_max_entries: number;
  log_retention_days: number;
  content_sync_interval_hours: number;
}
