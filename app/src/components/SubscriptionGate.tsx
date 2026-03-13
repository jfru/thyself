import { useState, useEffect } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, ExternalLink } from "lucide-react";

interface SubscriptionGateProps {
  authToken: string;
  onSubscribed: () => void;
  onBack: () => void;
}

export function SubscriptionGate({ authToken, onSubscribed, onBack }: SubscriptionGateProps) {
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkoutOpened, setCheckoutOpened] = useState(false);

  useEffect(() => {
    if (!checkoutOpened) return;

    const interval = setInterval(async () => {
      try {
        const result = await invokeCommand<{ subscription_status: string }>(
          "cmd_check_subscription",
          { authToken }
        );
        if (result.subscription_status === "active") {
          clearInterval(interval);
          onSubscribed();
        }
      } catch {
        // keep polling
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [checkoutOpened, authToken, onSubscribed]);

  async function handleSubscribe() {
    setLoading(true);
    setError(null);

    try {
      const result = await invokeCommand<{ url: string }>(
        "cmd_create_checkout",
        { authToken }
      );
      if (result.url) {
        if ((window as any).__TAURI_INTERNALS__) {
          await openUrl(result.url);
        } else {
          window.open(result.url, "_blank");
        }
        setCheckoutOpened(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start checkout");
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckStatus() {
    setChecking(true);
    try {
      const result = await invokeCommand<{ subscription_status: string }>(
        "cmd_check_subscription",
        { authToken }
      );
      if (result.subscription_status === "active") {
        onSubscribed();
      } else {
        setError("Subscription not yet active. Complete checkout in your browser.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to check status");
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 px-6">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-3">
          <div className="text-5xl">🪞</div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Subscribe to Thyself
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            An AI that knows your life story, powered by your own data.
          </p>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-4">
          <div className="flex items-baseline justify-between">
            <span className="text-lg font-semibold text-zinc-100">Thyself</span>
            <div className="text-right">
              <span className="text-2xl font-bold text-zinc-100">$4.99</span>
              <span className="text-sm text-zinc-400">/month</span>
            </div>
          </div>
          <div className="border-t border-zinc-800 pt-4 space-y-2">
            <div className="flex items-start gap-2 text-sm text-zinc-400">
              <span className="text-green-400 mt-0.5">✓</span>
              <span>Unlimited conversations with your AI therapist</span>
            </div>
            <div className="flex items-start gap-2 text-sm text-zinc-400">
              <span className="text-green-400 mt-0.5">✓</span>
              <span>Connect iMessage, WhatsApp, Gmail, ChatGPT</span>
            </div>
            <div className="flex items-start gap-2 text-sm text-zinc-400">
              <span className="text-green-400 mt-0.5">✓</span>
              <span>Life portrait extraction and synthesis</span>
            </div>
            <div className="flex items-start gap-2 text-sm text-zinc-400">
              <span className="text-zinc-500 mt-0.5">+</span>
              <span>AI usage costs passed through at cost</span>
            </div>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400 text-center">{error}</p>
        )}

        <div className="space-y-3">
          <button
            onClick={handleSubscribe}
            disabled={loading}
            className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                Opening checkout...
              </>
            ) : (
              <>
                Subscribe
                <ExternalLink size={14} />
              </>
            )}
          </button>

          {checkoutOpened && (
            <button
              onClick={handleCheckStatus}
              disabled={checking}
              className="w-full rounded-lg bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
            >
              {checking ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Checking...
                </>
              ) : (
                "I've completed checkout"
              )}
            </button>
          )}

          <button
            onClick={onBack}
            className="w-full text-sm text-zinc-500 hover:text-zinc-300 transition-colors text-center"
          >
            Use a different account
          </button>
        </div>
      </div>
    </div>
  );
}
