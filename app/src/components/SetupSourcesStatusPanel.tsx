import { useEffect, useMemo, useState } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import type { SyncRun, SyncStatus } from "../lib/types";
import { BrainCircuit, CheckCircle2, Mail, MessageCircle, MessageSquareText, Plus, Trash2 } from "lucide-react";

interface SetupSourcesStatusPanelProps {
  selectedSources: string[];
  onAddSource?: (sourceId: string) => void | Promise<void | string[]>;
  onRequestSourceSetup?: (
    sourceId: string,
    selectedSourcesOverride?: string[]
  ) => void | Promise<void>;
  onRemoveSource?: (sourceId: string) => void | Promise<void>;
}

type SourceId = "imessage" | "whatsapp" | "gmail" | "chatgpt";

const SOURCE_CONFIG: Array<{
  id: SourceId;
  name: string;
  icon: typeof MessageCircle;
  syncKeys: string[];
}> = [
  { id: "imessage", name: "iMessage", icon: MessageCircle, syncKeys: ["imessage"] },
  { id: "whatsapp", name: "WhatsApp", icon: MessageSquareText, syncKeys: ["whatsapp_desktop", "whatsapp_web"] },
  { id: "gmail", name: "Gmail", icon: Mail, syncKeys: ["gmail"] },
  { id: "chatgpt", name: "ChatGPT", icon: BrainCircuit, syncKeys: ["chatgpt"] },
];

function chooseLatestRun(runs: SyncRun[]): SyncRun | null {
  if (runs.length === 0) return null;
  return runs.reduce<SyncRun | null>((best, run) => {
    if (!best) return run;
    const a = run.started_at ?? "";
    const b = best.started_at ?? "";
    return a > b ? run : best;
  }, null);
}

function statusLabel(run: SyncRun | null, isSelected: boolean): { text: string; tone: string } {
  if (!isSelected) return { text: "Not selected", tone: "text-zinc-500" };
  if (!run || run.status === "failed") return { text: "Not connected", tone: "text-zinc-500" };
  return { text: "Connected", tone: "text-emerald-400" };
}

export function SetupSourcesStatusPanel({
  selectedSources,
  onAddSource,
  onRequestSourceSetup,
  onRemoveSource,
}: SetupSourcesStatusPanelProps) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [confirmRemoveSourceId, setConfirmRemoveSourceId] = useState<SourceId | null>(null);
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
    const interval = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, []);

  const selectedSet = useMemo(() => new Set(selectedSources), [selectedSources]);
  const selectedConfigs = SOURCE_CONFIG.filter((s) => selectedSet.has(s.id));
  const availableToAdd = SOURCE_CONFIG.filter((s) => !selectedSet.has(s.id));
  const sourceToConfirm = SOURCE_CONFIG.find((s) => s.id === confirmRemoveSourceId) || null;

  return (
    <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 py-3">
      <div className="mx-auto max-w-4xl">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider text-zinc-500">
            Data Sources
          </div>
          <div className="relative">
            <button
              onClick={() => setShowAddMenu((v) => !v)}
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              title="Add data source"
            >
              <span className="inline-flex items-center gap-1">
                <Plus size={12} />
                Add source
              </span>
            </button>
            {showAddMenu && availableToAdd.length > 0 && (
              <div className="absolute right-0 mt-1 w-44 rounded-md border border-zinc-700 bg-zinc-900 p-1 shadow-xl z-20">
                {availableToAdd.map((source) => (
                  <button
                    key={source.id}
                    onClick={async () => {
                      const updated = await onAddSource?.(source.id);
                      const selectedSourcesOverride = Array.isArray(updated)
                        ? updated
                        : undefined;
                      await onRequestSourceSetup?.(source.id, selectedSourcesOverride);
                      setShowAddMenu(false);
                    }}
                    className="w-full rounded px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {source.name}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {selectedConfigs.map((source) => {
            const Icon = source.icon;
            const runs = source.syncKeys
              .map((k) => syncStatus?.latest_by_source?.[k])
              .filter(Boolean) as SyncRun[];
            const latest = chooseLatestRun(runs);
            const status = statusLabel(latest, true);
            const isConnected = status.text === "Connected";

            return (
              <div
                key={source.id}
                onClick={async () => {
                  if (!isConnected) {
                    await onRequestSourceSetup?.(source.id);
                  }
                }}
                className="cursor-pointer rounded-lg border border-zinc-700 bg-zinc-900/70 px-3 py-2 text-left hover:bg-zinc-800/80"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon size={14} className="text-zinc-300" />
                    <span className="text-xs text-zinc-300">
                      {source.name}
                    </span>
                  </div>
                  <button
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setConfirmRemoveSourceId(source.id);
                    }}
                    className="rounded p-1 text-zinc-500 hover:bg-zinc-700/60 hover:text-red-300"
                    title={`Remove ${source.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-1.5">
                  {isConnected ? (
                    <CheckCircle2 size={12} className="text-emerald-400" />
                  ) : (
                    <span className="inline-block h-2 w-2 rounded-full bg-zinc-500" />
                  )}
                  <span className={`text-[11px] ${status.tone}`}>{status.text}</span>
                </div>
              </div>
            );
          })}
          {selectedConfigs.length === 0 && (
            <div className="col-span-2 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-xs text-zinc-500">
              No data sources selected yet. Use + Add source.
            </div>
          )}
        </div>
        {sourceToConfirm && (
          <div className="mt-3 rounded-lg border border-red-900 bg-red-950/30 px-3 py-3">
            <p className="text-xs text-red-200">
              Remove <span className="font-medium">{sourceToConfirm.name}</span>? This will delete all {sourceToConfirm.name} data from Thyself.
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
