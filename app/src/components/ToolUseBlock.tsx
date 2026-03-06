import { useState } from "react";
import {
  Database,
  FileText,
  FolderOpen,
  Globe,
  PenLine,
  ChevronDown,
  ChevronRight,
  Loader2,
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
  web_search: Globe,
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
    case "web_search":
      return `Searching: ${(input.query as string) || "web"}`;
    default:
      return block.name;
  }
}

export function ToolUseBlock({ block }: ToolUseBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const Icon = TOOL_ICONS[block.name] || Database;
  const description = getToolDescription(block);
  const isRunning = block.status === "running";

  return (
    <div className={`my-1 rounded-lg border ${isRunning ? "border-blue-500/30" : "border-zinc-800"} bg-zinc-900/50 overflow-hidden`}>
      <button
        onClick={() => !isRunning && setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-zinc-800/50 transition-colors"
        disabled={isRunning}
      >
        <Icon size={13} className="text-zinc-500 flex-shrink-0" />
        <span className="text-zinc-400 flex-1 truncate">{description}</span>
        {isRunning ? (
          <Loader2 size={12} className="animate-spin text-zinc-500" />
        ) : (
          expanded ? (
            <ChevronDown size={12} className="text-zinc-600" />
          ) : (
            <ChevronRight size={12} className="text-zinc-600" />
          )
        )}
      </button>
      {expanded && (
        <div className="border-t border-zinc-800 px-3 py-2 space-y-2">
          {block.name === "query_database" && typeof block.input.sql === "string" && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">
                Query
              </div>
              <pre className="text-xs text-blue-300 bg-zinc-950 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono">
                {block.input.sql as string}
              </pre>
            </div>
          )}
          {block.name === "web_search" && block.searchResults && block.searchResults.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">
                Results
              </div>
              <div className="space-y-1.5">
                {block.searchResults.map((r, i) => (
                  <a
                    key={i}
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-xs bg-zinc-950 rounded p-2 hover:bg-zinc-900 transition-colors"
                  >
                    <div className="text-blue-400 font-medium truncate">{r.title}</div>
                    <div className="text-zinc-500 truncate text-[11px]">{r.url}</div>
                  </a>
                ))}
              </div>
            </div>
          )}
          {block.result && (
            <div>
              <div className="text-[10px] uppercase tracking-wider text-zinc-600 mb-1">
                Result
              </div>
              <pre className="text-xs text-zinc-300 bg-zinc-950 rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono max-h-60 overflow-y-auto">
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
