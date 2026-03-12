import { useEffect, useState, useCallback } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import {
  Sparkles,
  Check,
  Loader2,
  AlertTriangle,
  X,
} from "lucide-react";

export interface PortraitRunStatus {
  id: number;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  phase: string;
  total_batches: number | null;
  completed_batches: number | null;
  synthesis_batches: number | null;
  synthesis_completed: number | null;
  error_message: string | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  extraction_months_covered: string | null;
  results_summary: string | null;
}

interface PortraitBuildPanelProps {
  portraitStatus: PortraitRunStatus | null;
  onRefresh: () => void;
}

const PHASES = [
  { key: "preparing", label: "Preparing" },
  { key: "extracting", label: "Extracting" },
  { key: "ingesting_extraction", label: "Processing" },
  { key: "synthesizing", label: "Synthesizing" },
  { key: "ingesting_synthesis", label: "Finalizing" },
  { key: "completed", label: "Done" },
] as const;

function formatElapsed(startedAt: string | null): string {
  if (!startedAt) return "";
  const start = new Date(startedAt + "Z").getTime();
  const now = Date.now();
  const seconds = Math.floor((now - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m`;
}

export function PortraitBuildPanel({
  portraitStatus,
  onRefresh,
}: PortraitBuildPanelProps) {
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [elapsed, setElapsed] = useState("");

  const status = portraitStatus;

  useEffect(() => {
    if (!status || status.status !== "running") return;
    setElapsed(formatElapsed(status.started_at));
    const interval = setInterval(() => {
      setElapsed(formatElapsed(status.started_at));
    }, 1000);
    return () => clearInterval(interval);
  }, [status?.status, status?.started_at]);

  const handleCancel = useCallback(async () => {
    setIsCancelling(true);
    try {
      await invokeCommand("cancel_portrait_build");
      onRefresh();
    } catch (err) {
      console.error("Failed to cancel portrait build:", err);
    } finally {
      setIsCancelling(false);
      setShowCancelConfirm(false);
    }
  }, [onRefresh]);

  if (!status || status.status === "cancelled") return null;
  if (status.status === "completed") return <CompletedPanel status={status} />;
  if (status.status === "failed")
    return <FailedPanel status={status} onRefresh={onRefresh} />;
  if (status.status === "interrupted")
    return <InterruptedPanel status={status} onRefresh={onRefresh} />;

  const currentPhaseIndex = PHASES.findIndex((p) => p.key === status.phase);

  const batchProgress =
    status.phase === "extracting" &&
    status.total_batches &&
    status.completed_batches != null
      ? `${status.completed_batches}/${status.total_batches}`
      : status.phase === "synthesizing" &&
          status.synthesis_batches &&
          status.synthesis_completed != null
        ? `${status.synthesis_completed}/${status.synthesis_batches}`
        : null;

  return (
    <div className="mx-4 mt-3 mb-1 rounded-xl border border-amber-500/20 bg-zinc-900/80 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles size={14} className="text-amber-400" />
            <span className="text-xs font-medium text-amber-400">
              Building your portrait
            </span>
          </div>
          <div className="flex items-center gap-3">
            {elapsed && (
              <span className="text-[11px] text-zinc-500 tabular-nums">
                {elapsed}
              </span>
            )}
            {showCancelConfirm ? (
              <div className="flex items-center gap-2 bg-zinc-800 border border-zinc-700 rounded-lg px-2.5 py-1 shadow-lg">
                <span className="text-[11px] text-zinc-400">
                  Stop build and discard progress?
                </span>
                <button
                  onClick={handleCancel}
                  disabled={isCancelling}
                  className="text-[11px] text-red-400 hover:text-red-300 font-medium px-1.5 py-0.5 rounded hover:bg-red-400/10 transition-colors disabled:opacity-50"
                >
                  {isCancelling ? "Stopping..." : "Stop"}
                </button>
                <button
                  onClick={() => setShowCancelConfirm(false)}
                  className="text-[11px] text-zinc-500 hover:text-zinc-300 px-1.5 py-0.5 rounded hover:bg-zinc-700 transition-colors"
                >
                  Keep going
                </button>
              </div>
            ) : (
              <button
                onClick={() => setShowCancelConfirm(true)}
                className="text-zinc-600 hover:text-zinc-400 transition-colors p-0.5 rounded hover:bg-zinc-800"
                title="Cancel build"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Phase stepper */}
        <div className="flex items-center gap-1">
          {PHASES.map((phase, i) => {
            const isActive = i === currentPhaseIndex;
            const isDone = i < currentPhaseIndex;
            const isFuture = i > currentPhaseIndex;

            return (
              <div key={phase.key} className="flex items-center gap-1 flex-1">
                <div className="flex flex-col items-center gap-1 flex-1">
                  <div
                    className={`
                      flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium
                      ${isDone ? "bg-amber-500/20 text-amber-400" : ""}
                      ${isActive ? "bg-amber-500/30 text-amber-300" : ""}
                      ${isFuture ? "bg-zinc-800 text-zinc-600" : ""}
                    `}
                  >
                    {isDone ? (
                      <Check size={10} />
                    ) : isActive ? (
                      <Loader2 size={10} className="animate-spin" />
                    ) : (
                      <span>{i + 1}</span>
                    )}
                  </div>
                  <span
                    className={`text-[10px] leading-tight text-center ${
                      isActive
                        ? "text-amber-300 font-medium"
                        : isDone
                          ? "text-amber-400/60"
                          : "text-zinc-600"
                    }`}
                  >
                    {phase.label}
                    {isActive && batchProgress ? (
                      <span className="block text-amber-400/70 tabular-nums">
                        {batchProgress}
                      </span>
                    ) : null}
                  </span>
                </div>
                {i < PHASES.length - 1 && (
                  <div
                    className={`h-px flex-1 mt-[-14px] ${
                      isDone ? "bg-amber-500/30" : "bg-zinc-800"
                    }`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CompletedPanel({ status }: { status: PortraitRunStatus }) {
  return (
    <div className="mx-4 mt-3 mb-1 rounded-xl border border-zinc-800 bg-zinc-900/80 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-xs font-medium text-zinc-300">
            Portrait built
          </span>
          {status.extraction_months_covered && (
            <span className="text-[11px] text-zinc-500">
              — {status.extraction_months_covered}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {PHASES.map((phase, i) => {
            const isLast = i === PHASES.length - 1;
            return (
              <div key={phase.key} className="flex items-center gap-1 flex-1">
                <div className="flex flex-col items-center gap-1 flex-1">
                  <div className={`flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-medium ${
                    isLast ? "bg-emerald-500/20 text-emerald-400" : "bg-emerald-500/10 text-emerald-600"
                  }`}>
                    <Check size={10} />
                  </div>
                  <span className={`text-[10px] leading-tight text-center ${
                    isLast ? "text-emerald-400/60" : "text-zinc-500"
                  }`}>
                    {phase.label}
                  </span>
                </div>
                {i < PHASES.length - 1 && (
                  <div className="h-px flex-1 mt-[-14px] bg-emerald-500/10" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function InterruptedPanel({
  status,
  onRefresh,
}: {
  status: PortraitRunStatus;
  onRefresh: () => void;
}) {
  const handleResume = useCallback(async () => {
    try {
      await invokeCommand("start_portrait_build");
      onRefresh();
    } catch (err) {
      console.error("Failed to resume portrait build:", err);
    }
  }, [onRefresh]);

  const phaseLabel = PHASES.find((p) => p.key === status.phase)?.label ?? status.phase;
  const progress = status.completed_batches && status.total_batches
    ? ` (${status.completed_batches}/${status.total_batches} batches completed)`
    : "";

  return (
    <div className="mx-4 mt-3 mb-1 rounded-xl border border-amber-500/20 bg-zinc-900/80 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-400" />
            <span className="text-xs font-medium text-amber-400">
              Portrait build interrupted
            </span>
            <span className="text-[11px] text-zinc-500">
              {phaseLabel}{progress}
            </span>
          </div>
          <button
            onClick={handleResume}
            className="text-[11px] text-amber-400 hover:text-amber-300 font-medium px-2.5 py-1 rounded-lg hover:bg-amber-400/10 transition-colors"
          >
            Resume build
          </button>
        </div>
      </div>
    </div>
  );
}

function FailedPanel({
  status,
  onRefresh,
}: {
  status: PortraitRunStatus;
  onRefresh: () => void;
}) {
  const handleRetry = useCallback(async () => {
    try {
      await invokeCommand("start_portrait_build");
      onRefresh();
    } catch (err) {
      console.error("Failed to retry portrait build:", err);
    }
  }, [onRefresh]);

  return (
    <div className="mx-4 mt-3 mb-1 rounded-xl border border-red-500/20 bg-zinc-900/80 overflow-hidden">
      <div className="px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-red-400" />
            <span className="text-xs font-medium text-red-400">
              Portrait build failed
            </span>
          </div>
          <button
            onClick={handleRetry}
            className="text-[11px] text-blue-400 hover:text-blue-300 font-medium px-2.5 py-1 rounded-lg hover:bg-blue-400/10 transition-colors"
          >
            Try again
          </button>
        </div>
        {status.error_message && (
          <p className="text-[11px] text-zinc-500 mt-1.5 line-clamp-2">
            {status.error_message}
          </p>
        )}
      </div>
    </div>
  );
}
