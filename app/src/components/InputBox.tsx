import { useState, useRef, useEffect, KeyboardEvent } from "react";
import { Send } from "lucide-react";

interface InputBoxProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function InputBox({ onSend, disabled }: InputBoxProps) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!disabled && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  }, [text]);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t border-zinc-800 bg-zinc-950 p-4">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-end gap-3 rounded-xl border border-zinc-700 bg-zinc-900 px-4 py-3 focus-within:border-zinc-500 transition-colors">
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message thyself..."
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent text-zinc-100 placeholder-zinc-500 outline-none text-sm leading-relaxed"
          />
          <button
            onClick={handleSubmit}
            disabled={disabled || !text.trim()}
            className="flex-shrink-0 rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400 transition-all"
          >
            <Send size={18} />
          </button>
        </div>
        <div className="mt-1.5 text-center text-xs text-zinc-600">
          {"\u2318"}+Enter to send
        </div>
      </div>
    </div>
  );
}
