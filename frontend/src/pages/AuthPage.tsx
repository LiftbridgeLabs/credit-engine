import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Clapperboard } from "lucide-react";
import { api, ApiError, getApiBase, type TokenResponse } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, ErrorBanner, Input, Spinner } from "../components/ui";

type Mode = "login" | "register";

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [plexPending, setPlexPending] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/register";
      const result = await api.post<TokenResponse>(path, { email, password });
      await login(result.access_token);
      navigate("/servers");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePlexLogin() {
    setError(null);
    setPlexPending(true);
    const plexPopup = window.open(
      "about:blank",
      "credit-engine-plex-auth",
      "popup=yes,width=480,height=680,menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes",
    );
    try {
      const { pin_id, auth_url } = await api.post<{ pin_id: number; auth_url: string }>("/auth/plex/pin");
      if (plexPopup) {
        plexPopup.location.href = auth_url;
        plexPopup.focus();
      } else {
        window.open(auth_url, "_blank");
      }

      // The backend returns 202 for "still pending" — a 2xx status, so the generic api.get()
      // helper would treat it as success with the wrong body shape. Poll with raw fetch instead.
      const deadline = Date.now() + 3 * 60 * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await fetch(`${getApiBase()}/auth/plex/pin/${pin_id}`);
        if (res.status === 202) continue;
        if (res.status === 410) {
          setError("The Plex approval expired — try again.");
          return;
        }
        if (res.ok) {
          const result: TokenResponse = await res.json();
          await login(result.access_token);
          navigate("/servers");
          return;
        }
      }
      setError("Timed out waiting for Plex approval.");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong");
    } finally {
      if (plexPopup && !plexPopup.closed) plexPopup.close();
      setPlexPending(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-gradient-to-b from-brand-50/60 to-slate-50 dark:from-brand-950/30 dark:to-slate-950">
      <Card className="w-full max-w-sm space-y-4">
        <div className="flex flex-col items-center text-center gap-3 mb-1">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white shadow-sm shadow-brand-600/30">
            <Clapperboard className="h-5.5 w-5.5" />
          </span>
          <div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white">CreditEngine</h1>
            <p className="text-sm text-slate-500">On-demand credits detection for Plex</p>
          </div>
        </div>

        <ErrorBanner message={error} />

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="block text-sm font-medium mb-1">Email</label>
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Password</label>
            <Input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={submitting} className="w-full">
            {submitting ? <Spinner /> : mode === "login" ? "Log in" : "Create account"}
          </Button>
        </form>

        <button
          type="button"
          className="text-sm text-brand-600 dark:text-brand-400 hover:underline"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
        >
          {mode === "login" ? "Need an account? Create one" : "Already have an account? Log in"}
        </button>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
          or
          <div className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
        </div>

        <Button type="button" variant="secondary" onClick={handlePlexLogin} disabled={plexPending} className="w-full">
          {plexPending ? <Spinner /> : "Login with Plex"}
        </Button>
        {plexPending && (
          <p className="text-xs text-slate-500 text-center">Approve the request in the Plex popup…</p>
        )}
      </Card>
    </div>
  );
}
