interface UserMessageProps {
  content: string;
  timestamp: number;
}

export function UserMessage({ content, timestamp }: UserMessageProps) {
  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="group flex justify-end">
      <div className="max-w-[80%]">
        <div className="rounded-2xl rounded-br-md bg-blue-600 px-4 py-2.5 text-sm text-white leading-relaxed">
          {content}
        </div>
        <div className="mt-1 text-right text-xs text-zinc-600 opacity-0 group-hover:opacity-100 transition-opacity">
          {time}
        </div>
      </div>
    </div>
  );
}
