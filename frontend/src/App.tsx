import { useCallback, useEffect, useRef, useState } from "react";
import Karaoke from "./components/Karaoke";
import {
  fetchCover,
  fetchLyrics,
  identify,
  openInLinks,
  type CoverInfo,
  type IdentifyResult,
  type LyricsResult,
} from "./lib/api";
import { parseLRC } from "./lib/lrc";

type Phase = "idle" | "recording" | "identifying" | "result" | "error";

const REC_SECONDS = 12;

interface HistoryItem {
  title: string;
  artist: string;
  album: string;
  score: number;
  at: string;
}

function loadHistory(): HistoryItem[] {
  try {
    return JSON.parse(localStorage.getItem("musc-lyric-history") || "[]");
  } catch {
    return [];
  }
}

export default function App() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [countdown, setCountdown] = useState(REC_SECONDS);
  const [error, setError] = useState("");
  const [result, setResult] = useState<IdentifyResult | null>(null);
  const [lyrics, setLyrics] = useState<LyricsResult | null>(null);
  const [lyricsState, setLyricsState] = useState<"idle" | "loading" | "done">("idle");
  const [cover, setCover] = useState<CoverInfo>({ artwork: null, previewUrl: null });
  const [history, setHistory] = useState<HistoryItem[]>(loadHistory);
  const [backendOk, setBackendOk] = useState<boolean | null>(null);

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number>(0);
  const audioRef = useRef<HTMLAudioElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => setBackendOk(!!d.ok))
      .catch(() => setBackendOk(false));
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const stopTracks = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
  };

  const drawVisualizer = (stream: MediaStream) => {
    const Ctx = window.AudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    audioCtxRef.current = ctx;
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 64;
    src.connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const canvas = canvasRef.current;
    const loop = () => {
      rafRef.current = requestAnimationFrame(loop);
      an.getByteFrequencyData(data);
      if (!canvas) return;
      const c = canvas.getContext("2d");
      if (!c) return;
      const W = canvas.width, H = canvas.height;
      c.clearRect(0, 0, W, H);
      const n = data.length;
      const bw = W / n;
      for (let i = 0; i < n; i++) {
        const h = (data[i] / 255) * H;
        c.fillStyle = "#34d399";
        c.fillRect(i * bw, H - h, bw - 2, h);
      }
    };
    loop();
  };

  const runIdentify = useCallback(async (blob: Blob, filename: string, source: "mic" | "file") => {
    setPhase("identifying");
    setLyrics(null);
    setLyricsState("idle");
    try {
      const res = await identify(blob, filename, source);
      setResult(res);
      setPhase("result");
      if (res.match) {
        const m = res.match;
        setHistory((h) => {
          const item = {
            title: m.title, artist: m.artist, album: m.album,
            score: m.score, at: new Date().toISOString(),
          };
          const next = [item, ...h].slice(0, 20);
          localStorage.setItem("musc-lyric-history", JSON.stringify(next));
          return next;
        });
        setLyricsState("loading");
        try {
          const [lyr, cov] = await Promise.all([
            fetchLyrics(m.title, m.artist, m.duration ?? res.song_duration, m.album),
            fetchCover(m.title, m.artist),
          ]);
          setLyrics(lyr);
          setCover(cov);
        } catch (e) {
          console.warn("lyrics/cover failed", e);
          setLyrics({ plainLyrics: null, syncedLyrics: null });
        } finally {
          setLyricsState("done");
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    cancelAnimationFrame(rafRef.current);
    mediaRef.current?.state !== "inactive" && mediaRef.current?.stop();
  }, []);

  const startListening = async () => {
    setError("");
    if (!window.isSecureContext) {
      setError("Mic needs HTTPS or localhost (browser secure-context rule).");
      setPhase("error");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // all processing OFF: echoCancellation/noiseSuppression/autoGainControl hurt fingerprinting
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) =>
        window.MediaRecorder?.isTypeSupported(m)
      );
      const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      mediaRef.current = mr;
      mr.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      mr.onstop = () => {
        stopTracks();
        const type = mr.mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        const ext = type.includes("mp4") ? "m4a" : "webm";
        void runIdentify(blob, `snippet.${ext}`, "mic");
      };
      mr.start(250);
      setPhase("recording");
      setCountdown(REC_SECONDS);
      drawVisualizer(stream);
      timerRef.current = window.setInterval(() => {
        setCountdown((c) => {
          if (c <= 1) {
            stopRecording();
            return 0;
          }
          return c - 1;
        });
      }, 1000);
      setTimeout(() => stopRecording(), REC_SECONDS * 1000 + 500);
    } catch (e) {
      const err = e as DOMException;
      setError(
        err?.name === "NotAllowedError"
          ? "Mic permission denied. Allow microphone access and retry."
          : `Mic failed: ${err?.message || e}`
      );
      setPhase("error");
    }
  };

  const onFile = (f: File | undefined) => {
    if (f) void runIdentify(f, f.name, "file");
  };

  const reset = () => {
    setPhase("idle");
    setResult(null);
    setLyrics(null);
    setCover({ artwork: null, previewUrl: null });
    setCountdown(REC_SECONDS);
  };

  const m = result?.match ?? null;
  const syncedLines = lyrics?.syncedLyrics ? parseLRC(lyrics.syncedLyrics) : [];

  return (
    <div className="mx-auto min-h-screen w-full max-w-3xl px-4 py-10">
      <header className="mb-8 text-center">
        <h1 className="text-4xl font-bold tracking-tight">
          🎧 musc-lyric
        </h1>
        <p className="mt-2 text-white/60">
          Hear it anywhere → name it → sing it. 100% open stack.
        </p>
        {backendOk === false && (
          <p className="mx-auto mt-3 max-w-md rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">
            Backend not reachable at <code>/api</code>. Start it:{" "}
            <code>./.venv/bin/uvicorn main:app --port 8000</code> in <code>backend/</code>
          </p>
        )}
      </header>

      {phase === "idle" || phase === "error" ? (
        <div className="rounded-2xl bg-white/5 p-8 text-center">
          {phase === "error" && (
            <p className="mb-4 rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-300">{error}</p>
          )}
          <button
            onClick={startListening}
            className="rounded-full bg-emerald-500 px-10 py-5 text-xl font-bold text-black hover:bg-emerald-400"
          >
            🎙 Listen ({REC_SECONDS}s)
          </button>
          <p className="mt-3 text-sm text-white/50">
            Play the song on any app → tap → hold phone near speaker
          </p>
          <div className="mt-6">
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
            >
              …or upload an audio file
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => onFile(e.target.files?.[0])}
            />
          </div>
        </div>
      ) : null}

      {phase === "recording" && (
        <div className="rounded-2xl bg-white/5 p-8 text-center">
          <button
            onClick={stopRecording}
            className="rec-pulse mx-auto flex h-24 w-24 items-center justify-center rounded-full bg-red-500 text-3xl"
            title="Stop early"
          >
            ⏹
          </button>
          <p className="mt-4 font-mono text-5xl">{countdown}</p>
          <canvas ref={canvasRef} width={320} height={64} className="mx-auto mt-4" />
          <p className="mt-2 text-sm text-white/50">Listening… tap ⏹ to stop early</p>
        </div>
      )}

      {phase === "identifying" && (
        <div className="rounded-2xl bg-white/5 p-8 text-center">
          <p className="animate-pulse text-lg">🔍 Fingerprinting → AcoustID…</p>
        </div>
      )}

      {phase === "result" && result && (
        <div className="space-y-4">
          {!m ? (
            <div className="rounded-2xl bg-white/5 p-6">
              <h2 className="text-xl font-semibold">No match 😕</h2>
              <p className="mt-2 text-sm text-white/60">{result.hint}</p>
              {result.orphan_tracks && result.orphan_tracks.length > 0 && (
                <p className="mt-2 font-mono text-xs text-white/40">
                  heard something (score {result.orphan_tracks[0].score.toFixed(2)}) but cluster has
                  no metadata — try a longer, cleaner capture.
                </p>
              )}
              <button
                onClick={reset}
                className="mt-4 rounded-lg bg-emerald-500 px-5 py-2 font-semibold text-black hover:bg-emerald-400"
              >
                Try again
              </button>
            </div>
          ) : (
            <>
              <div className="flex gap-4 rounded-2xl bg-white/5 p-5">
                {cover.artwork ? (
                  <img src={cover.artwork} alt="" className="h-24 w-24 rounded-xl" />
                ) : (
                  <div className="flex h-24 w-24 items-center justify-center rounded-xl bg-white/10 text-3xl">
                    🎵
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-2xl font-bold">{m.title}</h2>
                  <p className="truncate text-white/70">{m.artist}</p>
                  <p className="truncate text-sm text-white/40">
                    {m.album} · score {m.score.toFixed(2)}
                    {result.cached ? " · cached" : ""}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {openInLinks(m.artist, m.title).map((l) => (
                      <a
                        key={l.name}
                        href={l.href}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
                      >
                        Open in {l.name} ↗
                      </a>
                    ))}
                    <button
                      onClick={reset}
                      className="rounded-lg bg-white/10 px-3 py-1 text-xs hover:bg-white/20"
                    >
                      ↺ New listen
                    </button>
                  </div>
                </div>
              </div>

              {cover.previewUrl && (
                <div className="rounded-2xl bg-white/5 p-4">
                  <p className="mb-2 text-xs text-white/50">
                    30s preview (note: previews don't start at 0:00 — use offset controls if sync drifts)
                  </p>
                  <audio ref={audioRef} src={cover.previewUrl} controls className="w-full" />
                </div>
              )}

              <div className="rounded-2xl bg-white/5 p-5">
                <h3 className="mb-3 text-lg font-semibold">Lyrics</h3>
                {lyricsState === "loading" && <p className="animate-pulse">Fetching from LRCLib…</p>}
                {lyricsState === "done" && lyrics && (
                  <>
                    {lyrics.instrumental ? (
                      <p className="text-white/60">🎼 instrumental — no lyrics.</p>
                    ) : syncedLines.length > 0 ? (
                      <Karaoke
                        lines={syncedLines}
                        anchorKnown={result.anchor?.type === "t0-known"}
                        audioEl={audioRef.current}
                      />
                    ) : lyrics.plainLyrics ? (
                      <pre className="whitespace-pre-wrap font-sans text-[15px] leading-relaxed text-white/85">
                        {lyrics.plainLyrics}
                      </pre>
                    ) : (
                      <p className="text-white/60">
                        No lyrics found for this track.{" "}
                        {result.anchor?.type === "unknown" &&
                          "(Remix/live titles often miss — plain fallback only.)"}
                      </p>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {history.length > 0 && phase !== "recording" && (
        <div className="mt-8">
          <h3 className="mb-2 text-sm font-semibold text-white/50">Recent</h3>
          <ul className="space-y-1">
            {history.map((h, i) => (
              <li key={i} className="flex justify-between rounded-lg bg-white/5 px-3 py-2 text-sm">
                <span className="truncate">
                  {h.artist} – {h.title}
                </span>
                <span className="ml-2 shrink-0 font-mono text-xs text-white/40">
                  {h.score.toFixed(2)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
