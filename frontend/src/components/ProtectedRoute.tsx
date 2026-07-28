import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { Spinner } from "./ui";

export default function ProtectedRoute() {
  const { me, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (!me) return <Navigate to="/auth" replace />;

  return <Outlet />;
}
