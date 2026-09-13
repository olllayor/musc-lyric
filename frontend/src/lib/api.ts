const UA = "musc-lyric/0.1";

export interface Match {
  score: number;
  recording_id: string;
  title: string;
  artist: string;
  album: string;
  duration: number | null;
}

export interface IdentifyResult {
  match: Match | null;
  fp_duration: number;
  song_duration?: number | null;
  cached: boolean;
  anchor?: { type: "t0-known" | "unknown"; offsetSec: number | null };
  orphan_tracks?: { track_id: string; score: number }[];
  hint?: string;
}

export interface LyricsResult {
  plainLyrics: string | null;
  syncedLyrics: string | null;
  instrumental?: boolean;
  not_found?: boolean;
}

export interface CoverInfo {
  artwork: string | null;
  previewUrl: string | null;
}

export async function identify(blob: Blob, filename: string, source: "mic" | "file"): Promise<IdentifyResult> {
  const fd = new FormData();
  fd.append("file", blob, filename);
  const r = await fetch(`/api/identify?source=${source}`, { method: "POST", body: fd });
  const body = await r.text();
  if (!r.ok) {
    try {
      const j = JSON.parse(body);
      if (j.hint) throw new Error(j.hint);
    } catch (e) {
      if (e instanceof Error && e.message !== body) throw e;
    }
    throw new Error(`identify failed: ${r.status} ${body.slice(0, 200)}`);
  }
  return JSON.parse(body);
}

export async function fetchLyrics(title: string, artist: string, duration?: number | null, album = ""): Promise<LyricsResult> {
  const p = new URLSearchParams({ title, artist, album });
  if (duration) p.set("duration", String(Math.round(duration)));
  const r = await fetch(`/api/lyrics?${p}`);
  if (!r.ok) throw new Error(`lyrics failed: ${r.status}`);
  return r.json();
}

export async function fetchCover(title: string, artist: string): Promise<CoverInfo> {
  try {
    const r = await fetch(
      `https://itunes.apple.com/search?${new URLSearchParams({
        term: `${artist} ${title}`, media: "music", limit: "1",
      })}`,
      { headers: { "User-Agent": UA } }
    );
    const d = await r.json();
    const t = d.results?.[0];
    if (!t) return { artwork: null, previewUrl: null };
    return {
      artwork: t.artwork100 ? String(t.artwork100).replace("100x100", "300x300") : null,
      previewUrl: t.previewUrl ?? null,
    };
  } catch {
    return { artwork: null, previewUrl: null };
  }
}

export const openInLinks = (artist: string, title: string) => {
  const q = encodeURIComponent(`${artist} ${title}`);
  return [
    { name: "Spotify", href: `https://open.spotify.com/search/${q}` },
    { name: "YouTube", href: `https://www.youtube.com/results?search_query=${q}` },
    { name: "Yandex", href: `https://music.yandex.com/search?text=${q}` },
  ];
};
