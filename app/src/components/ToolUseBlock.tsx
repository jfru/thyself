import { useState } from "react";
import {
  Database,
  FileText,
  FolderOpen,
  AlertCircle,
  PenLine,
  ChevronDown,
  ChevronRight,
  Loader2,
  CheckCircle2,
} from "lucide-react";
import type { ToolUseBlock as ToolUseBlockType } from "../lib/types";

interface ToolUseBlockProps {
  block: ToolUseBlockType;
}

const TOOL_ICONS: Record<string, typeof Database> = {
  query_database: Database,
  write_correction: PenLine,
  read_session_files: FileText,
  write_session_file: FileText,
  read_file: FileText,
  list_files: FolderOpen,
};

function getToolDescription(block: ToolUseBlockType): string {
  const input = block.input;
  switch (block.name) {
    case "query_database": {
      const sql = (input.sql as string) || "";
      const tables = sql.match(/FROM\s+(\w+)/i);
      return tables ? `Querying ${tables[1]}` : "Running query";
    }
    case "write_correction":
      return `Recording ${(input.correction_type as string) || "correction"}`;
    case "read_session_files":
      return "Loading session history";
    case "write_session_file":
      return `Writing ${(input.filename as string) || "session"}`;
    case "read_file":
      return `Reading ${(input.path as string) || "file"}`;
    case "list_files":
      return `Listing ${(input.directory as string) || "files"}`;
    default:
      return block.name;
  }
}

export function ToolUseBlock({ block }: ToolUseBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const Icon = TOOL_ICONS[block.name] || Database;
  const description = getToolDescription(block);

  const statusIcon =
    block.status === "running" ? (
      <Loader2 size={14} className="animate-spin text-blue-400" />
    ) : block.status === "error" ? (
      <AlertCircle size={14} className="text-red-400" />
    ) : (
      <CheckCircle2 size={14} className="text-emerald-400" />
    );

  const borderColor =
    block.status === "error"
      ? "border-red-500/30"
      : block.status === "running"
        ? "border-blue-500/30"
        : "border-zinc-800";

  return (
    <div className={`my-2 rounded-lg border ${borderColor} bg-zinc-900/50 overflow-hidden`}>
      <button
        onClick={() => block.status !== "running" && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-800/50 transition-colors"
        disabled={block.status === "running"}
      >
        <Icon size={14} className="text-zinc-400 flex-shrink-0" />
        <span className="text-zinc-300 flex-1 truncate">{description}</span>
        {statusIcon}
        {block.status !== "running" &&
          (expanded ? (
            <ChevronDown size={12} className="text-zinc-500" />
          ) : (
            <ChevronRight size={12} className="text-zinc-500" />
          ))}
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2">
          {block.name === "query_database" && block.input.sql && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">
                Query
              </div>
              <pre className="text-xs text-blue-300 bg-zinc-950 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono">
                {block.input.sql as string}
              </pre>
            </div>
          )}
          {block.result && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">
                {block.isError ? "Error" : "Result"}
              </div>
              <pre
                className={`text-xs rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-60 overflow-y-auto ${
                  block.isError
                    ? "text-red-300 bg-red-950/30"
                    : "text-zinc-300 bg-zinc-950"
                }`}
              >
                {formatResult(block.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatResult(result: string): string {
  try {
    const parsed = JSON.parse(result);
    if (parsed.rows && Array.isArray(parsed.rows)) {
      const count = parsed.row_count ?? parsed.rows.length;
      if (count === 0) return "No rows returned";
      const preview = JSON.stringify(parsed.rows.slice(0, 10), null, 2);
      if (count > 10) {
        return `${preview}\n\n... and ${count - 10} more rows`;
      }
      return preview;
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return result;
  }
}
