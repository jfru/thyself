import { useState, useRef, useEffect } from "react";
import { Folder, FileText } from "lucide-react";
import type { ImageAttachment, FileAttachment } from "../lib/types";

interface UserMessageProps {
  content: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  timestamp: number;
}

const COLLAPSED_MAX = 88;

export function UserMessage({ content, images, files, timestamp }: UserMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  useEffect(() => {
    const el = cardRef.current;
    if (el) {
      setNeedsTruncation(el.scrollHeight > COLLAPSED_MAX);
    }
  }, [content]);

  const isCollapsed = needsTruncation && !expanded;
  const hasImages = images && images.length > 0;
  const hasFiles = files && files.length > 0;

  return (
    <>
      <div className="sticky top-0 z-10 bg-zinc-950 px-4 pt-4 pb-2">
        <div
          ref={cardRef}
          className={`group relative max-w-3xl mx-auto rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 pt-3 pb-4 overflow-hidden ${needsTruncation ? "cursor-pointer" : ""}`}
          style={isCollapsed ? { maxHeight: COLLAPSED_MAX } : undefined}
          onClick={() => {
            if (!needsTruncation) return;
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            setExpanded(!expanded);
          }}
        >
          {hasImages && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((img, idx) => (
                <button
                  key={idx}
                  onClick={(e) => {
                    e.stopPropagation();
                    setLightboxSrc(`data:${img.mediaType};base64,${img.data}`);
                  }}
                  className="h-20 w-20 rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800 flex-shrink-0 hover:border-zinc-500 transition-colors"
                >
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name}
                    className="h-full w-full object-cover"
                  />
                </button>
              ))}
            </div>
          )}
          {hasFiles && (
            <div className="flex flex-wrap gap-2 mb-2">
              {files.map((f, idx) => (
                <div
                  key={idx}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300"
                >
                  {f.type === "folder" ? (
                    <Folder size={13} className="text-blue-400 flex-shrink-0" />
                  ) : (
                    <FileText size={13} className="text-zinc-400 flex-shrink-0" />
                  )}
                  <span className="max-w-[200px] truncate">{f.name}</span>
                </div>
              ))}
            </div>
          )}
          {content && (
            <div className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap">
              {content}
            </div>
          )}
          <div className={`mt-1 text-xs text-zinc-600 transition-opacity ${isCollapsed ? "hidden" : "opacity-0 group-hover:opacity-100"}`}>
            {time}
          </div>
          {isCollapsed && (
            <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-zinc-900 to-transparent pointer-events-none rounded-b-xl" />
          )}
        </div>
      </div>

      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm cursor-pointer"
          onClick={() => setLightboxSrc(null)}
        >
          <img
            src={lightboxSrc}
            alt="Full size"
            className="max-h-[85vh] max-w-[85vw] rounded-xl shadow-2xl"
          />
        </div>
      )}
    </>
  );
}
