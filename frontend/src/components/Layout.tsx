import { useEffect, useState } from "react";
import { Link, Outlet, useNavigate } from "react-router-dom";
import { Clapperboard, LogOut, ScrollText, Settings2, User } from "lucide-react";
import { api, type VersionInfo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button } from "./ui";

export default function Layout() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  // Which build is actually running — the answer to "did my update land?". Fetched once per mount
  // and failure-silent: an unreachable backend already surfaces itself on every other page, and a
  // missing footer is better than an error banner over whatever the user came here to do.
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<VersionInfo>("/settings/version")
      .then((v) => setVersion(v.version))
      .catch(() => {});
  }, []);

  function handleLogout() {
    logout();
    navigate("/auth");
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-950/80 backdrop-blur-sm sticky top-0 z-40 px-4 sm:px-6 py-3 flex items-center justify-between">
        <Link to="/servers" className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white">
            <Clapperboard className="h-4 w-4" />
          </span>
          CreditEngine
        </Link>
        <div className="flex items-center gap-3">
          <Link
            to="/logs"
            className="text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 hidden sm:flex items-center gap-1.5"
          >
            <ScrollText className="h-3.5 w-3.5" />
            Logs
          </Link>
          <Link
            to="/settings"
            className="text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 hidden sm:flex items-center gap-1.5"
          >
            <Settings2 className="h-3.5 w-3.5" />
            Settings
          </Link>
          {me && (
            <Link
              to="/account"
              className="text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 hidden sm:flex items-center gap-1.5"
            >
              <User className="h-3.5 w-3.5" />
              {me.plex_username ?? me.email}
            </Link>
          )}
          <Button variant="ghost" size="sm" icon={<LogOut className="h-3.5 w-3.5" />} onClick={handleLogout}>
            Log out
          </Button>
        </div>
      </header>
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 sm:px-6 py-6">
        <Outlet />
      </main>
      <footer className="border-t border-slate-200 dark:border-slate-800 px-4 sm:px-6 py-3 text-xs text-slate-400 dark:text-slate-600 flex items-center justify-between">
        <span>CreditEngine</span>
        {version && <span className="font-mono">{version}</span>}
      </footer>
    </div>
  );
}
