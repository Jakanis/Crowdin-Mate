import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../api/client";

const REDIRECT_URI = "http://localhost:8000/oauth/callback";
const OAUTH_APPS_URL = "https://crowdin.com/settings#oauth-apps";
const API_KEY_URL = "https://crowdin.com/settings#api-key";

type Mode = "choose" | "oauth" | "pat";

/**
 * Both auth methods are equally first-class here — deliberately NOT
 * defaulting into one over the other, since each person's own account
 * brings its own credentials either way (no shared/published OAuth
 * app — every user registers their own, same as the PAT path already
 * required). The initial screen is a neutral choice between them; only
 * once someone's OAuth app was configured in an earlier session do we
 * skip straight back to "Connect with Crowdin" for it, since re-showing
 * the choice at that point would just be re-asking a question they
 * already answered.
 *
 * OAuth: the user creates a Crowdin OAuth app once (Settings → OAuth →
 * New Application — something only they can do, it's their account),
 * pastes the Client ID/Secret here, then "Connect with Crowdin" opens
 * the real authorization page in a normal browser tab. The backend's
 * own /oauth/callback route catches the redirect and exchanges the
 * code — this component just polls auth-status until that's landed.
 *
 * PAT: paste a token directly, no app registration at all — simpler
 * for a quick one-off setup, at the cost of managing the token/its
 * expiry yourself instead of Crowdin auto-refreshing it.
 */
export function TokenSetup() {
  const [mode, setMode] = useState<Mode | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const queryClient = useQueryClient();

  const authStatus = useQuery({
    queryKey: ["auth-status"],
    queryFn: api.authStatus,
    refetchInterval: connecting ? 1500 : false,
  });

  // Decide the starting screen exactly once, the first time auth-status
  // actually loads — not on every refetch, which would otherwise yank
  // whoever's mid-setup back to a mode they didn't choose.
  useEffect(() => {
    if (mode !== null || !authStatus.data) return;
    setMode(authStatus.data.oauth_client_configured ? "oauth" : "choose");
  }, [authStatus.data, mode]);

  const clientMutation = useMutation({
    mutationFn: () => api.setOAuthClient(clientId.trim(), clientSecret.trim()),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const patMutation = useMutation({
    mutationFn: (t: string) => api.setToken(t),
    onSuccess: () => {
      setToken("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  // Hooks above this line must always run regardless of `mode` (Rules
  // of Hooks) — only the JSX below is conditional on it.
  if (mode === null) return <div className="token-setup" />;

  const connect = async () => {
    setError(null);
    setConnecting(true);
    try {
      const { url } = await api.getOAuthAuthorizeUrl();
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError((err as Error).message);
      setConnecting(false);
    }
  };

  return (
    <div className="token-setup">
      <h2>Connect your Crowdin account</h2>

      {mode === "choose" && (
        <div className="token-setup-choice">
          <button className="token-setup-choice-card" onClick={() => setMode("oauth")}>
            <span className="token-setup-choice-title">OAuth</span>
            <span className="token-setup-choice-desc">
              Log in through Crowdin's own page instead of handling a token — it auto-refreshes, so you stay
              connected. Needs a one-time OAuth app registration on your Crowdin account first.
            </span>
          </button>
          <button className="token-setup-choice-card" onClick={() => setMode("pat")}>
            <span className="token-setup-choice-title">Personal Access Token</span>
            <span className="token-setup-choice-desc">
              Paste a token and you're connected immediately, no setup — but you're responsible for renewing it
              when it expires.
            </span>
          </button>
        </div>
      )}

      {mode === "oauth" && (
        <>
          {!authStatus.data?.oauth_client_configured ? (
            <>
              <p>
                One-time setup:{" "}
                <a href={OAUTH_APPS_URL} target="_blank" rel="noopener noreferrer">
                  create an OAuth app
                </a>{" "}
                (New Application), using this exact callback URL:
              </p>
              <code className="token-setup-redirect-uri">{REDIRECT_URI}</code>
              <p>Select all the scopes you can (projects, files, translations, comments, TM, glossaries), then paste its Client ID and Secret below.</p>
              <form
                className="token-setup-oauth-client-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (clientId.trim() && clientSecret.trim()) clientMutation.mutate();
                }}
              >
                <input
                  type="text"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="Client ID"
                  autoComplete="off"
                />
                <input
                  type="password"
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder="Client Secret"
                  autoComplete="off"
                />
                <button type="submit" disabled={clientMutation.isPending || !clientId.trim() || !clientSecret.trim()}>
                  {clientMutation.isPending ? "Saving…" : "Save"}
                </button>
              </form>
            </>
          ) : (
            <>
              <p>Opens a normal Crowdin login/authorization page in a new tab.</p>
              <button onClick={connect} disabled={connecting}>
                {connecting ? "Waiting for authorization…" : "Connect with Crowdin"}
              </button>
            </>
          )}
          <p className="token-setup-switch">
            <button className="link-button" onClick={() => setMode("choose")}>
              ← Choose a different method
            </button>
          </p>
        </>
      )}

      {mode === "pat" && (
        <>
          <p>
            Paste a{" "}
            <a href={API_KEY_URL} target="_blank" rel="noopener noreferrer">
              Crowdin Personal Access Token
            </a>
            . It's stored in your OS credential manager, not in a file.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (token.trim()) patMutation.mutate(token.trim());
            }}
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Crowdin Personal Access Token"
              autoComplete="off"
            />
            <button type="submit" disabled={patMutation.isPending || !token.trim()}>
              {patMutation.isPending ? "Checking…" : "Connect"}
            </button>
          </form>
          <p className="token-setup-switch">
            <button className="link-button" onClick={() => setMode("choose")}>
              ← Choose a different method
            </button>
          </p>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
