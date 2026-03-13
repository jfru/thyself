import { useState, useRef, useEffect } from "react";
import { invokeCommand } from "../lib/tauriBridge";
import { Loader2, ArrowRight, Mail } from "lucide-react";

interface OnboardingWelcomeProps {
  onNext: (name: string, email: string, authToken: string) => void;
}

type Step = "info" | "code-sent" | "verified";

export function OnboardingWelcome({ onNext }: OnboardingWelcomeProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<Step>("info");
  const [code, setCode] = useState(["", "", "", "", "", ""]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (step === "code-sent") {
      codeRefs.current[0]?.focus();
    }
  }, [step]);

  async function handleSendCode() {
    if (!email.trim() || !name.trim()) return;
    setLoading(true);
    setError(null);

    try {
      await invokeCommand("cmd_send_auth_code", { email: email.trim().toLowerCase() });
      setStep("code-sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send code");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerifyCode(fullCode: string) {
    setLoading(true);
    setError(null);

    try {
      const result = await invokeCommand<{ token: string; user: { subscription_status: string } }>(
        "cmd_verify_auth_code",
        { email: email.trim().toLowerCase(), code: fullCode }
      );
      setStep("verified");
      setTimeout(() => {
        onNext(name.trim(), email.trim().toLowerCase(), result.token);
      }, 600);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
      setCode(["", "", "", "", "", ""]);
      codeRefs.current[0]?.focus();
    } finally {
      setLoading(false);
    }
  }

  function handleCodeInput(index: number, value: string) {
    if (!/^\d*$/.test(value)) return;
    const next = [...code];
    next[index] = value.slice(-1);
    setCode(next);

    if (value && index < 5) {
      codeRefs.current[index + 1]?.focus();
    }

    const fullCode = next.join("");
    if (fullCode.length === 6) {
      handleVerifyCode(fullCode);
    }
  }

  function handleCodeKeyDown(index: number, e: React.KeyboardEvent) {
    if (e.key === "Backspace" && !code[index] && index > 0) {
      codeRefs.current[index - 1]?.focus();
    }
  }

  function handleCodePaste(e: React.ClipboardEvent) {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);
    if (pasted.length === 6) {
      e.preventDefault();
      const next = pasted.split("");
      setCode(next);
      handleVerifyCode(pasted);
    }
  }

  if (step === "code-sent" || step === "verified") {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 px-6">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-blue-500/10 flex items-center justify-center mx-auto">
              <Mail size={24} className="text-blue-400" />
            </div>
            <h1 className="text-2xl font-semibold text-zinc-100">
              Check your email
            </h1>
            <p className="text-sm text-zinc-400 leading-relaxed">
              We sent a 6-digit code to <span className="text-zinc-200 font-medium">{email}</span>
            </p>
          </div>

          <div className="flex justify-center gap-2">
            {code.map((digit, i) => (
              <input
                key={i}
                ref={(el) => { codeRefs.current[i] = el; }}
                type="text"
                inputMode="numeric"
                maxLength={1}
                value={digit}
                onChange={(e) => handleCodeInput(i, e.target.value)}
                onKeyDown={(e) => handleCodeKeyDown(i, e)}
                onPaste={i === 0 ? handleCodePaste : undefined}
                disabled={loading || step === "verified"}
                className="w-12 h-14 text-center text-xl font-semibold rounded-lg bg-zinc-900 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors disabled:opacity-50"
              />
            ))}
          </div>

          {error && (
            <p className="text-xs text-red-400 text-center">{error}</p>
          )}

          {loading && (
            <div className="flex justify-center">
              <Loader2 size={20} className="animate-spin text-zinc-400" />
            </div>
          )}

          {step === "verified" && (
            <p className="text-sm text-green-400 text-center font-medium">Verified!</p>
          )}

          <button
            onClick={() => {
              setStep("info");
              setCode(["", "", "", "", "", ""]);
              setError(null);
            }}
            className="w-full text-sm text-zinc-500 hover:text-zinc-300 transition-colors text-center"
          >
            Use a different email
          </button>
        </div>
      </div>
    );
  }

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
              Your email
            </label>
            <p className="text-xs text-zinc-500">
              We'll send a verification code to sign you in.
            </p>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSendCode();
              }}
              placeholder="you@example.com"
              className="w-full rounded-lg bg-zinc-900 border border-zinc-700 px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors"
            />
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-400">{error}</p>
        )}

        <button
          onClick={handleSendCode}
          disabled={!name.trim() || !email.trim() || loading}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          {loading ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Sending code...
            </>
          ) : (
            <>
              Continue
              <ArrowRight size={16} />
            </>
          )}
        </button>

        <p className="text-xs text-zinc-600 text-center leading-relaxed">
          $4.99/month + AI usage costs. Cancel anytime.
        </p>
      </div>
    </div>
  );
}
