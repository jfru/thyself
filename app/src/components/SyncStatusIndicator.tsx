import { useState, useEffect, useCallback } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import { SyncHistoryModal } from "./SyncHistoryModal";
import type { SyncStatus } from "../lib/types";

function compactNumber(n: number): string {
  if (n >= 1_000_000) return Math.round(n / 1_000_000) + "m";
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return n.toString();
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso + "Z").getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SyncStatusIndicator() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [manualSyncBusy, setManualSyncBusy] = useState(false);

  const loadSyncStatus = useCallback(async () => {
    try {
      const status = await invokeCommand<SyncStatus>("get_sync_status");
      setSyncStatus(status);
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const status = await invokeCommand<SyncStatus>("get_sync_status");
        if (alive) setSyncStatus(status);
      } catch {
        // best effort
      }
    };
    load();
    const interval = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  /** While any source reports running, poll often so the pill/modal update when sync finishes. */
  useEffect(() => {
    if (!syncStatus) return;
    const anyRunning = Object.values(syncStatus.latest_by_source).some(
      (r) => r.status === "running"
    );
    if (!anyRunning) return;
    const id = setInterval(() => {
      void loadSyncStatus();
    }, 2000);
    return () => clearInterval(id);
  }, [syncStatus, loadSyncStatus]);

  const handleManualSync = async () => {
    setManualSyncBusy(true);
    try {
      await invokeCommand("trigger_manual_sync");
      await loadSyncStatus();
    } catch (e) {
      console.error(e);
      window.alert(
        `Could not start sync: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      setManualSyncBusy(false);
    }
  };

  if (!syncStatus) return null;

  const latest = Object.values(syncStatus.latest_by_source);
  if (latest.length === 0 && !syncStatus.has_sync_runs) return null;

  const anyFailed = latest.some((r) => r.status === "failed");
  const anyRunning = latest.some((r) => r.status === "running");
  const mostRecent = latest.reduce<(typeof latest)[0] | null>((best, run) => {
    if (!best || (run.started_at && (!best.started_at || run.started_at > best.started_at))) {
      return run;
    }
    return best;
  }, null);

  const totalMessages = latest.reduce((sum, r) => sum + r.messages_added, 0);
  const failedSources = Array.from(
    new Set(
      latest
        .filter((r) => r.status === "failed")
        .map((r) => {
          const labels: Record<string, string> = {
            gmail: "Gmail",
            imessage: "iMessage",
            whatsapp_desktop: "WhatsApp US",
            whatsapp_web: "WhatsApp UK",
            whatsapp: "WhatsApp US",
            apple_mail: "Apple Mail",
            apple_mail_v1: "Apple Mail",
          };
          return labels[r.source] || r.source;
        })
    )
  );

  const dotColor = anyRunning
    ? "bg-amber-400 animate-pulse"
    : anyFailed
      ? "bg-amber-400"
      : "bg-emerald-400";

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="flex items-center gap-2 text-xs text-zinc-500 hover:text-zinc-300 px-2.5 py-1 rounded-lg hover:bg-zinc-800/50 border border-transparent hover:border-zinc-800 transition-colors"
      >
        <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
        <span>
          {anyRunning ? "Syncing..." : "Last sync:"} {timeAgo(mostRecent?.started_at ?? null)}
          {totalMessages > 0 &&
            ` — ${compactNumber(totalMessages)} new (last run)`}
        </span>
        {failedSources.length > 0 && (
          <span className="text-amber-400">
            · {failedSources.join(", ")} failed
          </span>
        )}
      </button>

      {showModal && (
        <SyncHistoryModal
          syncStatus={syncStatus}
          onClose={() => setShowModal(false)}
          onManualSync={handleManualSync}
          manualSyncBusy={manualSyncBusy}
        />
      )}
    </>
  );
}
