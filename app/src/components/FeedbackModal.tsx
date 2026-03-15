import { useState, useEffect, useRef } from "react";
import { Bug, Lightbulb, Loader2, X, Check } from "lucide-react";
import { collectDiagnostics, type DiagnosticSnapshot } from "../lib/diagnostics";

type FeedbackType = "bug" | "feedback";
type SubmitState = "idle" | "submitting" | "success" | "error";

const WORKER_URL = "https://thyself-feedback.jfru.workers.dev";
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;

interface FeedbackModalProps {
  onClose: () => void;
}

function compressImage(dataUrl: string, maxWidth = 1200): Promise<string> {
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

let _capturedScreenshot: string | null = null;

/**
 * Capture screenshot and WAIT for it to finish before the modal opens,
 * so the screenshot doesn't include the modal overlay.
 */
export async function captureScreenshotBeforeModal(): Promise<void> {
  _capturedScreenshot = null;
  try {
    const root = document.getElementById("root") || document.body;
    const mod = await import("html-to-image");
    const dataUrl = await mod.toJpeg(root, {
      quality: 0.7,
      backgroundColor: "#09090b",
    });
    if (dataUrl && dataUrl.length > 100) {
      _capturedScreenshot =
        dataUrl.length > MAX_SCREENSHOT_BYTES
          ? await compressImage(dataUrl, 1000)
          : dataUrl;
    }
  } catch {
    // screenshot is best-effort
  }
}

export function FeedbackModal({ onClose }: FeedbackModalProps) {
  const [type, setType] = useState<FeedbackType>("feedback");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState(() => localStorage.getItem("thyself-feedback-email") || "");
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");
  const [diagnostics, setDiagnostics] = useState<DiagnosticSnapshot | null>(null);
  const [screenshot] = useState<string | null>(_capturedScreenshot);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    collectDiagnostics().then(setDiagnostics);
    _capturedScreenshot = null;
  }, []);

  useEffect(() => {
    if (state === "success") {
      const timer = setTimeout(onClose, 2000);
      return () => clearTimeout(timer);
    }
  }, [state, onClose]);

  async function handleSubmit() {
    if (!message.trim() || state === "submitting") return;

    setState("submitting");
    setError("");

    const snap = diagnostics ?? (await collectDiagnostics());

    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          message: message.trim(),
          email: email.trim() || undefined,
          appVersion: snap.appVersion,
          os: snap.os,
          diagnostics: snap,
          screenshot: screenshot || undefined,
        }),
      });

      const data = await res.json();
      if (data.success) {
        if (email.trim()) localStorage.setItem("thyself-feedback-email", email.trim());
        setState("success");
      } else {
        setError(data.error || "Something went wrong");
        setState("error");
      }
    } catch {
      setError("Could not reach the server. Check your connection.");
      setState("error");
    }
  }

  if (state === "success") {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="bg-zinc-900 border border-zinc-700 rounded-xl px-6 py-8 max-w-md w-full mx-4 text-center shadow-2xl">
          <Check size={32} className="mx-auto text-emerald-400 mb-3" />
          <p className="text-sm text-zinc-200 font-medium">Thanks for your feedback!</p>
          <p className="mt-1 text-xs text-zinc-500">We'll take a look soon.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-lg w-full mx-4 shadow-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-200">Send Feedback</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4 overflow-y-auto">
          <div className="flex gap-2">
            <button
              onClick={() => setType("bug")}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                type === "bug"
                  ? "bg-red-500/15 text-red-400 border border-red-500/30"
                  : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-300"
              }`}
            >
              <Bug size={14} />
              Bug Report
            </button>
            <button
              onClick={() => setType("feedback")}
              className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                type === "feedback"
                  ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                  : "bg-zinc-800 text-zinc-400 border border-zinc-700 hover:text-zinc-300"
              }`}
            >
              <Lightbulb size={14} />
              Feedback
            </button>
          </div>

          <textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              type === "bug"
                ? "What went wrong? What were you doing when it happened?"
                : "What would make Thyself better?"
            }
            rows={4}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-zinc-500 transition-colors"
          />

          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email (optional, if you'd like a response)"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
          />

          {state === "error" && (
            <p className="text-xs text-red-400">{error}</p>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-4 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!message.trim() || state === "submitting"}
            className="px-4 py-2 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
          >
            {state === "submitting" ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Sending...
              </>
            ) : (
              "Send"
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
