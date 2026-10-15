"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { cn } from "cn";
import { numeric } from "@/lib/utils";
import { useSentinelStore } from "@/lib/store/sentinel-store";
import { API_BASE_URL, IS_LIVE } from "@/lib/api/mode";
import { loginLive } from "@/lib/live/live-connection";
import { Panel, PanelHeader } from "@/components/ui/panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Live mode only: hold the page until the backend's first snapshot lands, so
 * seeded demo figures are never shown as if they were live telemetry. When the
 * backend requires a session, this is also the sign-in screen.
 */
export function LiveGate({ children }: { children: ReactNode }) {
  const ready = useSentinelStore((s) => s.liveReady);
  const connection = useSentinelStore((s) => s.connection);
  const authState = useSentinelStore((s) => s.authState);

  if (!IS_LIVE || ready) return <>{children}</>;
  if (authState === "signed_out") return <SignIn />;

  const lost = connection === "lost";
  return (
    <div className="mx-auto max-w-xl pt-12">
      <Panel>
        <PanelHeader
          title={lost ? "Backend unreachable" : "Connecting to SentinelOps backend"}
          actions={
            <span className="flex items-center gap-1.5">
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  lost ? "bg-crit animate-pulse" : "bg-warn animate-pulse",
                )}
              />
              <span className={cn("text-xs text-muted", numeric)}>
                {API_BASE_URL || "same origin"}
              </span>
            </span>
          }
        />
        <div className="flex flex-col gap-2 px-4 py-4 text-sm text-text-2">
          {lost ? (
            <>
              <p>
                The console runs in live mode but cannot reach the API. Start the stack
                from the project folder, then this page connects on its own:
              </p>
              <code className={cn("rounded-md border border-border bg-bg px-3 py-2 text-xs text-text", numeric)}>
                docker compose -f docker-compose.live.yml up -d
              </code>
            </>
          ) : (
            <p>Waiting for the first telemetry snapshot…</p>
          )}
        </div>
      </Panel>
    </div>
  );
}

function SignIn() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginLive(username, password);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-sm pt-12">
      <Panel>
        <PanelHeader title="Sign in to SentinelOps" />
        <form onSubmit={submit} className="flex flex-col gap-3 px-4 py-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="sentinel-user" className="text-xs text-muted">
              Username
            </Label>
            <Input
              id="sentinel-user"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="sentinel-pass" className="text-xs text-muted">
              Password
            </Label>
            <Input
              id="sentinel-pass"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error ? <p className="text-sm text-crit-text">{error}</p> : null}
          <Button type="submit" disabled={busy || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Panel>
    </div>
  );
}
