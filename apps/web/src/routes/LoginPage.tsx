import { useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { deriveErrorMessage, signInUrl } from "../lib/signIn";

// There is no separate sign-up and no password. A Deriv account IS the DerivDesk account: the first
// time someone continues with Deriv, one is created for them; after that it signs them back in.
export function LoginPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);

  // The failure code arrives in the URL; show it once and clean the address bar.
  useEffect(() => {
    const code = params.get("deriv_error");
    if (code) {
      setError(deriveErrorMessage(code));
      setParams({}, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="login-screen">
      <div className="card login-card">
        <div className="app-shell__brand">DerivDesk</div>
        <h1 style={{ fontSize: 17, margin: "4px 0 0" }}>Sign in with your Deriv account</h1>
        <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>
          DerivDesk has no separate sign-up or password: your Deriv account is your DerivDesk account. The first time you
          continue, we set it up for you.
        </p>

        {error && (
          <div className="error-text" role="alert">
            {error}
          </div>
        )}

        {/* A real link (full-page navigation), not a fetch: the API redirects the browser to Deriv. */}
        <a className="button" href={signInUrl()} style={{ textAlign: "center", textDecoration: "none" }}>
          Continue with Deriv
        </a>

        <p style={{ color: "var(--text-muted)", fontSize: 12, margin: 0 }}>
          You sign in on Deriv's own page — DerivDesk never sees your Deriv password, and you can revoke access any time in
          your Deriv account settings. Don't have a Deriv account yet?{" "}
          <a href="https://deriv.com/" target="_blank" rel="noopener noreferrer">
            Create one at deriv.com
          </a>
          .
        </p>
      </div>
    </div>
  );
}
