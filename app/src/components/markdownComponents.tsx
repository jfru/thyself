import type { Components } from "react-markdown";
import { CodeBlock } from "./CodeBlock";

export const markdownComponents: Partial<Components> = {
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className || "");
    const isInline = !match && !String(children).includes("\n");
    if (isInline) {
      return (
        <code
          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[13px] font-mono text-emerald-300"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <CodeBlock language={match?.[1] || ""}>
        {String(children).replace(/\n$/, "")}
      </CodeBlock>
    );
  },
  table({ children }) {
    return (
      <div className="my-3 overflow-x-auto rounded border border-zinc-800">
        <table className="min-w-full text-xs">{children}</table>
      </div>
    );
  },
  thead({ children }) {
    return <thead className="bg-zinc-800/50">{children}</thead>;
  },
  th({ children }) {
    return (
      <th className="px-3 py-2 text-left text-zinc-300 font-medium">
        {children}
      </th>
    );
  },
  td({ children }) {
    return (
      <td className="border-t border-zinc-800 px-3 py-2 text-zinc-400">
        {children}
      </td>
    );
  },
  blockquote({ children }) {
    return (
      <blockquote className="border-l-2 border-zinc-600 pl-4 italic text-zinc-400 my-3">
        {children}
      </blockquote>
    );
  },
  a({ href, children }) {
    if (href?.startsWith("thyself:")) {
      const action = href.slice("thyself:".length);
      return (
        <button
          onClick={() => window.dispatchEvent(new CustomEvent("thyself-action", { detail: action }))}
          className="inline-flex items-center gap-1.5 mt-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
        >
          {children}
        </button>
      );
    }
    return (
      <a
        href={href}
        className="text-blue-400 hover:text-blue-300 underline underline-offset-2"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    );
  },
  ul({ children }) {
    return <ul className="list-disc pl-5 space-y-1 my-2">{children}</ul>;
  },
  ol({ children }) {
    return <ol className="list-decimal pl-5 space-y-1 my-2">{children}</ol>;
  },
  h1({ children }) {
    return <h1 className="text-lg font-semibold text-zinc-100 mt-4 mb-2">{children}</h1>;
  },
  h2({ children }) {
    return <h2 className="text-base font-semibold text-zinc-100 mt-3 mb-2">{children}</h2>;
  },
  h3({ children }) {
    return <h3 className="text-sm font-semibold text-zinc-200 mt-3 mb-1">{children}</h3>;
  },
  p({ children }) {
    return <p className="my-2 leading-relaxed">{children}</p>;
  },
  hr() {
    return <hr className="my-4 border-zinc-800" />;
  },
  strong({ children }) {
    return <strong className="font-semibold text-zinc-100">{children}</strong>;
  },
};
