import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../api/client";

/**
 * The Personal Access Token is typed here, in the user's own browser tab,
 * and posted directly to the local FastAPI backend, which stores it via
 * the OS keyring. It never travels anywhere else and this component never
 * logs or persists it client-side beyond the input field itself.
 */
export function TokenSetup() {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const mutation = useMutation({
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
      <p>
        Paste a Crowdin Personal Access Token (Account Settings → API on crowdin.com). It's
        stored in your OS credential manager, not in a file.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) mutation.mutate(token.trim());
        }}
      >
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Crowdin Personal Access Token"
          autoComplete="off"
        />
        <button type="submit" disabled={mutation.isPending || !token.trim()}>
          {mutation.isPending ? "Checking…" : "Connect"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
