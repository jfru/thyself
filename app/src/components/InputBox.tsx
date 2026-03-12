import { useState, useRef, useEffect, useCallback, KeyboardEvent, DragEvent, ClipboardEvent } from "react";
import { Send, Square, Paperclip, X, Folder, FileText } from "lucide-react";
import type { ImageAttachment, FileAttachment } from "../lib/types";
import { isTauri } from "../lib/tauriBridge";

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

interface InputBoxProps {
  onSend: (text: string, images?: ImageAttachment[], options?: { selectedSourcesOverride?: string[] }, files?: FileAttachment[]) => void;
  onStop: () => void;
  isStreaming: boolean;
  pendingDroppedImages?: ImageAttachment[];
  onConsumeDroppedImages?: (imgs: ImageAttachment[]) => ImageAttachment[];
  pendingDroppedFiles?: FileAttachment[];
  onConsumeDroppedFiles?: (files: FileAttachment[]) => FileAttachment[];
  isTauriDragging?: boolean;
}

function fileToAttachment(file: File): Promise<ImageAttachment | null> {
  if (!ACCEPTED_TYPES.has(file.type) || file.size > MAX_FILE_SIZE) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      if (!base64) { resolve(null); return; }
      resolve({
        data: base64,
        mediaType: file.type as ImageAttachment["mediaType"],
        name: file.name || "image",
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export function InputBox({
  onSend,
  onStop,
  isStreaming,
  pendingDroppedImages,
  onConsumeDroppedImages,
  pendingDroppedFiles,
  onConsumeDroppedFiles,
  isTauriDragging,
}: InputBoxProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounter = useRef(0);

  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  useEffect(() => {
    if (pendingDroppedImages?.length) {
      setImages((prev) => [...prev, ...pendingDroppedImages]);
      onConsumeDroppedImages?.(pendingDroppedImages);
    }
  }, [pendingDroppedImages, onConsumeDroppedImages]);

  useEffect(() => {
    if (pendingDroppedFiles?.length) {
      setFileAttachments((prev) => [...prev, ...pendingDroppedFiles]);
      onConsumeDroppedFiles?.(pendingDroppedFiles);
    }
  }, [pendingDroppedFiles, onConsumeDroppedFiles]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const results = await Promise.all(Array.from(files).map(fileToAttachment));
    const valid = results.filter((r): r is ImageAttachment => r !== null);
    if (valid.length) setImages((prev) => [...prev, ...valid]);
  }, []);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const removeFileAttachment = useCallback((idx: number) => {
    setFileAttachments((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0 && fileAttachments.length === 0) || isStreaming) return;
    onSend(
      trimmed,
      images.length > 0 ? images : undefined,
      undefined,
      fileAttachments.length > 0 ? fileAttachments : undefined
    );
    setText("");
    setImages([]);
    setFileAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
    if (e.key === "Escape" && isStreaming) {
      e.preventDefault();
      onStop();
    }
  };

  const handlePaste = (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && ACCEPTED_TYPES.has(item.type)) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  };

  const handleDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (!isTauri() && e.dataTransfer?.types.includes("Files")) setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    if (!isTauri() && e.dataTransfer?.files.length) {
      addFiles(e.dataTransfer.files);
    }
  };

  const handleAttach = useCallback(async () => {
    if (isStreaming) return;
    if (isTauri()) {
      try {
        const { invokeCommand } = await import("../lib/tauriBridge");
        const result = await invokeCommand<{
          images: ImageAttachment[];
          files: Array<{ type: "file" | "folder"; path: string; name: string }>;
        }>("pick_files");
        if (result.images.length) setImages((prev) => [...prev, ...result.images]);
        if (result.files.length) setFileAttachments((prev) => [...prev, ...result.files]);
      } catch (err) {
        console.error("File picker failed:", err);
      }
    } else {
      fileInputRef.current?.click();
    }
  }, [isStreaming]);

  const showDragOverlay = isDragging || isTauriDragging;
  const hasContent = text.trim() || images.length > 0 || fileAttachments.length > 0;
  const hasAttachments = images.length > 0 || fileAttachments.length > 0;

  return (
    <div
      className="border-t border-zinc-800 bg-zinc-950 p-4"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <div className="mx-auto max-w-3xl">
        <div
          className={`relative rounded-xl border bg-zinc-900 transition-colors ${
            showDragOverlay
              ? "border-blue-500 bg-blue-500/5"
              : "border-zinc-700 focus-within:border-zinc-500"
          }`}
        >
          {showDragOverlay && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-blue-500/10 pointer-events-none">
              <div className="flex items-center gap-2 text-sm text-blue-400 font-medium">
                <Paperclip size={18} />
                Drop files here
              </div>
            </div>
          )}

          {hasAttachments && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {images.map((img, idx) => (
                <div
                  key={`img-${idx}`}
                  className="group/thumb relative h-16 w-16 rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800 flex-shrink-0"
                >
                  <img
                    src={`data:${img.mediaType};base64,${img.data}`}
                    alt={img.name}
                    className="h-full w-full object-cover"
                  />
                  <button
                    onClick={() => removeImage(idx)}
                    className="absolute -top-1 -right-1 rounded-full bg-zinc-900 border border-zinc-600 p-0.5 opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-zinc-700"
                  >
                    <X size={10} className="text-zinc-300" />
                  </button>
                </div>
              ))}
              {fileAttachments.map((f, idx) => (
                <div
                  key={`file-${idx}`}
                  className="group/chip flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300"
                >
                  {f.type === "folder" ? (
                    <Folder size={13} className="text-blue-400 flex-shrink-0" />
                  ) : (
                    <FileText size={13} className="text-zinc-400 flex-shrink-0" />
                  )}
                  <span className="max-w-[140px] truncate">{f.name}</span>
                  <button
                    onClick={() => removeFileAttachment(idx)}
                    className="rounded-full p-0.5 opacity-0 group-hover/chip:opacity-100 transition-opacity hover:bg-zinc-700"
                  >
                    <X size={10} className="text-zinc-400" />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-3">
            <div className="relative flex-shrink-0">
              <button
                onClick={handleAttach}
                disabled={isStreaming}
                className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 transition-all"
                title="Attach file"
              >
                <Paperclip size={18} />
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="Message thyself..."
              disabled={isStreaming}
              rows={1}
              className="flex-1 resize-none bg-transparent text-zinc-100 placeholder-zinc-500 outline-none text-sm leading-relaxed"
            />
            {isStreaming ? (
              <button
                onClick={onStop}
                className="flex-shrink-0 rounded-lg p-1.5 text-red-400 hover:text-red-300 hover:bg-zinc-800 transition-all"
                title="Stop generating (Esc)"
              >
                <Square size={18} fill="currentColor" />
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={!hasContent}
                className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-all"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 text-center text-xs text-zinc-600">
          {isStreaming ? "Esc to stop" : "Enter to send"}
        </div>
      </div>
    </div>
  );
}
