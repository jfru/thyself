import { useState, useRef, useEffect, useCallback, KeyboardEvent, DragEvent, ClipboardEvent } from "react";
import { Send, Square, Image, X } from "lucide-react";
import type { ImageAttachment } from "../lib/types";

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

interface InputBoxProps {
  onSend: (text: string, images?: ImageAttachment[]) => void;
  onStop: () => void;
  isStreaming: boolean;
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

export function InputBox({ onSend, onStop, isStreaming }: InputBoxProps) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<ImageAttachment[]>([]);
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

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const results = await Promise.all(Array.from(files).map(fileToAttachment));
    const valid = results.filter((r): r is ImageAttachment => r !== null);
    if (valid.length) setImages((prev) => [...prev, ...valid]);
  }, []);

  const removeImage = useCallback((idx: number) => {
    setImages((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if ((!trimmed && images.length === 0) || isStreaming) return;
    onSend(trimmed, images.length > 0 ? images : undefined);
    setText("");
    setImages([]);
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
    if (e.dataTransfer?.types.includes("Files")) setIsDragging(true);
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
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files);
  };

  const hasContent = text.trim() || images.length > 0;

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
            isDragging
              ? "border-blue-500 bg-blue-500/5"
              : "border-zinc-700 focus-within:border-zinc-500"
          }`}
        >
          {isDragging && (
            <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-blue-500/10 pointer-events-none">
              <div className="flex items-center gap-2 text-sm text-blue-400 font-medium">
                <Image size={18} />
                Drop images here
              </div>
            </div>
          )}

          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3 pt-3">
              {images.map((img, idx) => (
                <div
                  key={idx}
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
            </div>
          )}

          <div className="flex items-center gap-2 px-3 py-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isStreaming}
              className="flex-shrink-0 rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 transition-all"
              title="Attach image"
            >
              <Image size={18} />
            </button>
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
