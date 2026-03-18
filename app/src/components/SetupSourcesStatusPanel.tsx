import { useEffect, useMemo, useState } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import type { SyncRun, SyncStatus } from "../lib/types";
import {
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Database,
  Mail,
  MessageCircle,
  MessageSquareText,
  Plus,
  Trash2,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface SetupSourcesStatusPanelProps {
  selectedSources: string[];
  connectedSources?: string[];
  onAddSourceMessage?: () => void;
  onRequestSourceSetup?: (
    sourceId: string,
    selectedSourcesOverride?: string[]
  ) => void | Promise<void>;
  onRemoveSource?: (sourceId: string) => void | Promise<void>;
}

const KNOWN_SOURCES: Record<
  string,
  { name: string; icon: LucideIcon; syncKeys: string[] }
> = {
  imessage: { name: "iMessage", icon: MessageCircle, syncKeys: ["imessage"] },
  whatsapp: {
    name: "WhatsApp",
    icon: MessageSquareText,
    syncKeys: ["whatsapp_desktop", "whatsapp_web"],
  },
  gmail: { name: "Gmail", icon: Mail, syncKeys: ["gmail"] },
  chatgpt: { name: "ChatGPT", icon: BrainCircuit, syncKeys: ["chatgpt"] },
};

function sourceDisplayName(id: string): string {
  if (KNOWN_SOURCES[id]) return KNOWN_SOURCES[id].name;
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function sourceIcon(id: string): LucideIcon {
  return KNOWN_SOURCES[id]?.icon ?? Database;
}

function sourceSyncKeys(id: string): string[] {
  return KNOWN_SOURCES[id]?.syncKeys ?? [id];
}

function chooseLatestRun(runs: SyncRun[]): SyncRun | null {
  if (runs.length === 0) return null;
  return runs.reduce<SyncRun | null>((best, run) => {
    if (!best) return run;
    const a = run.started_at ?? "";
    const b = best.started_at ?? "";
    return a > b ? run : best;
  }, null);
}

function statusLabel(
  run: SyncRun | null,
  knownConnected: boolean
): { text: string; tone: string } {
  if (!run) {
    if (knownConnected) return { text: "Connected", tone: "text-emerald-400" };
    return { text: "Not connected", tone: "text-zinc-500" };
  }
  if (run.status === "running")
    return { text: "Connecting...", tone: "text-amber-400" };
  if (run.status === "failed")
    return { text: "Not connected", tone: "text-zinc-500" };
  return { text: "Connected", tone: "text-emerald-400" };
}

export function SetupSourcesStatusPanel({
  selectedSources,
  connectedSources,
  onAddSourceMessage,
  onRequestSourceSetup,
  onRemoveSource,
}: SetupSourcesStatusPanelProps) {
  const connectedSet = useMemo(
    () => new Set(connectedSources ?? []),
    [connectedSources]
  );
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [confirmRemoveSourceId, setConfirmRemoveSourceId] = useState<
    string | null
  >(null);
  const [isRemoving, setIsRemoving] = useState(false);

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
    const interval = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const sourceToConfirmName = confirmRemoveSourceId
    ? sourceDisplayName(confirmRemoveSourceId)
    : null;

  const [expanded, setExpanded] = useState(false);

  const sourceStatuses = useMemo(() => {
    return selectedSources.map((sourceId) => {
      const syncKeys = sourceSyncKeys(sourceId);
      const runs = syncKeys
        .map((k) => syncStatus?.latest_by_source?.[k])
        .filter(Boolean) as SyncRun[];
      const latest = chooseLatestRun(runs);
      const isKnownConnected =
        syncKeys.some((k) => connectedSet.has(k)) ||
        connectedSet.has(sourceId);
      return statusLabel(latest, isKnownConnected);
    });
  }, [selectedSources, syncStatus, connectedSet]);

  const connectedCount = sourceStatuses.filter(
    (s) => s.text === "Connected"
  ).length;
  const connectingCount = sourceStatuses.filter(
    (s) => s.text === "Connecting..."
  ).length;

  if (selectedSources.length === 0) {
    return (
      <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-2.5">
        <div className="mx-auto max-w-4xl flex items-center justify-between">
          <span className="text-xs text-zinc-500">
            No data sources yet — the agent will help you add them.
          </span>
          <button
            onClick={() => onAddSourceMessage?.()}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            title="Add data source"
          >
            <span className="inline-flex items-center gap-1">
              <Plus size={12} />
              Add source
            </span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-2.5">
      <div className="mx-auto max-w-4xl">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex w-full items-center gap-2 text-left group"
        >
          {expanded ? (
            <ChevronDown size={14} className="text-zinc-500 group-hover:text-zinc-300 flex-shrink-0" />
          ) : (
            <ChevronRight size={14} className="text-zinc-500 group-hover:text-zinc-300 flex-shrink-0" />
          )}
          <div className="flex items-center gap-1.5 min-w-0">
            {selectedSources.map((sourceId) => {
              const Icon = sourceIcon(sourceId);
              return (
                <Icon
                  key={sourceId}
                  size={13}
                  className="text-zinc-400 flex-shrink-0"
                />
              );
            })}
          </div>
          <span className="text-xs text-zinc-500 group-hover:text-zinc-300 whitespace-nowrap">
            {selectedSources.length} source{selectedSources.length !== 1 ? "s" : ""}
            {connectedCount > 0 && (
              <span className="text-emerald-400/80 ml-1">
                · {connectedCount} connected
              </span>
            )}
            {connectingCount > 0 && (
              <span className="text-amber-400/80 ml-1">
                · {connectingCount} connecting
              </span>
            )}
          </span>
          <div className="flex-1" />
          <span
            onClick={(e) => {
              e.stopPropagation();
              onAddSourceMessage?.();
            }}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 inline-flex items-center gap-1 flex-shrink-0"
          >
            <Plus size={12} />
            Add source
          </span>
        </button>

        {expanded && (
          <div className="mt-2 grid grid-cols-2 gap-2">
            {selectedSources.map((sourceId, idx) => {
              const Icon = sourceIcon(sourceId);
              const name = sourceDisplayName(sourceId);
              const status = sourceStatuses[idx];
              const syncKeys = sourceSyncKeys(sourceId);
              const runs = syncKeys
                .map((k) => syncStatus?.latest_by_source?.[k])
                .filter(Boolean) as SyncRun[];
              const latest = chooseLatestRun(runs);
              const progressText =
                latest?.status === "running" &&
                typeof latest.progress_processed === "number" &&
                typeof latest.progress_total === "number" &&
                latest.progress_total > 0
                  ? `${latest.progress_processed}/${latest.progress_total}`
                  : null;
              const canStartSetup = status.text === "Not connected";

              return (
                <div
                  key={sourceId}
                  onClick={async () => {
                    if (canStartSetup) {
                      await onRequestSourceSetup?.(sourceId);
                    }
                  }}
                  className="cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-left hover:bg-zinc-800/80"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Icon size={14} className="text-zinc-300" />
                      <span className="text-xs text-zinc-300">{name}</span>
                    </div>
                    <button
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setConfirmRemoveSourceId(sourceId);
                      }}
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-700/60 hover:text-red-300"
                      title={`Remove ${name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        status.text === "Connected"
                          ? "bg-emerald-400"
                          : status.text === "Connecting..."
                            ? "bg-amber-400 animate-pulse"
                            : "bg-zinc-500"
                      }`}
                    />
                    <span className={`text-[11px] ${status.tone}`}>
                      {status.text}
                    </span>
                    {progressText && (
                      <span className="text-[11px] text-zinc-400">
                        ({progressText})
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {expanded && confirmRemoveSourceId && sourceToConfirmName && (
          <div className="mt-3 rounded-lg border border-red-900 bg-red-950/30 px-3 py-3">
            <p className="text-xs text-red-200">
              Remove{" "}
              <span className="font-medium">{sourceToConfirmName}</span>? This
              will delete all {sourceToConfirmName} data from Thyself.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={async () => {
                  if (!onRemoveSource || !confirmRemoveSourceId) return;
                  try {
                    setIsRemoving(true);
                    await onRemoveSource(confirmRemoveSourceId);
                    setConfirmRemoveSourceId(null);
                  } finally {
                    setIsRemoving(false);
                  }
                }}
                disabled={isRemoving}
                className="rounded bg-red-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {isRemoving ? "Removing..." : "Yes, remove"}
              </button>
              <button
                onClick={() => setConfirmRemoveSourceId(null)}
                disabled={isRemoving}
                className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
