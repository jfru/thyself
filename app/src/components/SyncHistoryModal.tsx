import { X, Mail, MessageCircle, MessageSquare, Smartphone } from "lucide-react";
import type { SyncStatus, SyncRun } from "../lib/types";

interface SyncHistoryModalProps {
  syncStatus: SyncStatus;
  onClose: () => void;
}

const SOURCE_META: Record<
  string,
  { label: string; icon: typeof Mail }
> = {
  gmail: { label: "Gmail", icon: Mail },
  imessage: { label: "iMessage", icon: MessageCircle },
  whatsapp_desktop: { label: "WhatsApp Desktop", icon: Smartphone },
  whatsapp_web: { label: "WhatsApp Web", icon: MessageSquare },
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso + "Z");
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso + "Z").getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function durationStr(started: string | null, finished: string | null): string {
  if (!started || !finished) return "—";
  const ms =
    new Date(finished + "Z").getTime() - new Date(started + "Z").getTime();
  if (ms < 1000) return "<1s";
  return `${Math.round(ms / 1000)}s`;
}

function StatusBadge({ status }: { status: string }) {
  if (status === "completed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
        Success
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-red-400">
        <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
        Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-amber-400">
      <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
      Running
    </span>
  );
}

function SourceCard({ run }: { run: SyncRun | undefined; source: string }) {
  if (!run) return null;
  const meta = SOURCE_META[run.source] || {
    label: run.source,
    icon: MessageCircle,
  };
  const Icon = meta.icon;

  const borderColor =
    run.status === "completed"
      ? "border-l-emerald-500"
      : run.status === "failed"
        ? "border-l-red-500"
        : "border-l-zinc-600";

  return (
    <div
      className={`bg-zinc-900 border border-zinc-800 border-l-2 ${borderColor} rounded-lg p-3 flex flex-col gap-1.5`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-zinc-400" />
          <span className="text-sm font-medium text-zinc-200">
            {meta.label}
          </span>
        </div>
        <StatusBadge status={run.status} />
      </div>
      <div className="flex items-center gap-4 text-xs text-zinc-500">
        <span>{formatDate(run.started_at)}</span>
        <span>{run.messages_added} messages</span>
      </div>
      {run.status === "failed" && run.error_message && (
        <p className="text-xs text-red-400/80 mt-0.5 truncate">
          {run.error_message}
        </p>
      )}
    </div>
  );
}

export function SyncHistoryModal({ syncStatus, onClose }: SyncHistoryModalProps) {
  const { latest_by_source, history } = syncStatus;

  const allLatest = Object.values(latest_by_source);
  const mostRecent = allLatest.reduce<SyncRun | null>((best, run) => {
    if (!best || (run.started_at && (!best.started_at || run.started_at > best.started_at))) {
      return run;
    }
    return best;
  }, null);

  const sources = ["gmail", "imessage", "whatsapp_desktop", "whatsapp_web"];

  // Group history by date
  const grouped: { date: string; runs: SyncRun[] }[] = [];
  const seen = new Set<string>();
  for (const run of history) {
    const dateKey = run.started_at
      ? new Date(run.started_at + "Z").toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : "Unknown";
    if (!seen.has(dateKey)) {
      seen.add(dateKey);
      grouped.push({ date: dateKey, runs: [] });
    }
    grouped[grouped.length - 1].runs.push(run);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h2 className="text-base font-semibold text-zinc-100">
            Sync History
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Summary */}
        <div className="px-5 py-3 border-b border-zinc-800/50">
          <p className="text-xs text-zinc-500">
            {mostRecent
              ? `Last synced ${timeAgo(mostRecent.started_at)}`
              : "No syncs recorded yet"}
            {mostRecent && " · Next sync Sunday 3:00 AM"}
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Source cards */}
          <div className="px-5 py-3 grid grid-cols-2 gap-2">
            {sources.map((s) => (
              <SourceCard
                key={s}
                source={s}
                run={latest_by_source[s]}
              />
            ))}
          </div>

          {/* History table */}
          {history.length > 0 && (
            <div className="px-5 pb-4">
              <h3 className="text-xs font-medium text-zinc-500 uppercase tracking-wider mb-2">
                Run History
              </h3>
              <div className="border border-zinc-800 rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-zinc-900/50 text-zinc-500">
                      <th className="text-left px-3 py-2 font-medium">Date</th>
                      <th className="text-left px-3 py-2 font-medium">
                        Source
                      </th>
                      <th className="text-right px-3 py-2 font-medium">
                        Messages
                      </th>
                      <th className="text-left px-3 py-2 font-medium">
                        Status
                      </th>
                      <th className="text-right px-3 py-2 font-medium">
                        Duration
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((run, i) => {
                      const meta = SOURCE_META[run.source] || {
                        label: run.source,
                      };
                      return (
                        <tr
                          key={run.id ?? i}
                          className="border-t border-zinc-800/50 hover:bg-zinc-900/30"
                          title={
                            run.error_message ? run.error_message : undefined
                          }
                        >
                          <td className="px-3 py-1.5 text-zinc-400">
                            {formatDate(run.started_at)}
                          </td>
                          <td className="px-3 py-1.5 text-zinc-300">
                            {meta.label}
                          </td>
                          <td className="px-3 py-1.5 text-right text-zinc-400">
                            {run.messages_added}
                          </td>
                          <td className="px-3 py-1.5">
                            <StatusBadge status={run.status} />
                          </td>
                          <td className="px-3 py-1.5 text-right text-zinc-500">
                            {durationStr(run.started_at, run.finished_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {history.length === 0 && (
            <div className="px-5 py-8 text-center text-zinc-600 text-sm">
              No sync runs yet. The first sync will run Sunday at 3:00 AM,
              <br />
              or run manually with{" "}
              <code className="text-zinc-500">python sync/run.py</code>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
