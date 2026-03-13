import { useState } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import { Loader2, CheckCircle, XCircle, ArrowRight } from "lucide-react";

interface OnboardingWelcomeProps {
  onNext: (name: string, apiKey: string) => void;
}

export function OnboardingWelcome({ onNext }: OnboardingWelcomeProps) {
  const [name, setName] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [validating, setValidating] = useState(false);
  const [keyStatus, setKeyStatus] = useState<"idle" | "valid" | "invalid">("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleValidate() {
    if (!apiKey.trim()) return;
    setValidating(true);
    setError(null);
    setKeyStatus("idle");

    try {
      const result = await invokeCommand<{ valid: boolean; error?: string }>(
        "validate_api_key",
        { apiKey: apiKey.trim() }
      );
      if (result.valid) {
        setKeyStatus("valid");
      } else {
        setKeyStatus("invalid");
        setError(result.error || "Invalid API key");
      }
    } catch (err) {
      setKeyStatus("invalid");
      setError(err instanceof Error ? err.message : "Validation failed");
    } finally {
      setValidating(false);
    }
  }

  function handleContinue() {
    if (!name.trim() || keyStatus !== "valid") return;
    onNext(name.trim(), apiKey.trim());
  }

  const canContinue = name.trim().length > 0 && keyStatus === "valid";

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 px-6">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-3">
          <div className="text-5xl">🪞</div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Welcome to Thyself
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            An AI that knows your life. Let's get you set up.
          </p>
        </div>

        <div className="space-y-5">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-300">
              Your name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="What should the AI call you?"
              className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-zinc-300">
              Anthropic API key
            </label>
            <p className="text-xs text-zinc-500">
              Get one at{" "}
              <a
                href="https://console.anthropic.com/settings/keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-400 hover:text-blue-300 underline transition-colors"
              >
                console.anthropic.com
              </a>
            </p>
            <div className="relative">
              <input
                type="password"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setKeyStatus("idle");
                  setError(null);
                }}
                placeholder="sk-ant-..."
                className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors pr-12"
              />
              {keyStatus === "valid" && (
                <CheckCircle
                  size={18}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-green-400"
                />
              )}
              {keyStatus === "invalid" && (
                <XCircle
                  size={18}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-red-400"
                />
              )}
            </div>

            {error && (
              <p className="text-xs text-red-400">{error}</p>
            )}

            {keyStatus !== "valid" && (
              <button
                onClick={handleValidate}
                disabled={!apiKey.trim() || validating}
                className="w-full rounded-lg bg-zinc-800 px-4 py-2.5 text-sm font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                {validating ? (
                  <>
                    <Loader2 size={14} className="animate-spin" />
                    Validating...
                  </>
                ) : (
                  "Validate key"
                )}
              </button>
            )}
          </div>
        </div>

        <button
          onClick={handleContinue}
          disabled={!canContinue}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          Continue
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
