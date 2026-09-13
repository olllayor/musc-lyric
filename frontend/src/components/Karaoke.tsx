import { useEffect, useMemo, useRef, useState } from "react";
import { lineAt, type LyricLine } from "../lib/lrc";

interface Props {
  lines: LyricLine[];
  anchorKnown: boolean; // t0-known (full file) vs unknown (mic snippet / preview)
  audioEl: HTMLAudioElement | null;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function Karaoke({ lines, anchorKnown, audioEl }: Props) {
  const [now, setNow] = useState(0);
  const [nudge, setNudge] = useState(0);
  const [startedAt, setStartedAt] = useState<number | null>(anchorKnown ? Date.now() : null);
  const [running, setRunning] = useState(anchorKnown);
  const listRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  const t = useMemo(() => {
    let base: number;
    if (audioEl && !audioEl.paused) base = audioEl.currentTime;
    else if (audioEl && audioEl.currentTime > 0) base = audioEl.currentTime;
    else if (startedAt != null && running) base = (Date.now() - startedAt) / 1000;
    else base = now;
    return Math.max(0, base + nudge);
  }, [now, nudge, startedAt, running, audioEl]);

  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 0.1), 100);
    return () => clearInterval(id);
  }, []);

  const idx = lineAt(lines, t);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [idx]);

  const tapSync = () => {
    setStartedAt(Date.now());
    setRunning(true);
    setNudge(0);
  };

  const jumpToLine = (line: LyricLine) => {
    if (audioEl) {
      audioEl.currentTime = Math.max(0, line.time - nudge + 0.01);
      audioEl.play().catch(() => {});
    } else {
      setStartedAt(Date.now() - line.time * 1000);
      setRunning(true);
    }
  };

  const nudgeBtn = (d: number) => (
    <button
      key={d}
      onClick={() => setNudge((n) => +(n + d).toFixed(2))}
      className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
    >
      {d > 0 ? `+${d}` : d}s
    </button>
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-white/5 p-3">
        <span className="font-mono text-sm text-white/70">{fmt(t)}</span>
        {!anchorKnown && !running && (
          <button
            onClick={tapSync}
            className="rounded-lg bg-emerald-500 px-4 py-1.5 text-sm font-semibold text-black hover:bg-emerald-400"
          >
            ▶ Tap when singing starts
          </button>
        )}
        {running && (
          <button
            onClick={() => setRunning(false)}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          >
            ⏸ Pause sync
          </button>
        )}
        {!running && startedAt != null && (
          <button
            onClick={() => setRunning(true)}
            className="rounded-lg bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
          >
            ▶ Resume
          </button>
        )}
        <div className="flex items-center gap-1">
          {nudgeBtn(-1)}
          {nudgeBtn(-0.2)}
          {nudgeBtn(0.2)}
          {nudgeBtn(1)}
        </div>
        <input
          type="range"
          min={-5}
          max={5}
          step={0.1}
          value={Math.max(-5, Math.min(5, nudge))}
          onChange={(e) => setNudge(+e.target.value)}
          className="w-32 accent-emerald-400"
          title="Sync offset"
        />
        <span className="text-xs text-white/50">
          offset {nudge >= 0 ? "+" : ""}{nudge.toFixed(1)}s
          {!anchorKnown && " · mic snippets need manual sync (AcoustID gives no position)"}
        </span>
      </div>

      <div ref={listRef} className="max-h-[50vh] space-y-1 overflow-y-auto pr-2">
        {lines.map((line, i) => {
          const active = i === idx;
          const past = i < idx;
          return (
            <div
              key={i}
              ref={active ? activeRef : undefined}
              onClick={() => jumpToLine(line)}
              className={`lyric-line cursor-pointer rounded-lg px-3 py-1.5 text-lg leading-snug hover:bg-white/10 ${
                active ? "active bg-emerald-500/15 font-semibold" : past ? "past text-white/60" : "text-white/85"
              }`}
            >
              <span className="mr-2 font-mono text-xs text-white/30">{fmt(line.time)}</span>
              {active && line.words ? (
                <span>
                  {line.words.map((w, j) => (
                    <span key={j} className={w.time <= t ? "text-emerald-300" : ""}>
                      {w.text}{" "}
                    </span>
                  ))}
                </span>
              ) : (
                line.text || "♪"
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
