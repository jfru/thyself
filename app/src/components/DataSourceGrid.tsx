import { useState } from "react";
import { ArrowRight, MessageCircle, Mail, BrainCircuit, MessageSquareText } from "lucide-react";

interface DataSourceGridProps {
  onNext: (selectedSources: string[]) => void;
}

const DATA_SOURCES = [
  {
    id: "imessage",
    name: "iMessage",
    description: "Your texts and iMessages",
    icon: MessageCircle,
  },
  {
    id: "whatsapp",
    name: "WhatsApp",
    description: "WhatsApp messages",
    icon: MessageSquareText,
  },
  {
    id: "gmail",
    name: "Gmail",
    description: "Your email conversations",
    icon: Mail,
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    description: "Your ChatGPT history",
    icon: BrainCircuit,
  },
];

export function DataSourceGrid({ onNext }: DataSourceGridProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleContinue() {
    if (selected.size === 0) return;
    onNext(Array.from(selected));
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-zinc-950 px-6">
      <div className="w-full max-w-lg space-y-8">
        <div className="text-center space-y-3">
          <h1 className="text-2xl font-semibold text-zinc-100">
            Where do you communicate?
          </h1>
          <p className="text-sm text-zinc-400 leading-relaxed">
            Select your data sources. We'll set them up for you in the next step.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {DATA_SOURCES.map((source) => {
            const isSelected = selected.has(source.id);
            const Icon = source.icon;
            return (
              <button
                key={source.id}
                onClick={() => toggle(source.id)}
                className={`flex flex-col items-center gap-3 rounded-xl border p-6 text-center transition-all ${
                  isSelected
                    ? "border-blue-500 bg-blue-500/10 ring-1 ring-blue-500/30"
                    : "border-zinc-800 bg-zinc-900/50 hover:border-zinc-600 hover:bg-zinc-900"
                }`}
              >
                <Icon
                  size={28}
                  className={isSelected ? "text-blue-400" : "text-zinc-400"}
                />
                <div>
                  <div
                    className={`text-sm font-medium ${
                      isSelected ? "text-zinc-100" : "text-zinc-300"
                    }`}
                  >
                    {source.name}
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">
                    {source.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        <button
          onClick={handleContinue}
          disabled={selected.size === 0}
          className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-30 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
        >
          Set up {selected.size > 0 ? `${selected.size} source${selected.size > 1 ? "s" : ""}` : "sources"}
          <ArrowRight size={16} />
        </button>
      </div>
    </div>
  );
}
