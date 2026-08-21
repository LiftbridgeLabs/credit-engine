import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, KeyRound, LogOut, Mail, RefreshCw } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, ErrorBanner, Input } from "../components/ui";
import { useToast } from "../components/toast";

export default function AccountPage() {
  const { me, refresh, logout } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();

  const [email, setEmail] = useState(me?.email ?? "");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [emailSubmitting, setEmailSubmitting] = useState(false);

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  if (!me) return null;

  async function submitEmail(e: FormEvent) {
    e.preventDefault();
    setEmailError(null);
    setEmailSubmitting(true);
    try {
      await api.patch("/auth/email", { email });
      await refresh();
      toast("Email updated");
    } catch (err) {
      setEmailError(err instanceof ApiError ? err.message : "Failed to update email");
    } finally {
      setEmailSubmitting(false);
    }
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    setPasswordSubmitting(true);
    try {
      await api.patch("/auth/password", {
        current_password: me!.has_password ? currentPassword : undefined,
        new_password: newPassword,
      });
      await refresh();
      setCurrentPassword("");
      setNewPassword("");
      toast(me!.has_password ? "Password updated" : "Password set");
    } catch (err) {
      setPasswordError(err instanceof ApiError ? err.message : "Failed to update password");
    } finally {
      setPasswordSubmitting(false);
    }
  }

  function reauthorizePlex() {
    logout();
    navigate("/auth");
  }

  return (
    <div className="max-w-lg space-y-5">
      <div>
        <Link to="/servers" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 dark:hover:text-brand-400 mb-2">
          <ArrowLeft className="h-3.5 w-3.5" />
          All servers
        </Link>
        <h1 className="text-xl font-semibold text-slate-900 dark:text-white">Account</h1>
        {me.plex_username && <p className="text-sm text-slate-500">Signed in with Plex as {me.plex_username}</p>}
      </div>

      <Card className="space-y-3">
        <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
          <RefreshCw className="h-4 w-4 text-slate-400" />
          Plex authorization
        </div>
        <p className="text-sm text-slate-500">
          Re-authorize this account with Plex if your Plex session has expired or you need to refresh server access.
          Your linked servers will remain here.
        </p>
        <Button icon={<RefreshCw className="h-4 w-4" />} onClick={reauthorizePlex}>
          Re-authorize with Plex
        </Button>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
          <Mail className="h-4 w-4 text-slate-400" />
          Email
        </div>
        <form onSubmit={submitEmail} className="space-y-3">
          <ErrorBanner message={emailError} />
          <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Button type="submit" disabled={emailSubmitting || email === me.email}>
            Save email
          </Button>
        </form>
      </Card>

      <Card className="space-y-3">
        <div className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
          <KeyRound className="h-4 w-4 text-slate-400" />
          Password
        </div>
        {!me.has_password && (
          <p className="text-sm text-slate-500">
            You signed in with Plex and haven't set a local password yet — set one below as a backup way to log in.
          </p>
        )}
        <form onSubmit={submitPassword} className="space-y-3">
          <ErrorBanner message={passwordError} />
          {me.has_password && (
            <div>
              <label className="block text-sm font-medium mb-1">Current password</label>
              <Input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </div>
          )}
          <div>
            <label className="block text-sm font-medium mb-1">New password</label>
            <Input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={passwordSubmitting || !newPassword}>
            {me.has_password ? "Update password" : "Set password"}
          </Button>
        </form>
      </Card>

      <Button variant="secondary" icon={<LogOut className="h-4 w-4" />} onClick={reauthorizePlex}>
        Sign out
      </Button>
    </div>
  );
}
