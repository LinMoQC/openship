"use client";
import { useState } from "react";
import type { AdvertisedAuthProvider } from "@repo/contracts";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { authClient } from "@/lib/auth-client";
import { api, getApiErrorMessage } from "@/lib/api/client";

/** Link the current platform user, requesting repository access only when
 * they explicitly connect for releases. Server clone credentials are separate. */
export function ReleaseGitHubConnect() {
  const c = useI18n().t.projects.release;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function connect() {
    if (pending) return;
    setPending(true); setError(null);
    try {
      const health = await api.get<{ authProviders?: AdvertisedAuthProvider[] }>("health/env");
      if (!health.authProviders?.some(p => p.id === "github" && p.kind === "social")) {
        setError(c.githubSetup); return;
      }
      const result = await authClient.linkSocial({ provider: "github", scopes: ["repo"],
        callbackURL: window.location.href, errorCallbackURL: window.location.href });
      if (result.error) setError(result.error.message ?? c.githubLinkError);
    } catch (e) { setError(getApiErrorMessage(e, c.githubLinkError)); }
    finally { setPending(false); }
  }
  return <div className="min-w-0 space-y-2">
    <Button variant="outline" size="sm" disabled={pending} onClick={() => void connect()}>{pending ? c.githubLinking : c.githubConnect}</Button>
    {error && <p role="status" className="max-w-xl break-words text-xs text-muted-foreground">{error}</p>}
  </div>;
}
