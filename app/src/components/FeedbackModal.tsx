import { useState, useEffect } from "react";
import { Bug, Lightbulb, Loader2, X, Check } from "lucide-react";

type FeedbackType = "bug" | "feedback";
type SubmitState = "idle" | "submitting" | "success" | "error";

const WORKER_URL = "https://thyself-feedback.jfru.workers.dev";

interface FeedbackModalProps {
  onClose: () => void;
}

async function getAppVersion(): Promise<string> {
  try {
    if ((window as any).__TAURI_INTERNALS__) {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    }
  } catch {}
  return "dev";
}

function getOS(): string {
  const ua = navigator.userAgent;
  const match = ua.match(/Mac OS X (\d+[\._]\d+[\._]?\d*)/);
  if (match) return `macOS ${match[1].replace(/_/g, ".")}`;
  return navigator.platform || "unknown";
}

export function FeedbackModal({ onClose }: FeedbackModalProps) {
  const [type, setType] = useState<FeedbackType>("feedback");
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");

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

    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          message: message.trim(),
          email: email.trim() || undefined,
          appVersion: await getAppVersion(),
          os: getOS(),
        }),
      });

      const data = await res.json();
      if (data.success) {
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
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl max-w-md w-full mx-4 shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800">
          <h3 className="text-sm font-medium text-zinc-200">Send Feedback</h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800 transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
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
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={
              type === "bug"
                ? "What went wrong?"
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
