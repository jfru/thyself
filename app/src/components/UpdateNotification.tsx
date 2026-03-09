import { useState, useEffect, useCallback } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export function UpdateNotification() {
  const [ready, setReady] = useState(false);
  const [version, setVersion] = useState("");
  const [dismissed, setDismissed] = useState(false);

  const checkAndInstall = useCallback(async () => {
    try {
      const update = await check();
      if (!update) return;

      setVersion(update.version);
      await update.downloadAndInstall();
      setReady(true);
    } catch {
      // Silently ignore — network issues, no releases yet, etc.
    }
  }, []);

  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) return;

    checkAndInstall();
    const interval = setInterval(checkAndInstall, CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkAndInstall]);

  if (!ready || dismissed) return null;

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-blue-600/90 text-white text-sm backdrop-blur-sm border-b border-blue-500/50 shrink-0">
      <span className="font-medium">
        Update installed (v{version}) — restart to apply
      </span>
      <div className="flex items-center gap-2">
        <button
          onClick={() => setDismissed(true)}
          className="px-3 py-1 rounded text-blue-100 hover:text-white hover:bg-blue-500/50 transition-colors"
        >
          Later
        </button>
        <button
          onClick={() => relaunch()}
          className="px-3 py-1 rounded bg-white text-blue-700 font-medium hover:bg-blue-50 transition-colors"
        >
          Restart
        </button>
      </div>
    </div>
  );
}
