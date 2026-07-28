import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Library,
  Sparkles,
  ListChecks,
  Layers,
  ScanLine,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { api, ApiError, type ServerConnection } from "../lib/api";
import { Badge, ErrorBanner, Spinner } from "../components/ui";
import LibrariesTab from "./server-tabs/LibrariesTab";
import CreditsControlTab from "./server-tabs/CreditsControlTab";
import RulesTab from "./server-tabs/RulesTab";
import BatchesTab from "./server-tabs/BatchesTab";
import ScansTab from "./server-tabs/ScansTab";
import ArrInstancesTab from "./server-tabs/ArrInstancesTab";

const TABS: { label: string; icon: LucideIcon }[] = [
  { label: "Libraries", icon: Library },
  { label: "Credits control", icon: Sparkles },
  { label: "Rules", icon: ListChecks },
  { label: "Batches", icon: Layers },
  { label: "Scans", icon: ScanLine },
  { label: "Sonarr/Radarr", icon: Webhook },
];
type Tab = (typeof TABS)[number]["label"];

export default function ServerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const serverId = Number(id);
  const [server, setServer] = useState<ServerConnection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Libraries");

  useEffect(() => {
    function load() {
      api
        .get<ServerConnection>(`/servers/${serverId}`)
        .then(setServer)
        .catch((err) => setError(err instanceof ApiError ? err.message : "Failed to load server"));
    }
    load();
    // Background tasks (bootstrap, webhooks, scheduled rules) change this server's state outside
    // any single browser session — poll instead of relying on this tab's own actions to refresh it.
    const interval = window.setInterval(load, 10000);
    return () => window.clearInterval(interval);
  }, [serverId]);

  if (error) return <ErrorBanner message={error} />;
  if (!server) {
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <Link
          to="/servers"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 mb-2"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All servers
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-white">{server.name}</h1>
          <Badge tone={server.credits_control_enabled ? "good" : "neutral"}>
            {server.credits_control_enabled ? "Credits control on" : "Credits control off"}
          </Badge>
        </div>
        <p className="text-xs text-slate-500 font-mono mt-0.5">{server.base_url}</p>
      </div>

      <div className="flex flex-col md:flex-row gap-5">
        <nav className="flex md:flex-col gap-1 overflow-x-auto md:w-52 shrink-0">
          {TABS.map(({ label, icon: Icon }) => (
            <button
              key={label}
              onClick={() => setTab(label)}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm whitespace-nowrap text-left transition-colors ${
                tab === label
                  ? "bg-brand-50 dark:bg-brand-950 text-brand-700 dark:text-brand-300 font-medium"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-900"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>

        <div className="flex-1 min-w-0">
          {tab === "Libraries" && <LibrariesTab serverId={serverId} />}
          {tab === "Credits control" && <CreditsControlTab server={server} onServerUpdate={setServer} />}
          {tab === "Rules" && <RulesTab serverId={serverId} />}
          {tab === "Batches" && <BatchesTab serverId={serverId} />}
          {tab === "Scans" && <ScansTab serverId={serverId} />}
          {tab === "Sonarr/Radarr" && <ArrInstancesTab serverId={serverId} />}
        </div>
      </div>
    </div>
  );
}
