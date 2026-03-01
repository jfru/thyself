import { useState } from "react";
import { Copy, Check } from "lucide-react";

interface CodeBlockProps {
  children: string;
  language: string;
}

export function CodeBlock({ children, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="my-3 rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-zinc-500 font-mono">
          {language || "code"}
        </span>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          {copied ? (
            <>
              <Check size={12} className="text-emerald-400" />
              <span className="text-emerald-400">Copied</span>
            </>
          ) : (
            <>
              <Copy size={12} />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto p-3">
        <code className={`text-xs font-mono leading-relaxed ${language ? `language-${language}` : ""}`}>
          {children}
        </code>
      </pre>
    </div>
  );
}
