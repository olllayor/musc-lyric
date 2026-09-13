"""CLI test for the identify pipeline (no server needed).

Usage:
  python test_acoustid.py <audiofile> [--source mic|file] [--lyrics]
  python test_acoustid.py --mic-test  # lists what to do for the speaker->mic test

The mic test protocol (de-risk step):
  1. Play a known song on speaker, record 12s with phone/QuickTime or browser.
  2. Run this script on each capture: quiet 0.5m, 2m, with background chatter.
  3. Score >= ~0.7 with correct title = usable. Anything below = pipeline problem.
"""
import argparse
import sys

sys.path.insert(0, ".")
from main import fetch_lyrics, lookup_acoustid, pick_best, run_fpcalc


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audiofile", nargs="?", help="webm/mp3/wav/m4a snippet or full song")
    ap.add_argument("--source", default="mic", choices=["mic", "file"])
    ap.add_argument("--lyrics", action="store_true", help="also fetch LRCLib lyrics")
    ap.add_argument("--mic-test", action="store_true")
    args = ap.parse_args()

    if args.mic_test or not args.audiofile:
        print(__doc__)
        return 0

    print(f"[1/3] fingerprinting {args.audiofile} ...")
    fp_duration, fp = run_fpcalc(args.audiofile)
    print(f"      fp_duration={fp_duration}s fingerprint_len={len(fp)}")

    print("[2/3] AcoustID lookup ...")
    lookup = lookup_acoustid(fp, fp_duration)
    print(f"      cached={lookup['cached']}")
    best = pick_best(lookup["data"])
    if not best:
        print("NO MATCH. Raw top results:")
        for r in (lookup["data"].get("results") or [])[:3]:
            print("  score=", r.get("score"), "id=", r.get("id"))
        return 1

    print(f"MATCH score={best['score']:.3f} :: {best['artist']} - {best['title']} [{best.get('album')}]")
    print(f"      song_duration={best.get('duration')} fp_duration={fp_duration}")
    anchor = "t0-known" if (args.source == "file" and fp_duration >= 60) else "unknown"
    print(f"      anchor={anchor} (unknown = karaoke needs manual sync in v1)")

    if args.lyrics:
        print("[3/3] LRCLib lyrics ...")
        lyr = fetch_lyrics(best["title"], best["artist"], best.get("duration"), best.get("album") or "")
        has_plain = bool(lyr.get("plainLyrics"))
        has_sync = bool(lyr.get("syncedLyrics"))
        print(f"      plain={has_plain} synced={has_sync} instrumental={lyr.get('instrumental')}")
        if has_sync:
            lines = lyr["syncedLyrics"].splitlines()
            print("      first 3 LRC lines:")
            for ln in lines[:3]:
                print("       ", ln)
        elif has_plain:
            print("      first 120 chars:", (lyr["plainLyrics"] or "")[:120])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
