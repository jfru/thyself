import { useState, useRef, useEffect, useCallback, lazy, Suspense, type DragEvent } from "react";
import { Folder, FileText, MessageSquare, Paperclip, Smile, X } from "lucide-react";
import type { ImageAttachment, FileAttachment, ContextAttachment } from "../lib/types";
import { isTauri } from "../lib/tauriBridge";

const EmojiPicker = lazy(() => import("@emoji-mart/react").then(mod => ({ default: mod.default })));
import emojiData from "@emoji-mart/data";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGE_SIZE = 20 * 1024 * 1024;

function fileToImageAttachment(file: File): Promise<ImageAttachment | null> {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type) || file.size > MAX_IMAGE_SIZE) return Promise.resolve(null);
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

interface UserMessageProps {
  content: string;
  images?: ImageAttachment[];
  files?: FileAttachment[];
  context?: ContextAttachment[];
  timestamp: number;
  onEdit?: (newContent: string, images?: ImageAttachment[], files?: FileAttachment[]) => void;
  isEditable?: boolean;
}

const COLLAPSED_MAX = 88;

export function UserMessage({ content, images, files, context, timestamp, onEdit, isEditable }: UserMessageProps) {
  const [expanded, setExpanded] = useState(false);
  const [needsTruncation, setNeedsTruncation] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(content);
  const [editImages, setEditImages] = useState<ImageAttachment[]>([]);
  const [editFiles, setEditFiles] = useState<FileAttachment[]>([]);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [emojiDirection, setEmojiDirection] = useState<"up" | "down">("down");
  const [attachDirection, setAttachDirection] = useState<"up" | "down">("down");
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cursorPosRef = useRef<number>(0);
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const attachButtonRef = useRef<HTMLButtonElement>(null);
  const dragCounter = useRef(0);

  const time = new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });

  useEffect(() => {
    const el = cardRef.current;
    if (el && !isEditing) {
      setNeedsTruncation(el.scrollHeight > COLLAPSED_MAX);
    }
  }, [content, isEditing]);

  useEffect(() => {
    if (isEditing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      cursorPosRef.current = ta.value.length;
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    }
  }, [isEditing]);

  const autoResizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = ta.scrollHeight + "px";
    }
  }, []);

  useEffect(() => {
    if (!showAttachMenu) return;
    const close = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest("[data-edit-attach-menu]")) return;
      setShowAttachMenu(false);
    };
    requestAnimationFrame(() => document.addEventListener("click", close));
    return () => document.removeEventListener("click", close);
  }, [showAttachMenu]);

  useEffect(() => {
    if (!showEmojiPicker) return;
    const close = (e: MouseEvent) => {
      if (emojiPickerRef.current?.contains(e.target as Node)) return;
      if (emojiButtonRef.current?.contains(e.target as Node)) return;
      setShowEmojiPicker(false);
    };
    requestAnimationFrame(() => document.addEventListener("mousedown", close));
    return () => document.removeEventListener("mousedown", close);
  }, [showEmojiPicker]);

  const enterEditMode = useCallback(() => {
    if (!isEditable || isEditing) return;
    setEditText(content);
    setEditImages(images ? [...images] : []);
    setEditFiles(files ? [...files] : []);
    setIsEditing(true);
    setExpanded(true);
  }, [isEditable, isEditing, content, images, files]);

  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditText(content);
    setEditImages([]);
    setEditFiles([]);
    setShowEmojiPicker(false);
    setShowAttachMenu(false);
    setExpanded(false);
  }, [content]);

  const submitEdit = useCallback(() => {
    const trimmed = editText.trim();
    if (!trimmed && editImages.length === 0 && editFiles.length === 0) return;
    setIsEditing(false);
    setShowEmojiPicker(false);
    setShowAttachMenu(false);
    onEdit?.(trimmed, editImages, editFiles);
  }, [editText, editImages, editFiles, onEdit]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (showEmojiPicker) { setShowEmojiPicker(false); return; }
      if (showAttachMenu) { setShowAttachMenu(false); return; }
      cancelEdit();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitEdit();
    }
  }, [cancelEdit, submitEdit, showEmojiPicker, showAttachMenu]);

  const handleEmojiSelect = useCallback((emoji: { native: string }) => {
    const pos = cursorPosRef.current;
    const before = editText.slice(0, pos);
    const after = editText.slice(pos);
    const newText = before + emoji.native + after;
    const newPos = pos + emoji.native.length;
    setEditText(newText);
    cursorPosRef.current = newPos;
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.setSelectionRange(newPos, newPos);
        ta.style.height = "auto";
        ta.style.height = ta.scrollHeight + "px";
      }
    });
  }, [editText]);

  const addImageFiles = useCallback(async (fileList: File[]) => {
    const results = await Promise.all(fileList.map(fileToImageAttachment));
    const valid = results.filter((r): r is ImageAttachment => r !== null);
    if (valid.length) setEditImages(prev => [...prev, ...valid]);
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file" && ACCEPTED_IMAGE_TYPES.has(item.type)) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length) {
      e.preventDefault();
      addImageFiles(imageFiles);
    }
  }, [addImageFiles]);

  const handleAttachFiles = useCallback(async () => {
    setShowAttachMenu(false);
    try {
      const { invokeCommand } = await import("../lib/tauriBridge");
      const result = await invokeCommand<{
        images: ImageAttachment[];
        files: Array<{ type: "file" | "folder"; path: string; name: string }>;
      }>("pick_files");
      if (result.images.length) setEditImages(prev => [...prev, ...result.images]);
      if (result.files.length) setEditFiles(prev => [...prev, ...result.files]);
    } catch (err) {
      console.error("File picker failed:", err);
    }
    textareaRef.current?.focus();
  }, []);

  const handleAttachFolder = useCallback(async () => {
    setShowAttachMenu(false);
    try {
      const { invokeCommand } = await import("../lib/tauriBridge");
      const result = await invokeCommand<{
        images: ImageAttachment[];
        files: Array<{ type: "file" | "folder"; path: string; name: string }>;
      }>("pick_folder");
      if (result.images.length) setEditImages(prev => [...prev, ...result.images]);
      if (result.files.length) setEditFiles(prev => [...prev, ...result.files]);
    } catch (err) {
      console.error("Folder picker failed:", err);
    }
    textareaRef.current?.focus();
  }, []);

  const removeEditImage = useCallback((idx: number) => {
    setEditImages(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const removeEditFile = useCallback((idx: number) => {
    setEditFiles(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    if (!isTauri() && e.dataTransfer?.types.includes("Files")) setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current = 0;
    setIsDragging(false);
    if (isTauri() || !e.dataTransfer?.files.length) return;

    const droppedFiles = Array.from(e.dataTransfer.files);
    const paths = droppedFiles
      .map((f) => (f as File & { path?: string }).path)
      .filter((p): p is string => !!p && p.length > 0);

    if (paths.length > 0) {
      try {
        const { invokeCommand } = await import("../lib/tauriBridge");
        const result = await invokeCommand<{
          images: ImageAttachment[];
          files: Array<{ type: "file" | "folder"; path: string; name: string }>;
        }>("read_dropped_files", { paths });
        if (result.images.length) setEditImages(prev => [...prev, ...result.images]);
        if (result.files.length) setEditFiles(prev => [...prev, ...result.files]);
      } catch (err) {
        console.error("Drop processing failed:", err);
        addImageFiles(droppedFiles);
      }
    } else {
      addImageFiles(droppedFiles);
    }
  }, [addImageFiles]);

  const isCollapsed = needsTruncation && !expanded && !isEditing;
  const hasImages = images && images.length > 0;
  const hasFiles = files && files.length > 0;
  const hasContext = context && context.length > 0;
  const hasEditAttachments = editImages.length > 0 || editFiles.length > 0;

  return (
    <>
      <div className="sticky top-0 z-10 bg-zinc-950 px-4 pt-4 pb-2">
        <div
          ref={cardRef}
          className={`group relative max-w-3xl mx-auto rounded-xl border ${isEditing ? `border-zinc-600 ${isDragging ? "border-blue-500 bg-blue-500/5" : ""}` : "border-zinc-800"} bg-zinc-900/60 px-4 pt-3 pb-4 ${!isEditing ? "overflow-hidden" : ""} ${!isEditing && (isEditable || needsTruncation) ? "cursor-pointer" : ""}`}
          style={isCollapsed ? { maxHeight: COLLAPSED_MAX } : undefined}
          onClick={() => {
            if (isEditing) return;
            const sel = window.getSelection();
            if (sel && sel.toString().length > 0) return;
            if (isEditable) {
              enterEditMode();
              return;
            }
            if (needsTruncation) setExpanded(!expanded);
          }}
          onDragEnter={isEditing ? handleDragEnter : undefined}
          onDragLeave={isEditing ? handleDragLeave : undefined}
          onDragOver={isEditing ? handleDragOver : undefined}
          onDrop={isEditing ? handleDrop : undefined}
        >
          {isEditing ? (
            <>
              {isDragging && (
                <div className="absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-blue-500/10 pointer-events-none">
                  <div className="flex items-center gap-2 text-sm text-blue-400 font-medium">
                    <Paperclip size={18} />
                    Drop files here
                  </div>
                </div>
              )}
              {hasEditAttachments && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {editImages.map((img, idx) => (
                    <div
                      key={`img-${idx}`}
                      className="group/thumb relative h-16 w-16 flex-shrink-0"
                    >
                      <div className="h-full w-full rounded-lg overflow-hidden border border-zinc-700 bg-zinc-800">
                        <img
                          src={`data:${img.mediaType};base64,${img.data}`}
                          alt={img.name}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeEditImage(idx); }}
                        onMouseDown={(e) => e.preventDefault()}
                        className="absolute -top-1.5 -right-1.5 rounded-full bg-zinc-900 border border-zinc-600 p-0.5 opacity-0 group-hover/thumb:opacity-100 transition-opacity hover:bg-zinc-700"
                      >
                        <X size={10} className="text-zinc-300" />
                      </button>
                    </div>
                  ))}
                  {editFiles.map((f, idx) => (
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
                        onClick={(e) => { e.stopPropagation(); removeEditFile(idx); }}
                        onMouseDown={(e) => e.preventDefault()}
                        className="rounded-full p-0.5 opacity-0 group-hover/chip:opacity-100 transition-opacity hover:bg-zinc-700"
                      >
                        <X size={10} className="text-zinc-400" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {hasContext && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {context!.map((c, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-300"
                    >
                      <MessageSquare size={13} className="text-blue-400 flex-shrink-0" />
                      <span className="max-w-[200px] truncate">@{c.name}</span>
                      {c.preview && (
                        <span className="text-blue-400/50">{c.preview}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={editText}
                onChange={(e) => {
                  setEditText(e.target.value);
                  cursorPosRef.current = e.target.selectionStart;
                  autoResizeTextarea();
                }}
                onSelect={() => {
                  if (textareaRef.current) cursorPosRef.current = textareaRef.current.selectionStart;
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                className="w-full bg-transparent text-sm text-zinc-100 leading-relaxed resize-none outline-none"
                rows={1}
              />
              <div className="flex items-center gap-1 mt-1 -mb-1">
                <div className="relative" data-edit-attach-menu>
                  <button
                    ref={attachButtonRef}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (!showAttachMenu && attachButtonRef.current) {
                        const rect = attachButtonRef.current.getBoundingClientRect();
                        setAttachDirection(rect.top >= 100 ? "up" : "down");
                      }
                      setShowAttachMenu(v => !v);
                    }}
                    className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-all"
                    title="Attach file"
                  >
                    <Paperclip size={15} />
                  </button>
                  {showAttachMenu && (
                    <div className={`absolute ${attachDirection === "up" ? "bottom-full mb-1" : "top-full mt-1"} left-0 w-36 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden z-20`}>
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
                <div className="relative">
                  <button
                    ref={emojiButtonRef}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      if (textareaRef.current) cursorPosRef.current = textareaRef.current.selectionStart;
                      if (!showEmojiPicker && emojiButtonRef.current) {
                        const rect = emojiButtonRef.current.getBoundingClientRect();
                        setEmojiDirection(rect.top >= 460 ? "up" : "down");
                      }
                      setShowEmojiPicker(v => !v);
                    }}
                    className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-all"
                    title="Emoji"
                  >
                    <Smile size={15} />
                  </button>
                  {showEmojiPicker && (
                    <div ref={emojiPickerRef} className={`absolute ${emojiDirection === "up" ? "bottom-full mb-1" : "top-full mt-1"} left-0 z-30`}>
                      <Suspense fallback={<div className="w-[352px] h-[435px] rounded-xl bg-zinc-900 border border-zinc-700 animate-pulse" />}>
                        <EmojiPicker
                          data={emojiData}
                          onEmojiSelect={handleEmojiSelect}
                          theme="dark"
                          previewPosition="none"
                          skinTonePosition="search"
                          set="native"
                        />
                      </Suspense>
                    </div>
                  )}
                </div>
                <div className="flex-1" />
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={cancelEdit}
                  className="rounded px-2 py-0.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={submitEdit}
                  className="rounded px-2 py-0.5 text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors"
                >
                  Save
                </button>
              </div>
            </>
          ) : (
            <>
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
              {hasContext && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {context.map((c, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-2.5 py-1.5 text-xs text-blue-300"
                    >
                      <MessageSquare size={13} className="text-blue-400 flex-shrink-0" />
                      <span className="max-w-[200px] truncate">@{c.name}</span>
                      {c.preview && (
                        <span className="text-blue-400/50">{c.preview}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {content ? (
                <div className="text-sm text-zinc-100 leading-relaxed whitespace-pre-wrap">
                  {content}
                </div>
              ) : null}
            </>
          )}
          <div className={`mt-1 text-xs text-zinc-600 transition-opacity ${isCollapsed || isEditing ? "hidden" : "opacity-0 group-hover:opacity-100"}`}>
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
