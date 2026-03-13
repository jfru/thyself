import { useState, useRef, useEffect, useCallback, DragEvent, ClipboardEvent } from "react";
import { Send, Square, Paperclip, X, Folder, FileText } from "lucide-react";
import type { ImageAttachment, FileAttachment, ContextAttachment } from "../lib/types";
import { isTauri } from "../lib/tauriBridge";
import { MentionDropdown } from "./MentionDropdown";

const ACCEPTED_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_FILE_SIZE = 20 * 1024 * 1024;

interface InputBoxProps {
  onSend: (
    text: string,
    images?: ImageAttachment[],
    options?: { selectedSourcesOverride?: string[]; context?: ContextAttachment[] },
    files?: FileAttachment[]
  ) => void;
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

function extractContentFromEditable(el: HTMLElement): {
  text: string;
  context: ContextAttachment[];
} {
  const context: ContextAttachment[] = [];
  const parts: string[] = [];

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || "");
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;

      if (elem.tagName === "BR") {
        parts.push("\n");
        return;
      }

      if (elem.dataset.mentionType) {
        const attachment: ContextAttachment = {
          type: elem.dataset.mentionType as "session",
          id: elem.dataset.mentionId || "",
          name: elem.dataset.mentionName || "",
          preview: elem.dataset.mentionPreview,
        };
        context.push(attachment);
        parts.push(`@${attachment.name}`);
        return;
      }

      if (elem.tagName === "DIV" && parts.length > 0 && !parts[parts.length - 1].endsWith("\n")) {
        parts.push("\n");
      }

      for (const child of Array.from(node.childNodes)) {
        walk(child);
      }
    }
  }

  for (const child of Array.from(el.childNodes)) {
    walk(child);
  }

  return { text: parts.join(""), context };
}

function getMentionQueryAtCursor(el: HTMLElement): {
  query: string;
  anchorRect: { top: number; left: number };
  range: Range;
} | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
  if (!el.contains(sel.anchorNode)) return null;

  const node = sel.anchorNode;
  if (!node || node.nodeType !== Node.TEXT_NODE) return null;

  const text = node.textContent || "";
  const offset = sel.anchorOffset;
  const before = text.slice(0, offset);

  const atIdx = before.lastIndexOf("@");
  if (atIdx === -1) return null;
  if (atIdx > 0 && before[atIdx - 1] !== " " && before[atIdx - 1] !== "\n") return null;

  const query = before.slice(atIdx + 1);
  if (query.includes("\n")) return null;

  const range = document.createRange();
  range.setStart(node, atIdx);
  range.setEnd(node, offset);

  const rect = range.getBoundingClientRect();

  return {
    query,
    anchorRect: { top: rect.top, left: rect.left },
    range,
  };
}

function createMentionPill(item: ContextAttachment): HTMLSpanElement {
  const pill = document.createElement("span");
  pill.contentEditable = "false";
  pill.dataset.mentionType = item.type;
  pill.dataset.mentionId = item.id;
  pill.dataset.mentionName = item.name;
  if (item.preview) pill.dataset.mentionPreview = item.preview;
  pill.className =
    "inline-flex items-center gap-1 rounded bg-blue-500/20 text-blue-300 px-1.5 py-0.5 text-xs font-medium mx-0.5 align-baseline select-all cursor-default whitespace-nowrap";
  pill.textContent = `@${item.name}`;
  return pill;
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
  const [images, setImages] = useState<ImageAttachment[]>([]);
  const [fileAttachments, setFileAttachments] = useState<FileAttachment[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [hasContent, setHasContent] = useState(false);
  const [showPlaceholder, setShowPlaceholder] = useState(true);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchorRect, setMentionAnchorRect] = useState<{ top: number; left: number } | null>(null);

  const editorRef = useRef<HTMLDivElement>(null);
  const mentionRangeRef = useRef<Range | null>(null);
  const dragCounter = useRef(0);

  const updateEditorState = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const text = el.textContent?.trim() || "";
    const hasMentions = el.querySelector("[data-mention-type]") !== null;
    setHasContent(text.length > 0 || hasMentions);
    setShowPlaceholder(text.length === 0 && !hasMentions);
  }, []);

  const autoResize = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, []);

  useEffect(() => {
    if (!isStreaming && editorRef.current) {
      editorRef.current.focus();
    }
  }, [isStreaming]);

  useEffect(() => {
    if (!showAttachMenu) return;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("[data-attach-menu]")) return;
      setShowAttachMenu(false);
    };
    requestAnimationFrame(() => {
      document.addEventListener("click", close);
    });
    return () => document.removeEventListener("click", close);
  }, [showAttachMenu]);

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

  const handleSubmit = useCallback(() => {
    const el = editorRef.current;
    if (!el || isStreaming) return;

    const { text, context } = extractContentFromEditable(el);
    const trimmed = text.trim();
    if (!trimmed && images.length === 0 && fileAttachments.length === 0 && context.length === 0) return;

    onSend(
      trimmed,
      images.length > 0 ? images : undefined,
      context.length > 0 ? { context } : undefined,
      fileAttachments.length > 0 ? fileAttachments : undefined
    );

    el.innerHTML = "";
    setImages([]);
    setFileAttachments([]);
    setHasContent(false);
    setShowPlaceholder(true);
    setMentionQuery(null);
    setMentionAnchorRect(null);
    mentionRangeRef.current = null;
    autoResize();
  }, [isStreaming, images, fileAttachments, onSend, autoResize]);

  const handleInput = useCallback(() => {
    updateEditorState();
    autoResize();

    const result = getMentionQueryAtCursor(editorRef.current!);
    if (result) {
      setMentionQuery(result.query);
      setMentionAnchorRect(result.anchorRect);
      mentionRangeRef.current = result.range;
    } else {
      setMentionQuery(null);
      setMentionAnchorRect(null);
      mentionRangeRef.current = null;
    }
  }, [updateEditorState, autoResize]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (mentionQuery !== null) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === "Tab") {
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          setMentionQuery(null);
          setMentionAnchorRect(null);
          mentionRangeRef.current = null;
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit();
      }
      if (e.key === "Escape" && isStreaming) {
        e.preventDefault();
        onStop();
      }
    },
    [mentionQuery, handleSubmit, isStreaming, onStop]
  );

  const handleMentionSelect = useCallback(
    (item: ContextAttachment) => {
      const el = editorRef.current;
      const range = mentionRangeRef.current;
      if (!el || !range) return;

      const sel = window.getSelection();
      if (!sel) return;

      sel.removeAllRanges();
      sel.addRange(range);

      range.deleteContents();

      const pill = createMentionPill(item);
      range.insertNode(pill);

      const spacer = document.createTextNode("\u00A0");
      pill.after(spacer);

      const newRange = document.createRange();
      newRange.setStartAfter(spacer);
      newRange.collapse(true);
      sel.removeAllRanges();
      sel.addRange(newRange);

      setMentionQuery(null);
      setMentionAnchorRect(null);
      mentionRangeRef.current = null;
      updateEditorState();
      autoResize();
    },
    [updateEditorState, autoResize]
  );

  const handleMentionClose = useCallback(() => {
    setMentionQuery(null);
    setMentionAnchorRect(null);
    mentionRangeRef.current = null;
  }, []);

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
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
        return;
      }

      const plainText = e.clipboardData?.getData("text/plain");
      if (plainText) {
        e.preventDefault();
        document.execCommand("insertText", false, plainText);
      }
    },
    [addFiles]
  );

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

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    if (isTauri() || !e.dataTransfer?.files.length) return;

    const files = Array.from(e.dataTransfer.files);
    const paths = files
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p && p.length > 0);

    if (paths.length > 0) {
      try {
        const { invokeCommand } = await import("../lib/tauriBridge");
        const result = await invokeCommand<{
          images: ImageAttachment[];
          files: Array<{ type: "file" | "folder"; path: string; name: string }>;
        }>("read_dropped_files", { paths });
        if (result.images.length) setImages((prev) => [...prev, ...result.images]);
        if (result.files.length) setFileAttachments((prev) => [...prev, ...result.files]);
      } catch (err) {
        console.error("Drop processing failed:", err);
        addFiles(files);
      }
    } else {
      addFiles(files);
    }
  };

  const handleAttachFiles = useCallback(async () => {
    if (isStreaming) return;
    setShowAttachMenu(false);
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
  }, [isStreaming]);

  const handleAttachFolder = useCallback(async () => {
    if (isStreaming) return;
    setShowAttachMenu(false);
    try {
      const { invokeCommand } = await import("../lib/tauriBridge");
      const result = await invokeCommand<{
        images: ImageAttachment[];
        files: Array<{ type: "file" | "folder"; path: string; name: string }>;
      }>("pick_folder");
      if (result.images.length) setImages((prev) => [...prev, ...result.images]);
      if (result.files.length) setFileAttachments((prev) => [...prev, ...result.files]);
    } catch (err) {
      console.error("Folder picker failed:", err);
    }
  }, [isStreaming]);

  const showDragOverlay = isDragging || isTauriDragging;
  const hasPickerAttachments = images.length > 0 || fileAttachments.length > 0;
  const canSend = hasContent || hasPickerAttachments;

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

          {hasPickerAttachments && (
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
            <div className="relative flex-shrink-0" data-attach-menu>
              <button
                onClick={() => setShowAttachMenu((v) => !v)}
                disabled={isStreaming}
                className="rounded-lg p-1.5 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 transition-all"
                title="Attach file"
              >
                <Paperclip size={18} />
              </button>
              {showAttachMenu && (
                <div className="absolute bottom-full left-0 mb-2 w-40 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden z-20">
                  <button
                    onClick={handleAttachFiles}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    <FileText size={14} className="text-zinc-400" />
                    Attach files
                  </button>
                  <button
                    onClick={handleAttachFolder}
                    className="flex w-full items-center gap-2 px-3 py-2 text-xs text-zinc-300 hover:bg-zinc-800 transition-colors"
                  >
                    <Folder size={14} className="text-blue-400" />
                    Attach folder
                  </button>
                </div>
              )}
            </div>
            <div className="relative flex-1">
              {showPlaceholder && (
                <div className="absolute inset-0 text-zinc-500 text-sm leading-relaxed pointer-events-none select-none">
                  Message thyself...
                </div>
              )}
              <div
                ref={editorRef}
                contentEditable={!isStreaming}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onFocus={() => updateEditorState()}
                onBlur={() => updateEditorState()}
                role="textbox"
                aria-placeholder="Message thyself..."
                className="min-h-[1.5em] max-h-[200px] overflow-y-auto resize-none bg-transparent text-zinc-100 outline-none text-sm leading-relaxed whitespace-pre-wrap break-words [&_[data-mention-type]]:inline-flex [&_[data-mention-type]]:items-center [&_[data-mention-type]]:gap-1 [&_[data-mention-type]]:rounded [&_[data-mention-type]]:bg-blue-500/20 [&_[data-mention-type]]:text-blue-300 [&_[data-mention-type]]:px-1.5 [&_[data-mention-type]]:py-0.5 [&_[data-mention-type]]:text-xs [&_[data-mention-type]]:font-medium [&_[data-mention-type]]:mx-0.5 [&_[data-mention-type]]:align-baseline [&_[data-mention-type]]:cursor-default [&_[data-mention-type]]:whitespace-nowrap"
              />
            </div>
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
                disabled={!canSend}
                className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-all"
              >
                <Send size={18} />
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 text-center text-xs text-zinc-600">
          {isStreaming ? "Esc to stop" : "Enter to send · @ to mention"}
        </div>
      </div>

      {mentionQuery !== null && (
        <MentionDropdown
          query={mentionQuery}
          onSelect={handleMentionSelect}
          onClose={handleMentionClose}
          anchorRect={mentionAnchorRect}
        />
      )}
    </div>
  );
}
