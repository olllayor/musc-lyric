export interface LyricWord {
  time: number;
  text: string;
}

export interface LyricLine {
  time: number;
  text: string;
  words: LyricWord[] | null; // enhanced LRC word timings, if present
}

const TAG_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>([^<]*)/g;
const OFFSET_RE = /\[offset:\s*([+-]?\d+)\s*\]/i;

function toSeconds(m: string, s: string, frac?: string): number {
  let t = parseInt(m, 10) * 60 + parseInt(s, 10);
  if (frac) {
    const f = frac.padEnd(3, "0").slice(0, 3);
    t += parseInt(f, 10) / 1000;
  }
  return t;
}

export function parseLRC(raw: string): LyricLine[] {
  const offsetMatch = OFFSET_RE.exec(raw);
  const offsetSec = offsetMatch ? parseInt(offsetMatch[1], 10) / 1000 : 0;

  const lines: LyricLine[] = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("[ti:") || line.startsWith("[ar:") ||
        line.startsWith("[al:") || line.startsWith("[by:") ||
        line.startsWith("[length:") || OFFSET_RE.test(line)) {
      continue;
    }
    const stamps = [...line.matchAll(TAG_RE)];
    if (stamps.length === 0) continue;
    const text = line.replace(TAG_RE, "").trim();

    // enhanced word timings?
    const words: LyricWord[] = [];
    for (const w of text.matchAll(WORD_RE)) {
      words.push({
        time: toSeconds(w[1], w[2], w[3]) + offsetSec,
        text: w[4],
      });
    }
    const cleanText = text.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, "").trim();

    for (const st of stamps) {
      lines.push({
        time: toSeconds(st[1], st[2], st[3]) + offsetSec,
        text: cleanText,
        words: words.length > 1 ? words : null,
      });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

/** index of the last line with time <= t, or -1 */
export function lineAt(lines: LyricLine[], t: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= t) idx = i;
    else break;
  }
  return idx;
}
