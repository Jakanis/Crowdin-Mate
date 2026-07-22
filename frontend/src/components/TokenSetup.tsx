import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";

const REDIRECT_URI = "http://127.0.0.1:8000/oauth/callback";

/**
 * OAuth (recommended) is the default path: the user creates a Crowdin
 * OAuth app once (Settings → OAuth → New Application — something only
 * they can do, it's their account), pastes the Client ID/Secret here,
 * then "Connect with Crowdin" opens the real authorization page in a
 * normal browser tab. The backend's own /oauth/callback route catches
 * the redirect and exchanges the code — this component just polls
 * auth-status until that's landed.
 *
 * The original manual-PAT flow stays as a fallback behind a toggle —
 * simpler for a quick one-off setup, no app registration required.
 */
export function TokenSetup() {
  const [mode, setMode] = useState<"oauth" | "pat">("oauth");
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

  const clientMutation = useMutation({
    mutationFn: () => api.setOAuthClient(clientId.trim(), clientSecret.trim()),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

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

  const patMutation = useMutation({
    mutationFn: (t: string) => api.setToken(t),
    onSuccess: () => {
      setToken("");
      setError(null);
      queryClient.invalidateQueries({ queryKey: ["auth-status"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="token-setup">
      <h2>Connect your Crowdin account</h2>

      {mode === "oauth" ? (
        <>
          {!authStatus.data?.oauth_client_configured ? (
            <>
              <p>
                One-time setup: create an OAuth app at crowdin.com → your avatar → Settings → OAuth
                → New Application, using this exact callback URL:
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
            <button className="link-button" onClick={() => setMode("pat")}>
              Use a Personal Access Token instead
            </button>
          </p>
        </>
      ) : (
        <>
          <p>
            Paste a Crowdin Personal Access Token (Account Settings → API on crowdin.com). It's
            stored in your OS credential manager, not in a file.
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
            <button className="link-button" onClick={() => setMode("oauth")}>
              Use OAuth instead (recommended)
            </button>
          </p>
        </>
      )}

      {error && <p className="error">{error}</p>}
    </div>
  );
}
