"""musc-lyric identify spike: mic/file -> fpcalc -> AcoustID -> LRCLib.

Design notes (from review):
- fpcalc tried directly on upload (webm/opus usually works). ffmpeg->wav fallback only if needed.
- AcoustID lookup uses meta=recordings+releasegroups+compress so no separate MusicBrainz call.
- Cache by sha1(fingerprint) per AcoustID client guidance.
- /lyrics takes SONG duration (from AcoustID), never snippet duration.
- anchor: file uploads of full songs are t0-known, mic snippets are unknown-offset
  (AcoustID gives no position-in-song, so karaoke must manual-sync for v1).
"""
import hashlib
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import requests
from fastapi import FastAPI, File, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except Exception:
    pass

ACOUSTID_KEY = os.getenv("ACOUSTID_API_KEY", "").strip()
ACOUSTID_URL = "https://api.acoustid.org/v2/lookup"
LRCLIB_GET = "https://lrclib.net/api/get"
LRCLIB_SEARCH = "https://lrclib.net/api/search"
UA = "musc-lyric/0.1 (local prototype; contact: dev@localhost)"
CACHE_PATH = Path(__file__).parent / "cache.json"

app = FastAPI(title="musc-lyric identify spike")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173", "*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_cache() -> dict:
    try:
        return json.loads(CACHE_PATH.read_text())
    except Exception:
        return {}


def _save_cache(cache: dict) -> None:
    try:
        CACHE_PATH.write_text(json.dumps(cache))
    except Exception:
        pass


def probe_duration(path: str) -> float:
    """Container duration via ffprobe (0.0 if unknown — common for MediaRecorder webm)."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def wav_fingerprint(path: str, length: int = 120) -> tuple[int, str]:
    """Normalize to wav first (wav headers always carry valid duration), then fpcalc."""
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav = tmp.name
    try:
        conv = subprocess.run(
            ["ffmpeg", "-y", "-v", "error", "-i", path, "-ar", "44100", "-ac", "1", wav],
            capture_output=True, text=True, timeout=60,
        )
        if conv.returncode != 0:
            raise RuntimeError(f"ffmpeg failed: {conv.stderr.strip()[:500]}")
        out = subprocess.run(
            ["fpcalc", "-json", "-length", str(length), wav],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0:
            raise RuntimeError(f"fpcalc failed: {out.stderr.strip()[:500]}")
        data = json.loads(out.stdout)
        return int(round(float(data["duration"]))), data["fingerprint"]
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass


def run_fpcalc(path: str, length: int = 120) -> tuple[int, str]:
    """Returns (duration_sec, fingerprint). Tries direct decode, falls back via ffmpeg."""
    def _fpcalc(target: str) -> tuple[int, str]:
        out = subprocess.run(
            ["fpcalc", "-json", "-length", str(length), target],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0:
            raise RuntimeError(f"fpcalc failed: {out.stderr.strip()[:500]}")
        data = json.loads(out.stdout)
        return int(round(float(data["duration"]))), data["fingerprint"]

    try:
        duration, fingerprint = _fpcalc(path)
    except Exception as e:
        # Fallback: normalize to wav then fingerprint (covers odd opus builds)
        msg = str(e)
        if "Decode" in msg or "failed" in msg.lower():
            return wav_fingerprint(path, length)
        raise

    if duration < 3 and len(fingerprint) > 80:
        # MediaRecorder webm often lacks duration metadata even though the
        # audio is complete. Resolve via container probe, else wav decode.
        probed = probe_duration(path)
        if probed > 0:
            print(f"[fpcalc] container duration missing, ffprobe says {probed:.1f}s", flush=True)
            return int(round(probed)), fingerprint
        print("[fpcalc] container duration missing, falling back to wav decode", flush=True)
        return wav_fingerprint(path, length)
    return duration, fingerprint


def lookup_acoustid(fingerprint: str, duration: int) -> dict:
    if not ACOUSTID_KEY:
        raise RuntimeError("Missing ACOUSTID_API_KEY (set in backend/.env)")
    key = hashlib.sha1(fingerprint.encode()).hexdigest() + f":{duration}"
    cache = _load_cache()
    if key in cache:
        return {"cached": True, "data": cache[key]}
    resp = requests.post(
        ACOUSTID_URL,
        data={
            "client": ACOUSTID_KEY,
            "meta": "recordings+releasegroups+compress",
            "duration": str(duration),
            "fingerprint": fingerprint,
        },
        headers={"User-Agent": UA},
        timeout=30,
    )
    try:
        resp.raise_for_status()
    except requests.HTTPError as e:
        body = (resp.text or "")[:500]
        print(f"[identify] AcoustID HTTP {resp.status_code}: {body}", flush=True)
        raise RuntimeError(f"AcoustID rejected lookup (HTTP {resp.status_code}): {body}") from e
    data = resp.json()
    cache[key] = data
    _save_cache(cache)
    return {"cached": False, "data": data}


def pick_best(acoustid_data: dict) -> Optional[dict]:
    results = (acoustid_data or {}).get("results") or []
    with_meta = [r for r in results if r.get("score", 0) > 0 and r.get("recordings")]
    if not with_meta:
        return None
    with_meta.sort(key=lambda r: r.get("score", 0), reverse=True)
    top = with_meta[0]
    rec = top["recordings"][0]
    artists = [a.get("name", "") for a in rec.get("artists", []) if a.get("name")]
    album = ""
    if rec.get("releasegroups"):
        album = rec["releasegroups"][0].get("title", "")
    return {
        "score": top.get("score"),
        "recording_id": rec.get("id"),
        "title": rec.get("title"),
        "artist": ", ".join(artists),
        "album": album,
        "duration": rec.get("duration"),
    }


def fetch_lyrics(title: str, artist: str, song_duration: Optional[int] = None, album: str = "") -> dict:
    """LRCLib: duration here must be the full SONG duration, not the snippet."""
    params = {"artist_name": artist, "track_name": title}
    if album:
        params["album_name"] = album
    if song_duration:
        params["duration"] = str(int(song_duration))
    r = requests.get(LRCLIB_GET, params=params, headers={"User-Agent": UA}, timeout=20)
    if r.status_code == 200:
        return r.json()
    # fallback: search endpoint, pick closest duration
    r2 = requests.get(
        LRCLIB_SEARCH,
        params={"track_name": title, "artist_name": artist},
        headers={"User-Agent": UA},
        timeout=20,
    )
    r2.raise_for_status()
    candidates = r2.json() or []
    if not candidates:
        return {"plainLyrics": None, "syncedLyrics": None, "instrumental": False, "not_found": True}
    if song_duration:
        candidates.sort(key=lambda c: abs((c.get("duration") or 0) - song_duration))
    return candidates[0]


@app.get("/health")
def health():
    return {
        "ok": True,
        "has_key": bool(ACOUSTID_KEY),
        "cache_entries": len(_load_cache()),
    }


@app.post("/identify")
async def identify(
    file: UploadFile = File(...),
    source: str = Query("mic", pattern="^(mic|file)$"),
):
    suffix = Path(file.filename or "audio").suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp_path = tmp.name
    print(f"[identify] upload name={file.filename} type={file.content_type} bytes={len(content)} source={source}", flush=True)
    try:
        try:
            fp_duration, fingerprint = run_fpcalc(tmp_path)
        except RuntimeError as e:
            print(f"[identify] fingerprint failed: {e}", flush=True)
            return JSONResponse(
                status_code=422,
                content={
                    "match": None,
                    "error": "fingerprint_failed",
                    "hint": (
                        "Couldn't fingerprint that audio (too short, silent, or unsupported format). "
                        f"Detail: {e}"
                    ),
                },
            )
        print(f"[identify] fp_duration={fp_duration}s fp_len={len(fingerprint)}", flush=True)
        if fp_duration < 3 or len(fingerprint) < 80:
            return JSONResponse(
                status_code=422,
                content={
                    "match": None,
                    "error": "too_short",
                    "hint": (
                        f"Only {fp_duration}s of usable audio — record at least 5-10s, "
                        "close to the speaker, in a quiet room."
                        if fp_duration >= 3 else
                        f"Only {fp_duration}s of audio — record at least 5-10s."
                    ),
                },
            )
        try:
            lookup = lookup_acoustid(fingerprint, fp_duration)
        except RuntimeError as e:
            return JSONResponse(
                status_code=502,
                content={"match": None, "error": "lookup_failed", "hint": str(e)},
            )
        best = pick_best(lookup["data"])
        if best is None:
            raw = (lookup["data"].get("results") or [])[:3]
            orphans = [
                {"track_id": r.get("id"), "score": r.get("score")}
                for r in raw if r.get("score", 0) > 0
            ]
            return {
                "match": None,
                "fp_duration": fp_duration,
                "cached": lookup["cached"],
                "orphan_tracks": orphans,
                "hint": (
                    "Fingerprint matched but cluster has no MusicBrainz metadata. "
                    if orphans else
                    "No match. Try 10-15s, closer to speaker, quiet room, mic processing off."
                ),
            }
        # anchor abstraction: full-file uploads know t=0, mic snippets don't
        if source == "file" and fp_duration >= 60:
            anchor = {"type": "t0-known", "offsetSec": 0.0}
        else:
            anchor = {"type": "unknown", "offsetSec": None}
        return {
            "match": best,
            "fp_duration": fp_duration,
            "song_duration": best.get("duration"),
            "cached": lookup["cached"],
            "anchor": anchor,
        }
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


@app.get("/lyrics")
def lyrics(
    title: str = Query(...),
    artist: str = Query(...),
    duration: Optional[int] = Query(None, description="Full song duration in seconds"),
    album: str = Query(""),
):
    return fetch_lyrics(title, artist, duration, album)
